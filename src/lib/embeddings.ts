// Cliente de embeddings sobre la API de OpenAI (PLAN §3.8).
//
// Por qué OpenAI y no Ollama: ollama.com no hostea ningún modelo de embeddings
// (verificado 2026-08-19), así que la versión anterior de este archivo apuntaba a
// un Ollama LOCAL y ataba el job de embeddings a la máquina de Frida. Con
// `text-embedding-3-small` el job entra al cron de Vercel como cualquier otro.
//
// La key es GLOBAL (de Frida, `OPENAI_API_KEY`), no BYOK: lo que se cobra por
// tenant se audita en `usage_events` (kind = "openai_embed") desde el job.
//
// Sin SDK a propósito: una llamada POST con `fetch` nativo, timeout explícito y
// un solo reintento. El SDK de OpenAI traería su propio manejo de reintentos y
// su propio reloj, justo lo que el presupuesto de tiempo del job quiere controlar.

import { createHash } from "crypto";

const DEFAULT_MODEL = "text-embedding-3-small";

/** El schema declara `vector(1536)`. Si algún día cambia el modelo, la dimensión
 *  tiene que seguir siendo 1536 o hay que migrar la columna. */
export const EMBED_DIMENSIONS = 1536;

/** Textos por request. 64 cabe de sobra en el límite de 300k tokens/request de
 *  OpenAI con los textos que mandamos (título + TL;DR + por qué importa). */
export const EMBED_BATCH_SIZE = 64;

/** Un lote de 64 tarda ~1-2 s; 60 s es margen para un mal día de la API sin
 *  comerse el presupuesto de la corrida. */
const EMBED_TIMEOUT_MS = 60_000;

/** Espera antes del único reintento (429 / 5xx). */
const RETRY_BACKOFF_MS = 2_000;

const ENDPOINT = "https://api.openai.com/v1/embeddings";

/** Error que no tiene sentido reintentar en esta corrida (falta la key, la key es
 *  mala, el modelo no existe, el payload es inválido). Mismo contrato que
 *  `PermanentOllamaError` en src/lib/ollama.ts. */
export class PermanentEmbeddingError extends Error {}

export type EmbeddingConfig = {
  model: string;
  dimensions: number;
  apiKey: string;
};

/**
 * Lee la configuración o lanza `PermanentEmbeddingError`.
 *
 * Lanza en vez de devolver `null` para que un job que se olvide de manejarlo
 * falle ruidosamente en vez de embeber con un modelo equivocado. El job
 * (src/lib/jobs/embed.ts) lo atrapa y devuelve `ok:false` SIN tocar la base.
 */
export function embeddingConfig(): EmbeddingConfig {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new PermanentEmbeddingError(
      "Falta OPENAI_API_KEY. Agrégala en el proyecto de Vercel (y en .env para correr local) para que el job de embeddings pueda correr.",
    );
  }
  return {
    apiKey,
    model: process.env.OPENAI_EMBED_MODEL?.trim() || DEFAULT_MODEL,
    dimensions: EMBED_DIMENSIONS,
  };
}

/** El nombre del modelo sin exigir la key: sirve para calcular hashes en una
 *  lectura de diagnóstico sin arriesgar una excepción por falta de secreto. */
export function embeddingModelName(): string {
  return process.env.OPENAI_EMBED_MODEL?.trim() || DEFAULT_MODEL;
}

/**
 * El texto que se embebe por señal: lo mismo que lee el usuario en la ficha
 * (título + TL;DR + "por qué importa"), no el tweet crudo. Una señal publicada
 * siempre trae whyMatters (lo exige src/lib/publish.ts); el fallback al texto
 * del tweet cubre datos viejos o inconsistentes sin tirar el job.
 */
export function embeddingSourceText(item: {
  contentTitle: string | null;
  tldr: string | null;
  whyMatters: string | null;
  tweetText: string;
}): string {
  const parts: string[] = [];
  if (item.contentTitle) parts.push(item.contentTitle.slice(0, 300));
  if (item.tldr) parts.push(item.tldr);
  if (item.whyMatters) parts.push(item.whyMatters);
  if (parts.length === 0) parts.push(item.tweetText.slice(0, 1500));
  return parts.join("\n");
}

/**
 * Hash de (modelo + texto) con sha256: si el usuario edita el TL;DR a mano o
 * cambia el modelo de embeddings, el hash guardado deja de coincidir y el job
 * re-embebe solo eso. El modelo va DENTRO del hash a propósito — cambiar de
 * `embeddinggemma` a `text-embedding-3-small` invalida todo el catálogo, que es
 * exactamente lo que queremos.
 */
export function embeddingHash(model: string, text: string): string {
  return createHash("sha256").update(`${model}\n${text}`).digest("hex");
}

export type EmbedBatchResult = {
  /** Un vector por texto, en el mismo orden que la entrada. */
  vectors: number[][];
  /** `usage.total_tokens` de la respuesta: lo que se le cobra al tenant. */
  totalTokens: number;
};

type OpenAIEmbeddingResponse = {
  data?: Array<{ index?: number; embedding?: number[] }>;
  usage?: { prompt_tokens?: number; total_tokens?: number };
  error?: { message?: string };
};

/**
 * UNA llamada a `/v1/embeddings` con hasta `EMBED_BATCH_SIZE` textos.
 *
 * Reintenta una sola vez ante 429 o 5xx (con backoff); un 4xx que no sea 429 es
 * `PermanentEmbeddingError` porque reintentarlo va a fallar igual. Un timeout no
 * se reintenta: volver a esperar 60 s se come el presupuesto de la corrida y
 * esos items entran en la siguiente.
 */
export async function embedBatch(texts: string[]): Promise<EmbedBatchResult> {
  if (texts.length === 0) return { vectors: [], totalTokens: 0 };
  if (texts.length > EMBED_BATCH_SIZE) {
    throw new PermanentEmbeddingError(
      `embedBatch recibió ${texts.length} textos; el máximo por llamada es ${EMBED_BATCH_SIZE}. Usa embedTexts.`,
    );
  }

  const { apiKey, model, dimensions } = embeddingConfig();

  const call = async (): Promise<EmbedBatchResult> => {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, dimensions, input: texts }),
      signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
    });

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      const message = `OpenAI respondió ${response.status} al embeber: ${detail}`;
      throw response.status >= 400 && response.status < 500 && response.status !== 429
        ? new PermanentEmbeddingError(message)
        : new Error(message);
    }

    const body = (await response.json()) as OpenAIEmbeddingResponse;
    const rows = body.data ?? [];
    if (rows.length !== texts.length) {
      throw new Error(`OpenAI devolvió ${rows.length} embeddings para ${texts.length} textos.`);
    }

    // La respuesta trae `index`; el orden no está garantizado por contrato, así
    // que reordenamos en vez de confiar en que venga alineada.
    const vectors: number[][] = new Array(texts.length);
    rows.forEach((row, position) => {
      const index = typeof row.index === "number" ? row.index : position;
      if (index < 0 || index >= texts.length || !Array.isArray(row.embedding)) {
        throw new Error(`OpenAI devolvió un embedding inválido en la posición ${position}.`);
      }
      if (row.embedding.length !== dimensions) {
        throw new PermanentEmbeddingError(
          `OpenAI devolvió un vector de ${row.embedding.length} dimensiones; la columna es vector(${dimensions}).`,
        );
      }
      vectors[index] = row.embedding;
    });
    if (vectors.some((v) => v === undefined)) {
      throw new Error("OpenAI devolvió embeddings con índices repetidos o faltantes.");
    }

    return { vectors, totalTokens: body.usage?.total_tokens ?? 0 };
  };

  try {
    return await call();
  } catch (error) {
    if (error instanceof PermanentEmbeddingError) throw error;
    if (error instanceof Error && error.name === "TimeoutError") throw error;
    await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS));
    return call();
  }
}

/**
 * Conveniencia: parte `texts` en lotes de `EMBED_BATCH_SIZE` y los concatena.
 *
 * El job de embeddings NO la usa — necesita evaluar su presupuesto de tiempo
 * entre lotes y escribir lo que ya tiene, así que llama a `embedBatch` él mismo.
 */
export async function embedTexts(texts: string[]): Promise<EmbedBatchResult> {
  const vectors: number[][] = [];
  let totalTokens = 0;
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const batch = await embedBatch(texts.slice(i, i + EMBED_BATCH_SIZE));
    vectors.push(...batch.vectors);
    totalTokens += batch.totalTokens;
  }
  return { vectors, totalTokens };
}

/** Literal que entiende pgvector: '[0.1,0.2,…]'. Prisma no conoce el tipo, así
 *  que el vector viaja como texto parametrizado y castea en SQL con `::vector`. */
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}
