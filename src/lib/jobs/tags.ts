// Job de etiquetas por tenant: genera de 3 a 5 etiquetas descriptivas por señal
// con Ollama. Mismo patrón que src/lib/jobs/pestel.ts: lectura corta dentro de
// withOwner, la llamada al modelo fuera de toda transacción, escritura corta
// por lote.
//
// A diferencia de embed.ts y graph.ts, NO se limita a señales publicadas
// (decisión de Frida, 2026-08-23): sirve como ayuda de curación en la tabla de
// enriquecimiento, antes de decidir si algo se publica o no. Sí se salta lo
// descartado (enrichDiscarded), igual que analyze.ts.
import { TAGS_BATCH_SIZE, tagsGenerateBatch, type TagsGenerateInput } from "@/lib/tags-generate";
import { budgetExceeded, type JobFn } from "@/lib/jobs/types";
import { withOwner } from "@/lib/tenant-db";

const CONCURRENCY = 4;
const MAX_ITEMS_PER_RUN = 400;
const BUDGET_MARGIN_MS = 15_000;

const PENDING_WHERE = {
  enrichDiscarded: false,
  tags: { equals: [] as string[] },
  tagsSource: { not: "manual" },
} as const;

export const runTags: JobFn = async (ctx) => {
  const pending = await withOwner(ctx.ownerId, (tx) =>
    tx.likedItem.findMany({
      where: { ownerId: ctx.ownerId, ...PENDING_WHERE },
      orderBy: [{ likedAt: "desc" }],
      select: { tweetId: true, tweetText: true, contentTitle: true, contentDescription: true },
      take: MAX_ITEMS_PER_RUN,
    }),
  );

  if (pending.length === 0) {
    return { ok: true, processed: 0, remaining: 0, stoppedOnBudget: false };
  }

  const batches: TagsGenerateInput[][] = [];
  for (let i = 0; i < pending.length; i += TAGS_BATCH_SIZE) {
    batches.push(pending.slice(i, i + TAGS_BATCH_SIZE));
  }

  let tagged = 0;
  let attempted = 0;
  let stoppedOnBudget = false;
  const errors: string[] = [];

  async function runBatch(batch: TagsGenerateInput[]) {
    attempted += batch.length;
    try {
      const results = await tagsGenerateBatch(batch);

      // Escritura corta, sin llamadas de red de por medio (Ollama ya terminó arriba).
      const writes = await withOwner(ctx.ownerId, (tx) =>
        Promise.all(
          results.map((result) =>
            tx.likedItem.updateMany({
              // El guard repite la condición de la consulta: si el usuario editó las
              // etiquetas a mano mientras corría el job, su edición gana.
              where: { ownerId: ctx.ownerId, tweetId: result.tweetId, ...PENDING_WHERE },
              data: { tags: result.tags, tagsSource: "auto", tagsGeneratedAt: new Date() },
            }),
          ),
        ),
      );
      tagged += writes.filter((w) => w.count > 0).length;
    } catch (error) {
      // Un lote que falla no tumba los demás: esos items quedan pendientes y
      // entran en la próxima corrida.
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
    tx.likedItem.count({ where: { ownerId: ctx.ownerId, ...PENDING_WHERE } }),
  );

  return {
    ok: tagged > 0 || errors.length === 0,
    processed: attempted,
    remaining,
    stoppedOnBudget,
    details: { tagged, ...(errors.length > 0 ? { errors: errors.slice(0, 5) } : {}) },
  };
};
