/**
 * `runJob`: el único camino para correr una etapa del pipeline (PLAN §3.1).
 *
 * Hace tres cosas y ninguna más:
 *   1. abre la fila de `job_runs` (status `running`) con el owner puesto,
 *   2. arma el `JobContext` y llama a `JOBS[name]`,
 *   3. cierra la fila con el resultado — también cuando el job explota.
 *
 * El job en sí no sabe de `job_runs`: recibe `runId` por si quiere anotarse
 * algo, pero quien escribe el estado es esto. Así ninguna corrida puede quedar
 * en `running` para siempre por un `throw` en medio.
 *
 * Todo lo que toca la DB pasa por `withOwner`: `job_runs` es tabla de tenant y
 * tiene RLS. Ojo con el alcance de las transacciones: la de crear la fila y la
 * de cerrarla son CORTAS y separadas de la del job. Si abarcaran la corrida
 * entera, un job de 4 minutos tendría una transacción de 4 minutos abierta
 * contra el pooler de Neon (§7.4 del plan).
 */
import { withOwner } from "@/lib/tenant-db";
import { JOBS } from "@/lib/jobs/registry";
import { sendAdminAlert } from "@/lib/alerts";
import type { JobContext, JobName, JobResult } from "@/lib/jobs/types";

/**
 * Presupuesto por defecto de cada job, en ms.
 *
 * Todas las rutas `/api/jobs/<job>/run` declaran `maxDuration = 300` (es una
 * sola ruta dinámica, no se puede declarar 120 solo para ingest), así que el
 * corte real lo pone este presupuesto:
 *   - ingest: 100 s — varias páginas de X más el refresh de token; más allá de
 *     eso no hay nada que ganar, la cuota de páginas ya cortó.
 *   - fetch: 50 s — 15 URLs con timeout corto; si no alcanzó, el cron siguiente
 *     levanta el resto.
 *   - resto: 240 s — deja 60 s de margen sobre los 300 de la función.
 */
const DEFAULT_BUDGET_MS: Record<JobName, number> = {
  ingest: 100_000,
  fetch: 50_000,
  categorize: 240_000,
  analyze: 240_000,
  embed: 240_000,
  graph: 240_000,
  tags: 240_000,
};

export function defaultBudgetMs(name: JobName): number {
  return DEFAULT_BUDGET_MS[name];
}

export type RunJobOptions = {
  trigger: JobContext["trigger"];
  /** Si no se pasa, el default de la tabla de arriba. */
  budgetMs?: number;
};

export type RunJobOutcome = JobResult & {
  job: JobName;
  runId: string;
  /** Cuánto tardó de verdad, para poder repartir presupuesto en cadenas (/api/sync). */
  elapsedMs: number;
};

/** `job_runs.status` a partir del resultado. Ver PLAN §2 (JobRun). */
function statusFor(result: JobResult): "ok" | "error" | "budget" {
  if (!result.ok) return "error";
  if (result.stoppedOnBudget) return "budget";
  return "ok";
}

/**
 * Corre `name` para `ownerId` y deja la corrida registrada en `job_runs`.
 *
 * Nunca lanza: un fallo del job se devuelve como `{ ok: false, error }` y queda
 * escrito en la fila. El caller (dispatcher, /api/sync, botón de la UI) decide
 * qué hacer con eso, pero nunca se queda sin respuesta.
 */
export async function runJob(
  name: JobName,
  ownerId: string,
  opts: RunJobOptions,
): Promise<RunJobOutcome> {
  const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS[name];
  const startedAt = Date.now();

  const run = await withOwner(ownerId, (tx) =>
    tx.jobRun.create({
      data: { ownerId, job: name, status: "running", startedAt: new Date() },
      select: { id: true },
    }),
  );

  const ctx: JobContext = {
    ownerId,
    budgetMs,
    startedAt,
    runId: run.id,
    trigger: opts.trigger,
  };

  let result: JobResult;
  try {
    result = await JOBS[name](ctx);
  } catch (error) {
    result = {
      ok: false,
      processed: 0,
      remaining: 0,
      stoppedOnBudget: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  // El cierre va en su propio try: si la DB falla justo aquí (timeout del pool,
  // conexión caída) preferimos devolver el resultado del job —que puede haber
  // hecho todo su trabajo— a perderlo por no poder anotarlo.
  try {
    await withOwner(ownerId, (tx) =>
      tx.jobRun.update({
        where: { id: run.id },
        data: {
          status: statusFor(result),
          finishedAt: new Date(),
          processed: result.processed,
          remaining: result.remaining,
          error: result.error ?? null,
        },
      }),
    );
  } catch (error) {
    console.error(`[runner] no se pudo cerrar job_run ${run.id} (${name}):`, error);
  }

  if (statusFor(result) === "error") {
    // No debe poder tumbar la corrida ni retrasar la respuesta al caller por un
    // problema de email: se dispara y se loguea aparte.
    await alertOnConsecutiveFailures(ownerId, name).catch((error) => {
      console.error(`[runner] no se pudo evaluar fallas consecutivas de ${name} para ${ownerId}:`, error);
    });
  }

  return { ...result, job: name, runId: run.id, elapsedMs: Date.now() - startedAt };
}

/** Cuántas corridas seguidas en error del mismo job/tenant disparan la alerta (PLAN 5.2b). */
const CONSECUTIVE_FAILURES_THRESHOLD = 5;

/**
 * Si las últimas `CONSECUTIVE_FAILURES_THRESHOLD` corridas de `job` para
 * `ownerId` son todas `error`, avisa a Frida. Dedupe de `sendAdminAlert` por
 * `job`+`ownerId`: no vuelve a mandar el mismo aviso mientras el tenant siga
 * fallando dentro de la ventana de 24 h, aunque cada corrida nueva siga
 * cumpliendo la condición.
 */
async function alertOnConsecutiveFailures(ownerId: string, job: JobName): Promise<void> {
  const { lastRuns, email } = await withOwner(ownerId, async (tx) => {
    const [lastRuns, user] = await Promise.all([
      tx.jobRun.findMany({
        where: { ownerId, job },
        orderBy: { startedAt: "desc" },
        take: CONSECUTIVE_FAILURES_THRESHOLD,
        select: { status: true },
      }),
      tx.user.findFirst({ where: { id: ownerId }, select: { email: true } }),
    ]);
    return { lastRuns, email: user?.email ?? ownerId };
  });

  const allFailed =
    lastRuns.length === CONSECUTIVE_FAILURES_THRESHOLD && lastRuns.every((r) => r.status === "error");
  if (!allFailed) return;

  await sendAdminAlert(
    `job_failures:${job}:${ownerId}`,
    `Tenant ${email} lleva ${CONSECUTIVE_FAILURES_THRESHOLD} corridas fallidas de ${job}`,
    `Las últimas ${CONSECUTIVE_FAILURES_THRESHOLD} corridas del job "${job}" para el tenant ${email} (${ownerId}) terminaron en error. Revisa /admin y los últimos JobRun en su /conexion.`,
  );
}

// ---------------------------------------------------------------------------
// Cooldowns de las acciones manuales
// ---------------------------------------------------------------------------

/** Las dos columnas de `user_quotas` que sirven de antirrebote (PLAN 3.10/3.12). */
export type CooldownField = "lastManualSyncAt" | "lastGraphRefreshAt";

export type CooldownClaim =
  | { ok: true }
  | { ok: false; retryAt: Date; waitSeconds: number };

/**
 * Intenta "tomar" un cooldown: si pasaron más de `windowMs` desde la última
 * vez, lo marca ahora y devuelve ok; si no, dice cuándo se puede volver.
 *
 * Es un `updateMany` condicionado, no un read-then-write: dos clicks
 * simultáneos del mismo usuario no pueden pasar los dos, porque solo uno
 * encuentra la fila con el valor viejo. Mismo patrón que `reserveQuota`.
 *
 * No es una cuota (eso es quota.ts, y se resetea a diario): esto solo evita que
 * un botón dispare N pipelines encimados.
 */
export async function claimCooldown(
  ownerId: string,
  field: CooldownField,
  windowMs: number,
): Promise<CooldownClaim> {
  const now = new Date();
  const threshold = new Date(now.getTime() - windowMs);

  const claimed = await withOwner(ownerId, (tx) =>
    tx.userQuota.updateMany({
      where: {
        userId: ownerId,
        OR: [{ [field]: null }, { [field]: { lt: threshold } }],
      },
      data: { [field]: now },
    }),
  );

  if (claimed.count > 0) return { ok: true };

  const current = await withOwner(ownerId, (tx) =>
    tx.userQuota.findUnique({ where: { userId: ownerId }, select: { [field]: true } }),
  );

  // Sin fila de cuota no hay nada que respetar; el tenant está a medio sembrar.
  const last = (current as Record<string, Date | null> | null)?.[field] ?? null;
  if (!last) return { ok: true };

  const retryAt = new Date(last.getTime() + windowMs);
  return {
    ok: false,
    retryAt,
    waitSeconds: Math.max(0, Math.ceil((retryAt.getTime() - now.getTime()) / 1000)),
  };
}
