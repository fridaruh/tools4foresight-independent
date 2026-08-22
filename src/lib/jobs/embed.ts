/**
 * Job de embeddings por tenant (PLAN §3.8).
 *
 * Embebe las señales PUBLICADAS del tenant que no tengan embedding al día — sin
 * embedding, o con un hash distinto al del texto/modelo actual. Solo publicadas
 * (decisión de Frida, 2026-08-19): el grafo es la vista curada, no el catálogo
 * crudo.
 *
 * Forma del job (importante para no reventar transacciones):
 *
 *   1. `withOwner` CORTO para leer candidatos (solo texto, nada de vectores).
 *   2. Llamadas a OpenAI **fuera** de toda transacción — son segundos de red y
 *      una transacción abierta mientras tanto ocupa una conexión del pooler de
 *      Neon sin hacer nada.
 *   3. `withOwner` CORTO por lote para escribir los vectores con `$executeRaw`
 *      (`::vector`) y anotar el `UsageEvent`.
 *
 * Lo que este job NO hace: recalcular el grafo. Marca `graphDirtyAt` en la cuota
 * del tenant y el cron de grafo (PLAN §3.10) lo recoge. Encadenar refreshGraph
 * aquí era lo que hacía que publicar una señal costara 30 s.
 */
import { JobFn, JobResult, budgetExceeded, remainingMs } from "@/lib/jobs/types";
import {
  EMBED_BATCH_SIZE,
  PermanentEmbeddingError,
  embedBatch,
  embeddingConfig,
  embeddingHash,
  embeddingSourceText,
  toVectorLiteral,
} from "@/lib/embeddings";
import { recordUsage } from "@/lib/quota";
import { withOwner } from "@/lib/tenant-db";

/** Tope de items a embeber por corrida. Con lotes de 64 son ~4 llamadas: corto,
 *  reanudable, y el `remaining` que devuelve le dice al dispatcher que vuelva. */
const MAX_CANDIDATES = 200;

/** El "hash desactualizado" no se puede filtrar en SQL (depende de concatenar
 *  campos y hashear), así que el escaneo lee publicadas por páginas y calcula el
 *  hash en JS hasta juntar MAX_CANDIDATES pendientes. Solo se leen campos de
 *  texto: ni una columna `vector(1536)` cruza el cable. */
const SCAN_PAGE_SIZE = 500;
const MAX_SCAN = 5_000;

/** Margen antes de arrancar un lote nuevo: si no cabe una llamada a OpenAI
 *  (timeout 60 s) más la escritura, se corta y se reanuda en la próxima corrida. */
const BATCH_MARGIN_MS = 70_000;

type Candidate = { id: string; text: string; hash: string };

type ScanResult = { pending: Candidate[]; scanned: number; published: number; exhausted: boolean };

/**
 * Lee publicadas por páginas dentro de `withOwner` y devuelve las que necesitan
 * embedding. Cada página es su propia transacción corta.
 */
async function scanCandidates(ownerId: string, model: string): Promise<ScanResult> {
  const pending: Candidate[] = [];
  let scanned = 0;
  let published = 0;
  let exhausted = false;

  while (pending.length < MAX_CANDIDATES && scanned < MAX_SCAN) {
    const page = await withOwner(ownerId, (tx) =>
      tx.likedItem.findMany({
        where: { ownerId, publishStatus: "published" },
        // Orden estable y con desempate por id: sin él, dos páginas podrían
        // repetir o saltarse filas cuando varias comparten publishedAt.
        orderBy: [{ publishedAt: "desc" }, { id: "asc" }],
        skip: scanned,
        take: SCAN_PAGE_SIZE,
        select: {
          id: true,
          contentTitle: true,
          tldr: true,
          whyMatters: true,
          tweetText: true,
          embeddingHash: true,
          embeddedAt: true,
        },
      }),
    );

    if (page.length === 0) {
      exhausted = true;
      break;
    }
    scanned += page.length;
    published += page.length;

    for (const item of page) {
      const text = embeddingSourceText(item);
      const hash = embeddingHash(model, text);
      if (item.embeddedAt === null || item.embeddingHash !== hash) {
        pending.push({ id: item.id, text, hash });
        if (pending.length >= MAX_CANDIDATES) break;
      }
    }

    if (page.length < SCAN_PAGE_SIZE) {
      exhausted = true;
      break;
    }
  }

  return { pending, scanned, published, exhausted };
}

/** Escribe un lote ya embebido y anota el consumo. Una transacción corta por
 *  lote: si la corrida se corta después, lo escrito queda. */
async function persistBatch(
  ownerId: string,
  batch: Candidate[],
  vectors: number[][],
  totalTokens: number,
): Promise<void> {
  await withOwner(ownerId, async (tx) => {
    for (let i = 0; i < batch.length; i += 1) {
      await tx.$executeRaw`
        UPDATE liked_items
        SET embedding = ${toVectorLiteral(vectors[i])}::vector,
            embedding_hash = ${batch[i].hash},
            embedded_at = now()
        WHERE id = ${batch[i].id}
          AND owner_id = ${ownerId}`;
    }
    await recordUsage(tx, ownerId, "openai_embed", batch.length, totalTokens);
  });
}

/**
 * Punto de entrada del job (contrato de src/lib/jobs/types.ts).
 *
 * Devuelve `ok:false` sin tocar la base cuando falta `OPENAI_API_KEY` o el
 * modelo devuelve algo imposible: un tenant no debe quedar con embeddings a
 * medias por un problema de configuración de la plataforma.
 */
export const runEmbed: JobFn = async (ctx): Promise<JobResult> => {
  const { ownerId } = ctx;

  // Config primero: si falta la key no se abre ni una transacción.
  let model: string;
  try {
    model = embeddingConfig().model;
  } catch (error) {
    return {
      ok: false,
      processed: 0,
      remaining: 0,
      stoppedOnBudget: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const { pending, published, exhausted } = await scanCandidates(ownerId, model);

  let embedded = 0;
  let tokens = 0;
  let stoppedOnBudget = false;
  let permanentError: string | undefined;
  const errors: string[] = [];

  for (let i = 0; i < pending.length; i += EMBED_BATCH_SIZE) {
    if (budgetExceeded(ctx, BATCH_MARGIN_MS)) {
      stoppedOnBudget = true;
      break;
    }
    const batch = pending.slice(i, i + EMBED_BATCH_SIZE);
    try {
      const { vectors, totalTokens } = await embedBatch(batch.map((c) => c.text));
      await persistBatch(ownerId, batch, vectors, totalTokens);
      embedded += batch.length;
      tokens += totalTokens;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof PermanentEmbeddingError) {
        // Key mala, modelo inexistente, dimensión equivocada: los siguientes
        // lotes van a fallar igual. Se corta y se reporta.
        permanentError = message;
        break;
      }
      // Un lote que falla por red no tumba la corrida: esos items quedan
      // pendientes y entran en la siguiente.
      errors.push(message);
    }
  }

  // El grafo del tenant queda sucio solo si de verdad cambió algo. El cron de
  // grafo (PLAN §3.10) procesa nada más los tenants con graphDirtyAt != null y
  // lo vuelve a poner en null al terminar.
  if (embedded > 0) {
    await withOwner(ownerId, (tx) =>
      tx.userQuota.updateMany({ where: { userId: ownerId }, data: { graphDirtyAt: new Date() } }),
    );
  }

  // `remaining` es una COTA INFERIOR: lo que quedó de esta tanda, y un +1
  // simbólico si el escaneo se cortó por MAX_CANDIDATES (o sea, seguro hay más
  // publicadas sin mirar). El dispatcher solo necesita saber si vuelve a llamar.
  const remaining = pending.length - embedded + (exhausted ? 0 : 1);

  return {
    ok: permanentError === undefined && errors.length === 0,
    processed: embedded,
    remaining,
    stoppedOnBudget,
    ...(permanentError ? { error: permanentError } : {}),
    details: {
      published,
      candidates: pending.length,
      embedded,
      tokens,
      model,
      remainingMs: remainingMs(ctx),
      ...(errors.length > 0 ? { errors: errors.slice(0, 3) } : {}),
    },
  };
};

/**
 * Compat con `/api/jobs/embed` mientras el dispatcher de la Fase 3.11 aterriza.
 * Cuando esa ruta pase a llamar `runEmbed(ctx)` directamente, esto se borra.
 */
export async function embedPublished(ownerId: string, budgetMs = 180_000): Promise<JobResult> {
  return runEmbed({
    ownerId,
    budgetMs,
    startedAt: Date.now(),
    runId: "",
    trigger: "manual",
  });
}
