// Job de categorización (PLAN 3.4): clasifica los likes de UN tenant contra SU
// catálogo (tabla `categories`). No corre PESTEL — eso es src/lib/jobs/pestel.ts,
// que la route encadena por separado con el tiempo que sobre (PLAN 3.5).
import { loadCategories } from "@/lib/categories";
import { BATCH_SIZE, categorizeBatch, type CategorizationInput } from "@/lib/categorize";
import { budgetExceeded, type JobFn } from "@/lib/jobs/types";
import { withOwner } from "@/lib/tenant-db";

/** Lotes en vuelo al mismo tiempo. Ollama serializa por cuenta arriba de esto. */
const CONCURRENCY = 4;

/**
 * Tope de items que se leen por corrida. El corte real lo pone el budget del ctx;
 * esto solo evita traerse todo el backlog del tenant a memoria de una.
 */
const MAX_ITEMS_PER_RUN = 800;

/** Margen para no arrancar un lote que no va a alcanzar a terminar dentro del budget. */
const BUDGET_MARGIN_MS = 30_000;

export const runCategorize: JobFn = async (ctx) => {
  // Lectura corta: catálogo + backlog del tenant, todo dentro de una sola tx breve.
  // Las llamadas a Ollama (hasta 90s cada una) van DESPUÉS, fuera de withOwner — ver
  // la nota en src/lib/jobs/types.ts sobre el pooler de Neon.
  const { categories, pending } = await withOwner(ctx.ownerId, async (tx) => {
    const categories = await loadCategories(tx, ctx.ownerId);
    const pending = await tx.likedItem.findMany({
      // Se excluye lo editado a mano aunque haya quedado sin categoria: si el usuario
      // dejo un item en "Sin categorizar" a proposito, el job no debe rellenarlo.
      where: { ownerId: ctx.ownerId, category: null, categorySource: { not: "manual" } },
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
    return { categories, pending };
  });

  if (categories.length === 0) {
    return {
      ok: true,
      processed: 0,
      remaining: pending.length,
      stoppedOnBudget: false,
      error: "Sin categorías definidas",
    };
  }

  if (pending.length === 0) {
    return { ok: true, processed: 0, remaining: 0, stoppedOnBudget: false };
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
      const results = await categorizeBatch(batch, categories);

      // Escritura corta, en su propia withOwner: un solo UPDATE por lote (no una tx
      // por item) para no agotar el pool con CONCURRENCY lotes en vuelo. El
      // `owner_id` va explícito en el WHERE (cinturón y tirantes sobre RLS) y el
      // match es por (owner_id, tweet_id) — dos tenants pueden compartir tweet_id
      // si ambos dieron like al mismo tweet.
      const written = await withOwner(ctx.ownerId, (tx) => tx.$executeRaw`
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
        WHERE li.owner_id = ${ctx.ownerId}
          AND li.tweet_id = v.tweet_id
          AND li.category IS NULL
          AND li.category_source <> 'manual'
      `);
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

  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    if (budgetExceeded(ctx, BUDGET_MARGIN_MS)) {
      stoppedOnBudget = true;
      break;
    }
    await Promise.all(batches.slice(i, i + CONCURRENCY).map(runBatch));
  }

  const remaining = await withOwner(ctx.ownerId, (tx) =>
    tx.likedItem.count({ where: { ownerId: ctx.ownerId, category: null } }),
  );

  return {
    // Falla la corrida solo si ningun lote intentado logro escribir: si algunos
    // pasaron, la corrida sirvio y el resto se reintenta en la siguiente.
    ok: categorized > 0 || errors.length === 0,
    processed: attempted,
    remaining,
    stoppedOnBudget,
    details: {
      categorized,
      newCategories: [...newCategories],
      ...(errors.length > 0 ? { errors: errors.slice(0, 5) } : {}),
    },
  };
};
