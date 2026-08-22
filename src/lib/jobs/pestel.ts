import { prisma } from "@/lib/prisma";
import { PESTEL_BATCH_SIZE, pestelClassifyBatch, type PestelClassifyInput } from "@/lib/pestel-classify";

/**
 * Solo se clasifican los likes de las ultimas 2 semanas (decision de Frida,
 * 2026-08-09): el histórico se queda como esta, "manual" por la migración que
 * agregó pestel_source. Evita gastarle miles de llamadas al modelo a ~4k items
 * que nadie pidió reclasificar.
 */
const WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

const CONCURRENCY = 4;
const MAX_ITEMS_PER_RUN = 400;
const TIME_BUDGET_MS = 200_000;

type PendingItem = PestelClassifyInput;

export async function classifyPestelPending(budgetMs: number = TIME_BUDGET_MS) {
  const startedAt = Date.now();
  const since = new Date(Date.now() - WINDOW_MS);

  const pending = await prisma.likedItem.findMany({
    where: {
      likedAt: { gte: since },
      pestel: { equals: [] },
      pestelSource: { not: "manual" },
    },
    orderBy: [{ likedAt: "desc" }],
    select: { tweetId: true, tweetText: true, contentTitle: true, contentDescription: true },
    take: MAX_ITEMS_PER_RUN,
  });

  if (pending.length === 0) {
    return { ok: true as const, processed: 0, classified: 0, remaining: 0 };
  }

  const batches: PendingItem[][] = [];
  for (let i = 0; i < pending.length; i += PESTEL_BATCH_SIZE) {
    batches.push(pending.slice(i, i + PESTEL_BATCH_SIZE));
  }

  let classified = 0;
  let attempted = 0;
  let stoppedOnBudget = false;
  const errors: string[] = [];

  async function runBatch(batch: PendingItem[]) {
    attempted += batch.length;
    try {
      const results = await pestelClassifyBatch(batch);
      const writes = await Promise.all(
        results.map((result) =>
          prisma.likedItem.updateMany({
            // El guard repite la condicion de la consulta: si Frida edito el item a
            // mano mientras corria el job, su edicion gana.
            where: { tweetId: result.tweetId, pestel: { equals: [] }, pestelSource: { not: "manual" } },
            data: { pestel: result.pestel, pestelSource: "auto" },
          }),
        ),
      );
      classified += writes.filter((w) => w.count > 0).length;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    if (Date.now() - startedAt > budgetMs) {
      stoppedOnBudget = true;
      break;
    }
    await Promise.all(batches.slice(i, i + CONCURRENCY).map(runBatch));
  }

  const remaining = await prisma.likedItem.count({
    where: { likedAt: { gte: since }, pestel: { equals: [] }, pestelSource: { not: "manual" } },
  });

  return {
    ok: classified > 0 || errors.length === 0,
    processed: attempted,
    classified,
    remaining,
    stoppedOnBudget,
    elapsedMs: Date.now() - startedAt,
    ...(errors.length > 0 ? { errors: errors.slice(0, 5) } : {}),
  };
}
