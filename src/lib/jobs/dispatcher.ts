/**
 * Dispatcher: de UN cron a N corridas por tenant (PLAN §3.11).
 *
 * Vercel dispara un cron por etapa (`/api/jobs/analyze`, etc.). Ese cron NO
 * hace trabajo: enumera los tenants que califican y le pega a
 * `/api/jobs/<job>/run?owner=<id>` una vez por cada uno. Cada una de esas
 * llamadas es una función distinta, con sus propios 300 s.
 *
 * Por qué no iterar tenants en serie dentro del cron: con 300 s de techo, el
 * tenant número 4 nunca correría. El principio del plan (§1.3) es que el
 * presupuesto de tiempo es POR TENANT, no por cron.
 *
 * Por qué `waitUntil` y no `await`: el dispatcher devuelve `{ dispatched }` en
 * cuanto lanza el fan-out; esperar las N respuestas lo pondría otra vez contra
 * el techo de 300 s. `waitUntil` mantiene viva la función hasta que las
 * llamadas salgan, sin que la respuesta dependa de ellas.
 *
 * Por qué hay tope de concurrencia: el plan Hobby/Pro acota funciones
 * concurrentes (§7.3) y detrás hay un pool de Neon (§7.4). `VERCEL_MAX_FANOUT`
 * (default 10) es la perilla.
 */
import { waitUntil } from "@vercel/functions";
import { withPlatformBypass } from "@/lib/tenant-db";
import { isXCreditsDepleted } from "@/lib/platform-flags";
import type { JobName } from "@/lib/jobs/types";

export type SkipReason =
  /** `user_quotas.pipeline_enabled = false`: el tenant apagó su pipeline. */
  | "pipeline_disabled"
  /** Sin `x_auth_tokens`: nunca conectó su cuenta de X, no hay nada que procesar. */
  | "x_not_connected"
  /** X respondió 429 y el cursor guarda hasta cuándo no molestarla. */
  | "x_rate_limited"
  /** Su grafo no cambió desde la última corrida (PLAN 3.10). */
  | "graph_not_dirty"
  /** Flag global: la X App compartida se quedó sin créditos. Aplica a todos. */
  | "x_credits_depleted";

export type SkippedTenant = { ownerId: string; reason: SkipReason };

export type TenantSelection = {
  eligible: string[];
  skipped: SkippedTenant[];
};

export type DispatchResult = {
  job: JobName;
  dispatched: number;
  skipped: SkippedTenant[];
};

/**
 * Qué tenants califican para `job`, y por qué se quedan fuera los demás.
 *
 * Reglas, en orden:
 *   1. `pipelineEnabled` — vale para todos los jobs.
 *   2. X conectado — vale para todos: sin `x_auth_tokens` el tenant no tiene ni
 *      va a tener señales, así que ninguna etapa tiene sentido para él.
 *   3. solo `ingest`: si el cursor trae `retryAfter` en el futuro (429 de X), se
 *      salta; y si el flag GLOBAL de créditos está prendido no se despacha nada,
 *      porque el problema es de la X App compartida, no del tenant.
 *   4. solo `graph`: `graphDirtyAt != null` — nadie publicó ni despublicó desde
 *      la última corrida, el grafo ya está al día.
 *
 * A propósito NO se calcula "trabajo pendiente" para fetch/categorize/analyze/
 * embed: contar pendientes por tenant es una query por tenant y por etapa, y el
 * job ya devuelve `processed: 0` en un par de cientos de ms cuando no hay nada.
 * Cuando el costo de las corridas vacías se note, aquí es donde se afina.
 *
 * Corre con `withPlatformBypass`: enumerar tenants es, por definición,
 * cross-tenant. Es uno de los tres usos legítimos que documenta tenant-db.ts.
 */
export async function listTenants(job: JobName): Promise<TenantSelection> {
  if (job === "ingest" && (await isXCreditsDepleted())) {
    return { eligible: [], skipped: [{ ownerId: "*", reason: "x_credits_depleted" }] };
  }

  const rows = await withPlatformBypass((tx) =>
    tx.userQuota.findMany({
      select: {
        userId: true,
        pipelineEnabled: true,
        graphDirtyAt: true,
        user: {
          select: {
            xAuthToken: { select: { id: true } },
            ingestionCursor: { select: { retryAfter: true } },
          },
        },
      },
    }),
  );

  const now = Date.now();
  const eligible: string[] = [];
  const skipped: SkippedTenant[] = [];

  for (const row of rows) {
    if (!row.pipelineEnabled) {
      skipped.push({ ownerId: row.userId, reason: "pipeline_disabled" });
      continue;
    }
    if (!row.user.xAuthToken) {
      skipped.push({ ownerId: row.userId, reason: "x_not_connected" });
      continue;
    }
    if (job === "ingest") {
      const retryAfter = row.user.ingestionCursor?.retryAfter;
      if (retryAfter && retryAfter.getTime() > now) {
        skipped.push({ ownerId: row.userId, reason: "x_rate_limited" });
        continue;
      }
    }
    if (job === "graph" && row.graphDirtyAt === null) {
      skipped.push({ ownerId: row.userId, reason: "graph_not_dirty" });
      continue;
    }
    eligible.push(row.userId);
  }

  return { eligible, skipped };
}

/** Azúcar de `listTenants(job).eligible`. Lo usa scripts/qa-dispatch.ts. */
export async function listEligibleTenants(job: JobName): Promise<string[]> {
  return (await listTenants(job)).eligible;
}

/** Tope de llamadas en vuelo del fan-out. Ver §7.3 y §7.4 del plan. */
function maxFanout(): number {
  const raw = Number(process.env.VERCEL_MAX_FANOUT ?? 10);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 10;
}

/**
 * De dónde sale la URL a la que el dispatcher se llama a sí mismo.
 *
 * `NEXT_PUBLIC_APP_URL` primero (es el dominio estable de producción),
 * `VERCEL_URL` después (el deployment actual, útil en preview), y el origen de
 * la request como último recurso — que es lo que funciona en local.
 */
export function resolveBaseUrl(request?: Request): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL;
  if (configured) return configured.replace(/\/$/, "");
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  if (request) return new URL(request.url).origin;
  throw new Error(
    "No hay base URL: define NEXT_PUBLIC_APP_URL o pasa la request al dispatcher.",
  );
}

/**
 * Lanza una corrida por tenant, como mucho `maxFanout()` en vuelo.
 *
 * No espera el trabajo: espera que la llamada SALGA. Cada `…/run` es una
 * función aparte con su propio presupuesto; lo único que este loop necesita es
 * no abrir 200 sockets de golpe. El cuerpo de la respuesta se drena para que la
 * conexión se cierre y no quede colgada.
 */
async function fanOut(job: JobName, baseUrl: string, ownerIds: string[]): Promise<void> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("[dispatcher] sin CRON_SECRET: no hay con qué autenticar el fan-out");
    return;
  }

  let next = 0;
  const workers = Array.from(
    { length: Math.min(maxFanout(), ownerIds.length) },
    async () => {
      while (next < ownerIds.length) {
        const ownerId = ownerIds[next++];
        const url = `${baseUrl}/api/jobs/${job}/run?owner=${encodeURIComponent(ownerId)}`;
        try {
          const response = await fetch(url, {
            method: "POST",
            headers: { authorization: `Bearer ${secret}` },
          });
          await response.text().catch(() => "");
          if (!response.ok) {
            console.error(`[dispatcher] ${job} owner=${ownerId} -> HTTP ${response.status}`);
          }
        } catch (error) {
          console.error(`[dispatcher] ${job} owner=${ownerId} falló:`, error);
        }
      }
    },
  );

  await Promise.all(workers);
}

/**
 * Enumera tenants y les dispara `job` a cada uno.
 *
 * Devuelve en cuanto sabe A QUIÉNES va a despachar; el fan-out sigue vivo
 * detrás gracias a `waitUntil`.
 */
export async function dispatch(job: JobName, baseUrl: string): Promise<DispatchResult> {
  const { eligible, skipped } = await listTenants(job);

  if (eligible.length > 0) {
    // Fuera de Vercel (next dev, un script) `waitUntil` no tiene contexto y es un
    // no-op: la promesa igual corre, solo que sin nadie que la espere. Por eso el
    // .catch() — una rejection sin handler tumbaría el proceso en dev.
    const running = fanOut(job, baseUrl, eligible).catch((error) => {
      console.error(`[dispatcher] fan-out de ${job} falló:`, error);
    });
    waitUntil(running);
  }

  return { job, dispatched: eligible.length, skipped };
}
