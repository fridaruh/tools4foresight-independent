// Job de clasificación PESTEL (PLAN 3.5): mismo patrón que categorize.ts, por tenant.
// La route (otro agente) lo encadena con el tiempo que sobre del job de categoría
// del MISMO tenant — este archivo no sabe nada de eso, solo corre su propio budget.
import { PESTEL_BATCH_SIZE, pestelClassifyBatch, type PestelClassifyInput } from "@/lib/pestel-classify";
import { budgetExceeded, type JobFn } from "@/lib/jobs/types";
import { withOwner } from "@/lib/tenant-db";

/**
 * Solo se clasifican los likes de las ultimas 2 semanas (decision de Frida,
 * 2026-08-09): el histórico se queda como esta, "manual" por la migración que
 * agregó pestel_source. Evita gastarle miles de llamadas al modelo a items que
 * nadie pidió reclasificar.
 */
const WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

const CONCURRENCY = 4;
const MAX_ITEMS_PER_RUN = 400;
const BUDGET_MARGIN_MS = 15_000;

export const runPestel: JobFn = async (ctx) => {
  const since = new Date(Date.now() - WINDOW_MS);

  const pending = await withOwner(ctx.ownerId, (tx) =>
    tx.likedItem.findMany({
      where: {
        ownerId: ctx.ownerId,
        likedAt: { gte: since },
        pestel: { equals: [] },
        pestelSource: { not: "manual" },
      },
      orderBy: [{ likedAt: "desc" }],
      select: { tweetId: true, tweetText: true, contentTitle: true, contentDescription: true },
      take: MAX_ITEMS_PER_RUN,
    }),
  );

  if (pending.length === 0) {
    return { ok: true, processed: 0, remaining: 0, stoppedOnBudget: false };
  }

  const batches: PestelClassifyInput[][] = [];
  for (let i = 0; i < pending.length; i += PESTEL_BATCH_SIZE) {
    batches.push(pending.slice(i, i + PESTEL_BATCH_SIZE));
  }

  let classified = 0;
  let attempted = 0;
  let stoppedOnBudget = false;
  const errors: string[] = [];

  async function runBatch(batch: PestelClassifyInput[]) {
    attempted += batch.length;
    try {
      const results = await pestelClassifyBatch(batch);

      // Escritura corta: los updateMany van todos dentro de la misma withOwner breve,
      // sin llamadas de red de por medio (la de Ollama ya terminó arriba).
      const writes = await withOwner(ctx.ownerId, (tx) =>
        Promise.all(
          results.map((result) =>
            tx.likedItem.updateMany({
              // El guard repite la condicion de la consulta: si el usuario edito el
              // item a mano mientras corria el job, su edicion gana.
              where: {
                ownerId: ctx.ownerId,
                tweetId: result.tweetId,
                pestel: { equals: [] },
                pestelSource: { not: "manual" },
              },
              data: { pestel: result.pestel, pestelSource: "auto" },
            }),
          ),
        ),
      );
      classified += writes.filter((w) => w.count > 0).length;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    if (budgetExceeded(ctx, BUDGET_MARGIN_MS)) {
      stoppedOnBudget = true;
      break;
    }
    await Promise.all(batches.slice(i, i + CONCURRENCY).map(runBatch));
  }

  const remaining = await withOwner(ctx.ownerId, (tx) =>
    tx.likedItem.count({
      where: {
        ownerId: ctx.ownerId,
        likedAt: { gte: since },
        pestel: { equals: [] },
        pestelSource: { not: "manual" },
      },
    }),
  );

  return {
    ok: classified > 0 || errors.length === 0,
    processed: attempted,
    remaining,
    stoppedOnBudget,
    details: { classified, ...(errors.length > 0 ? { errors: errors.slice(0, 5) } : {}) },
  };
};
