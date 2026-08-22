/**
 * El mapa nombre → función de cada job del pipeline (PLAN §3.11).
 *
 * Es el único lugar donde se resuelve "qué código corre el job `analyze`".
 * `runner.ts` no importa ningún job directamente: recibe un `JobName`, mira
 * aquí y ejecuta. Así el runner no sabe nada del pipeline y agregar una etapa
 * es agregar una línea en `JOB_NAMES` (types.ts) y otra en `JOBS`.
 *
 * Dos entradas no son un `JobFn` puro y se adaptan aquí:
 *
 *   - `ingest` envuelve `ingestLikes(ownerId)`, que es anterior al contrato y
 *     devuelve su propia forma (páginas, cursor, backfill). La traducción a
 *     `JobResult` vive en `ingestAdapter` y está documentada ahí.
 *
 *   - `categorize` corre DOS etapas del mismo tenant en una sola corrida:
 *     categoría y luego PESTEL con lo que sobre del presupuesto. Van juntas
 *     porque comparten cron, comparten botón y PESTEL trabaja sobre una ventana
 *     mucho más chica (casi nunca compite de verdad por el tiempo).
 */
import type { JobContext, JobFn, JobName, JobResult } from "@/lib/jobs/types";
import { remainingMs } from "@/lib/jobs/types";
import { withOwner } from "@/lib/tenant-db";
import { ingestLikes } from "@/lib/jobs/ingest-likes";
import { runFetch } from "@/lib/jobs/fetch-content";
import { runCategorize } from "@/lib/jobs/categorize";
import { runPestel } from "@/lib/jobs/pestel";
import { runAnalyze } from "@/lib/jobs/analyze";
import { runEmbed } from "@/lib/jobs/embed";
import { runGraph } from "@/lib/jobs/graph";
import { runTags } from "@/lib/jobs/tags";

/** Margen que se le deja a la corrida para cerrar antes de que la corten. */
const PESTEL_SAFETY_MARGIN_MS = 30_000;

/**
 * `ingestLikes` es previo al contrato de `JobFn` y devuelve tres formas
 * distintas. La traducción:
 *
 *   { status: "disabled" }            -> ok, 0 procesados. El tenant tiene el
 *                                        pipeline apagado; no es un error.
 *   { ok: true, status: "ok", ... }   -> ok, `processed` = items creados.
 *                                        `remaining` = 1 si el ciclo quedó a
 *                                        medias (hay más páginas que traer),
 *                                        0 si terminó. No hay forma barata de
 *                                        saber cuántos likes faltan de verdad.
 *   { ok: true, status: rate_limited  -> NO ok: son límites externos que hay
 *              | error_credits_...}      que ver en la UI, aunque el job no
 *                                        haya crasheado.
 *   { ok: false, ... }                -> error.
 *
 * `stoppedOnBudget` de la ingesta es cuota de páginas de X agotada, no tiempo:
 * viaja como `stoppedOnQuota`.
 */
const ingestAdapter: JobFn = async (ctx: JobContext): Promise<JobResult> => {
  const result = await ingestLikes(ctx.ownerId);

  if ("status" in result && result.status === "disabled") {
    return {
      ok: true,
      processed: 0,
      remaining: 0,
      stoppedOnBudget: false,
      details: { status: "disabled" },
    };
  }

  if ("ok" in result && result.ok === true) {
    const cycleComplete = result.backfillComplete;
    const isLimit = result.status !== "ok";
    return {
      ok: !isLimit,
      processed: result.liked_items_created,
      remaining: cycleComplete ? 0 : 1,
      stoppedOnBudget: false,
      stoppedOnQuota: result.stoppedOnBudget,
      ...(isLimit ? { error: result.error ?? result.status } : {}),
      details: {
        status: result.status,
        tweetsSeen: result.tweetsSeen,
        pagesFetched: result.pagesFetched,
        stoppedOnKnownTweet: result.stoppedOnKnownTweet,
        reachedEndOfHistory: result.reachedEndOfHistory,
        reachedWindow: result.reachedWindow,
        backfillComplete: result.backfillComplete,
      },
    };
  }

  const failed = result as { ok: false; errorType: string; error: string };
  return {
    ok: false,
    processed: 0,
    remaining: 0,
    stoppedOnBudget: false,
    error: failed.error,
    details: { status: failed.errorType },
  };
};

/**
 * Categoría + PESTEL en la misma corrida del mismo tenant.
 *
 * PESTEL recibe lo que sobre del presupuesto menos un margen de 30 s. Si no
 * sobra nada se salta sin romper: la categorización, que es lo caro y lo que
 * bloquea publicar, ya quedó hecha. Un fallo de PESTEL tampoco tumba la
 * corrida — se anota en `details.pestel` y el resultado sigue siendo el de
 * categorizar.
 */
const categorizeWithPestel: JobFn = async (ctx: JobContext): Promise<JobResult> => {
  const categorization = await runCategorize(ctx);

  const leftMs = remainingMs(ctx) - PESTEL_SAFETY_MARGIN_MS;

  let pestel: JobResult | { skipped: string };
  if (leftMs <= 0) {
    pestel = { skipped: "No quedó tiempo en esta corrida para PESTEL." };
  } else {
    try {
      // Mismo ctx pero con el presupuesto recortado a lo que queda: PESTEL debe
      // cortar por su cuenta antes de que se acabe la función entera.
      pestel = await runPestel({ ...ctx, budgetMs: leftMs, startedAt: Date.now() });
    } catch (error) {
      pestel = { skipped: (error as Error).message };
    }
  }

  return {
    ...categorization,
    details: { ...(categorization.details ?? {}), pestel },
  };
};

/**
 * `graph` + el apagado de la marca de "sucio" (PLAN §3.10).
 *
 * Publicar o despublicar un item pone `user_quotas.graph_dirty_at = now()`; el
 * dispatcher solo despacha `graph` a los tenants que la tienen puesta. Alguien
 * tiene que apagarla o el cron correría todos los días para siempre.
 *
 * El `where` compara contra el valor que se leyó ANTES de correr: si alguien
 * publicó algo mientras el grafo se recalculaba, `graph_dirty_at` cambió, el
 * updateMany afecta 0 filas y la marca sobrevive para la próxima corrida — que
 * es exactamente lo que queremos, porque ese item nuevo no entró en esta.
 */
const graphWithDebounce: JobFn = async (ctx: JobContext): Promise<JobResult> => {
  const before = await withOwner(ctx.ownerId, (tx) =>
    tx.userQuota.findUnique({
      where: { userId: ctx.ownerId },
      select: { graphDirtyAt: true },
    }),
  );

  const result = await runGraph(ctx);

  if (result.ok && before?.graphDirtyAt) {
    await withOwner(ctx.ownerId, (tx) =>
      tx.userQuota.updateMany({
        where: { userId: ctx.ownerId, graphDirtyAt: before.graphDirtyAt },
        data: { graphDirtyAt: null },
      }),
    );
  }

  return result;
};

export const JOBS: Record<JobName, JobFn> = {
  ingest: ingestAdapter,
  fetch: runFetch,
  categorize: categorizeWithPestel,
  analyze: runAnalyze,
  embed: runEmbed,
  graph: graphWithDebounce,
  tags: runTags,
};
