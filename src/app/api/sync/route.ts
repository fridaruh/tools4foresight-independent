import { NextResponse } from "next/server";
import { requireUserApi } from "@/lib/require-user";
import { claimCooldown, runJob } from "@/lib/jobs/runner";
import { withOwner } from "@/lib/tenant-db";
import type { JobName } from "@/lib/jobs/types";
import type { RunJobOutcome } from "@/lib/jobs/runner";

export const maxDuration = 300;

/** 30 min entre corridas manuales del pipeline completo (PLAN §3.12). */
const COOLDOWN_MS = 30 * 60 * 1000;

/**
 * Reparto del presupuesto entre las cuatro etapas. Suman 280 s de los 300 de la
 * función; los 20 restantes son el margen para responder.
 *
 * `analyze` no lleva número fijo: se queda con TODO lo que sobre. Es la etapa
 * incremental por diseño (lo que no alcance lo levanta el cron), así que es la
 * única que puede absorber la variabilidad de las tres anteriores sin que el
 * usuario note nada.
 */
const TOTAL_BUDGET_MS = 280_000;
const STAGE_BUDGET_MS: Record<"ingest" | "fetch" | "categorize", number> = {
  ingest: 60_000,
  fetch: 40_000,
  categorize: 80_000,
};

/**
 * `POST /api/sync` — "Correr mi pipeline" (PLAN §3.12).
 *
 * Encadena ingest → fetch → categorize → analyze para el tenant de la sesión.
 * Es el mismo trabajo que hacen los cuatro crons, pero en una sola llamada y
 * ahora mismo, para que quien acaba de conectar su cuenta de X no tenga que
 * esperar a mañana.
 *
 * Cada etapa corre por `runJob`, así que cada una deja su fila en `job_runs`
 * igual que si la hubiera disparado el cron: `/conexion` no distingue.
 *
 * La cadena NO se corta si una etapa falla. Que Ollama esté caído no debe
 * impedir que los likes queden guardados, y que la ingesta se tope con el rate
 * limit de X no debe impedir categorizar lo que ya estaba pendiente. Cada
 * etapa reporta lo suyo y el resumen lo dice.
 */
export async function POST() {
  const user = await requireUserApi();
  if (user instanceof NextResponse) return user;

  const cooldown = await claimCooldown(user.userId, "lastManualSyncAt", COOLDOWN_MS);
  if (!cooldown.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: `Ya corriste tu pipeline hace poco. Puedes volver a intentarlo en ${Math.ceil(cooldown.waitSeconds / 60)} min.`,
        retryAt: cooldown.retryAt,
      },
      { status: 429 },
    );
  }

  const startedAt = Date.now();
  /** Lo que queda del presupuesto total, nunca menos de 0. */
  const leftMs = () => Math.max(0, TOTAL_BUDGET_MS - (Date.now() - startedAt));

  const stages: Partial<Record<JobName, RunJobOutcome>> = {};

  const runStage = async (name: JobName, budgetMs: number) => {
    if (budgetMs <= 0) return;
    stages[name] = await runJob(name, user.userId, { trigger: "chain", budgetMs });
  };

  // Una etapa nunca puede pedir más de lo que queda del total: si la ingesta se
  // comió 90 s de sus 60 (una página lenta de X), fetch arranca ya recortado.
  await runStage("ingest", Math.min(STAGE_BUDGET_MS.ingest, leftMs()));
  await runStage("fetch", Math.min(STAGE_BUDGET_MS.fetch, leftMs()));
  await runStage("categorize", Math.min(STAGE_BUDGET_MS.categorize, leftMs()));
  await runStage("analyze", leftMs());

  const processed = Object.values(stages).reduce((sum, s) => sum + (s?.processed ?? 0), 0);

  // Si el pipeline movió algo, el grafo del tenant quedó desactualizado. No se
  // recalcula aquí (son otros 2 minutos y el usuario está esperando): se marca
  // y lo levanta el cron de grafo, o el botón de "recalcular ahora".
  if (processed > 0) {
    await withOwner(user.userId, (tx) =>
      tx.userQuota.updateMany({
        where: { userId: user.userId },
        data: { graphDirtyAt: new Date() },
      }),
    );
  }

  return NextResponse.json({
    ok: true,
    processed,
    elapsedMs: Date.now() - startedAt,
    graphDirty: processed > 0,
    summary: summarize(stages),
    stages,
  });
}

/** Etiqueta de lo que cuenta `processed` en cada etapa. */
const STAGE_LABEL: Record<string, string> = {
  ingest: "likes",
  fetch: "links",
  categorize: "categorizados",
  analyze: "analizados",
};

/**
 * Una línea para poner junto al botón:
 * `+3 likes · 5 links · 12 categorizados · faltan 41 por analizar`.
 *
 * Las etapas que no movieron nada se omiten en vez de reportar ceros; los
 * errores van al final, porque una etapa caída no invalida lo que sí avanzó.
 */
function summarize(stages: Partial<Record<JobName, RunJobOutcome>>): string {
  const parts: string[] = [];

  for (const [name, outcome] of Object.entries(stages)) {
    if (outcome && outcome.processed > 0) {
      parts.push(`${outcome.processed} ${STAGE_LABEL[name] ?? name}`);
    }
  }

  const pending: string[] = [];
  if (stages.categorize?.remaining) pending.push(`${stages.categorize.remaining} por categorizar`);
  if (stages.analyze?.remaining) pending.push(`${stages.analyze.remaining} por analizar`);
  if (pending.length > 0) parts.push(`faltan ${pending.join(" y ")}`);

  const errors = Object.values(stages)
    .filter((s) => s && !s.ok && s.error)
    .map((s) => s!.error as string);

  if (parts.length === 0) return errors[0] ?? "Ya estabas al día";
  return errors.length > 0 ? `${parts.join(" · ")} · ${errors[0]}` : parts.join(" · ");
}
