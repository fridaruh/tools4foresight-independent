// Contrato común de los jobs del pipeline (PLAN §3.1).
//
// Todo job corre para UN tenant. Recibe el owner, un presupuesto de tiempo y el
// id de la fila `job_runs` que lo registra; devuelve cuánto procesó y cuánto
// queda. El dispatcher (api/jobs/<job>/route.ts) es quien enumera tenants y
// llama a `…/run?owner=` por cada uno; el job nunca decide por sí mismo sobre
// qué tenant trabaja.
//
// Regla dura: cualquier lectura/escritura a tablas tenant dentro del job va en
// `withOwner(ctx.ownerId, tx => …)` o vía `tenantClient(ctx.ownerId)`. Fuera de
// eso, RLS devuelve 0 filas (ver src/lib/tenant-db.ts).

export type JobName =
  | "ingest"
  | "fetch"
  | "categorize"
  | "analyze"
  | "embed"
  | "graph";

export const JOB_NAMES: readonly JobName[] = [
  "ingest",
  "fetch",
  "categorize",
  "analyze",
  "embed",
  "graph",
] as const;

export type JobContext = {
  ownerId: string;
  /** Milisegundos disponibles para esta corrida; el job debe cortar antes. */
  budgetMs: number;
  /** Instante de arranque (Date.now()) para calcular lo que queda. */
  startedAt: number;
  /** Fila en job_runs que registra esta corrida. */
  runId: string;
  /** Quién disparó: cron (dispatcher), manual (botón del usuario) o cadena (sync). */
  trigger: "cron" | "manual" | "chain";
};

export type JobResult = {
  ok: boolean;
  processed: number;
  remaining: number;
  stoppedOnBudget: boolean;
  /** Cuota agotada (X páginas, análisis/día). Distinto de presupuesto de tiempo. */
  stoppedOnQuota?: boolean;
  error?: string;
  /** Datos extra que cada job quiera devolver (conteos por etapa, etc.). */
  details?: Record<string, unknown>;
};

export type JobFn = (ctx: JobContext) => Promise<JobResult>;

export function remainingMs(ctx: JobContext): number {
  return ctx.budgetMs - (Date.now() - ctx.startedAt);
}

export function budgetExceeded(ctx: JobContext, marginMs = 0): boolean {
  return remainingMs(ctx) <= marginMs;
}
