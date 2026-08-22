import { prisma } from "@/lib/prisma";
import { embedTexts, embeddingConfig, embeddingHash, embeddingSourceText } from "@/lib/embeddings";
import { refreshGraph } from "@/lib/jobs/graph";

/** Textos por llamada a /api/embed. Lotes chicos: si una corrida se corta, lo ya
 *  escrito queda y la siguiente retoma (mismo patron incremental que analyze). */
const BATCH_SIZE = 16;

/** Igual que analyze: la funcion tiene maxDuration 300 y el corte se evalua entre
 *  lotes, con el margen de una llamada en vuelo. Corriendo local no hay verdugo,
 *  pero el presupuesto mantiene las corridas cortas y reanudables. */
const TIME_BUDGET_MS = 300_000 - 120_000;

type Candidate = {
  id: string;
  text: string;
  hash: string;
};

/**
 * Embebe las señales publicadas que no tengan embedding al dia y recalcula las
 * aristas del grafo semantico.
 *
 * OJO — este job NO esta en los crons de vercel.json a proposito: necesita un
 * Ollama alcanzable y ollama.com no ofrece embeddings, asi que desde Vercel no
 * hay a quien llamarle. Se corre desde la maquina de Frida (con `ollama serve`
 * arriba) via `next dev` + POST /api/jobs/embed, contra la base de Neon. Si
 * algun dia hay un host de embeddings publico, basta setear OLLAMA_EMBED_HOST
 * en Vercel y agregar el cron.
 *
 * Solo publicadas (decision de Frida, 2026-08-19): el grafo es la vista curada,
 * no el catalogo crudo. Despublicar una señal la saca del grafo en el siguiente
 * recalculo porque las aristas se rehacen completas desde el filtro published.
 */
// TODO(fase3.8): leer/escribir dentro de withOwner(ownerId, ...) y cambiar Ollama
// por OpenAI text-embedding-3-small (1536 dims, que es lo que ya declara el schema).
export async function embedPublished(ownerId: string, budgetMs: number = TIME_BUDGET_MS) {
  const startedAt = Date.now();
  const { model } = embeddingConfig();

  const published = await prisma.likedItem.findMany({
    where: { publishStatus: "published" },
    orderBy: { publishedAt: "desc" },
    select: {
      id: true,
      contentTitle: true,
      tldr: true,
      whyMatters: true,
      tweetText: true,
      embeddingHash: true,
    },
  });

  // Pendiente = sin embedding o con texto/modelo distinto al que se embebio.
  const pending: Candidate[] = [];
  for (const item of published) {
    const text = embeddingSourceText(item);
    const hash = embeddingHash(model, text);
    if (hash !== item.embeddingHash) pending.push({ id: item.id, text, hash });
  }

  let embedded = 0;
  let stoppedOnBudget = false;
  const errors: string[] = [];

  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    if (Date.now() - startedAt > budgetMs) {
      stoppedOnBudget = true;
      break;
    }
    const batch = pending.slice(i, i + BATCH_SIZE);
    try {
      const vectors = await embedTexts(batch.map((c) => c.text));
      for (let j = 0; j < batch.length; j += 1) {
        // pgvector acepta el literal '[0.1,0.2,...]'; Prisma no conoce el tipo,
        // asi que el vector viaja como texto parametrizado y castea en SQL.
        const literal = `[${vectors[j].join(",")}]`;
        await prisma.$executeRaw`
          UPDATE liked_items
          SET embedding = ${literal}::vector,
              embedding_hash = ${batch[j].hash},
              embedded_at = now()
          WHERE id = ${batch[j].id}`;
        embedded += 1;
      }
    } catch (error) {
      // Un lote que falla no tumba la corrida; esos items quedan pendientes.
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  // Todo lo derivado (aristas, temas con linaje, vitalidad, indicadores,
  // snapshot) lo rehace refreshGraph — el mismo que corre el cron diario en
  // Vercel y el PATCH de publicar. Aqui se paga solo cuando algo cambio.
  let graph: Awaited<ReturnType<typeof refreshGraph>> | undefined;
  if (errors.length === 0 || embedded > 0) {
    graph = await refreshGraph(ownerId, "embed");
  }

  return {
    ok: errors.length === 0,
    published: published.length,
    embedded,
    remaining: pending.length - embedded,
    ...(graph ? { graph } : {}),
    stoppedOnBudget,
    ...(errors.length > 0 ? { errors: errors.slice(0, 5) } : {}),
  };
}
