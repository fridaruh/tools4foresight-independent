import { prisma } from "@/lib/prisma";
import { BATCH_SIZE, categorizeBatch, type CategorizationInput } from "@/lib/categorize";

/** Lotes en vuelo al mismo tiempo. Ollama serializa por cuenta arriba de esto. */
const CONCURRENCY = 4;

/**
 * Tope de items que se leen por corrida. El corte real lo pone TIME_BUDGET_MS; esto solo
 * evita traerse los ~4k pendientes a memoria de una.
 */
const MAX_ITEMS_PER_RUN = 800;

/**
 * La funcion tiene maxDuration 300s. El corte se evalua entre oleadas, asi que una que
 * arranca justo antes del limite puede estirarse otro REQUEST_TIMEOUT_MS (90s): 200 + 90
 * sigue cabiendo en los 300s.
 */
const TIME_BUDGET_MS = 200_000;

/**
 * @param budgetMs Cuanto tiempo puede consumir esta corrida. El default asume que es
 *   el unico trabajo de la funcion; `/api/sync` pasa menos porque antes ya corrio la
 *   ingesta y el fetch de contenido dentro de los mismos 300s.
 */
export async function categorizePending(budgetMs: number = TIME_BUDGET_MS) {
  const startedAt = Date.now();

  // Job separado de la ingesta (PLAN 3.3): asi se puede reintentar la
  // categorizacion sin volver a pedir likes a X.
  //
  // Se prioriza lo que ya tiene contenido enriquecido (fetch listo) porque
  // clasifica mejor con titulo y descripcion que solo con el texto del tweet.
  const pending = await prisma.likedItem.findMany({
    // Se excluye lo editado a mano aunque haya quedado sin categoria: si Frida
    // dejo un item en "Sin categorizar" a proposito, el job no debe rellenarlo.
    where: { category: null, categorySource: { not: "manual" } },
    orderBy: [{ fetchStatus: "asc" }, { likedAt: "desc" }],
    select: {
      tweetId: true,
      authorHandle: true,
      tweetText: true,
      contentTitle: true,
      contentDescription: true,
    },
    take: MAX_ITEMS_PER_RUN,
  });

  if (pending.length === 0) {
    return {
      ok: true as const,
      processed: 0,
      categorized: 0,
      newCategories: [] as string[],
      remaining: 0,
    };
  }

  const batches: CategorizationInput[][] = [];
  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    batches.push(pending.slice(i, i + BATCH_SIZE));
  }

  let categorized = 0;
  let attempted = 0;
  let stoppedOnBudget = false;
  const newCategories = new Set<string>();
  const errors: string[] = [];

  async function runBatch(batch: CategorizationInput[]) {
    attempted += batch.length;

    try {
      const results = await categorizeBatch(batch);

      // Un solo UPDATE por lote en vez de 20 updateMany dentro de $transaction: con
      // CONCURRENCY lotes en vuelo, abrir una transaccion por lote agota el pool de
      // conexiones de Neon y Prisma tira "Unable to start a transaction in the given time".
      //
      // El `and category is null` conserva la garantia que daba la transaccion: si Frida
      // reclasifico un item a mano mientras corria el job, su edicion gana (PLAN 3.3).
      const written = await prisma.$executeRaw`
        UPDATE liked_items AS li
        SET category = v.category,
            category_source = 'auto',
            category_confidence = v.confidence,
            category_reasoning = v.reasoning,
            categorized_at = now(),
            updated_at = now()
        FROM (
          SELECT *
          FROM unnest(
            ${results.map((r) => r.tweetId)}::text[],
            ${results.map((r) => r.category)}::text[],
            ${results.map((r) => r.confidence)}::numeric[],
            ${results.map((r) => r.reasoning)}::text[]
          ) AS t(tweet_id, category, confidence, reasoning)
        ) AS v
        WHERE li.tweet_id = v.tweet_id
          AND li.category IS NULL
          AND li.category_source <> 'manual'
      `;
      categorized += written;

      for (const result of results) {
        if (result.isNewCategory) newCategories.add(result.category);
      }
    } catch (error) {
      // Un lote que falla no debe tumbar los demas: los items siguen con
      // category = null y entran en la proxima corrida.
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  // Los lotes son independientes entre si, asi que se corren de a CONCURRENCY en vez de
  // uno por uno: secuencial, los ~4k items pendientes tardarian mas de una hora.
  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    if (Date.now() - startedAt > budgetMs) {
      stoppedOnBudget = true;
      break;
    }
    await Promise.all(batches.slice(i, i + CONCURRENCY).map(runBatch));
  }

  const remaining = await prisma.likedItem.count({ where: { category: null } });

  return {
    // Falla la corrida solo si ningun lote intentado logro escribir: si algunos
    // pasaron, la corrida sirvio y el resto se reintenta en la siguiente.
    ok: categorized > 0 || errors.length === 0,
    processed: attempted,
    categorized,
    newCategories: [...newCategories],
    remaining,
    stoppedOnBudget,
    elapsedMs: Date.now() - startedAt,
    ...(errors.length > 0 ? { errors: errors.slice(0, 5) } : {}),
  };
}
