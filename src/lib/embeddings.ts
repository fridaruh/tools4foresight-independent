// Cliente de embeddings sobre el /api/embed de Ollama.
//
// A diferencia de la categorizacion y el analisis (que van a ollama.com), los
// embeddings NO pueden ir al cloud: ollama.com no hostea ningun modelo de
// embeddings (verificado 2026-08-19 — su /api/embed responde "unauthorized" con
// cualquier modelo y el catalogo cloud de embeddings esta vacio). Por eso este
// cliente apunta por defecto al Ollama local (http://127.0.0.1:11434) y el job
// que lo usa (src/lib/jobs/embed.ts) se corre desde la maquina de Frida contra
// la base de Neon, no desde un cron de Vercel — ver el comentario del job.

import { createHash } from "crypto";

const DEFAULT_EMBED_HOST = "http://127.0.0.1:11434";
const DEFAULT_EMBED_MODEL = "embeddinggemma";

/** Un lote entero de 16 textos tarda segundos en un M2; el margen es para el
 *  arranque en frio del modelo (primera llamada tras `ollama serve`). */
const EMBED_TIMEOUT_MS = 120_000;

export function embeddingConfig() {
  return {
    host: (process.env.OLLAMA_EMBED_HOST ?? DEFAULT_EMBED_HOST).replace(/\/+$/, ""),
    model: process.env.OLLAMA_EMBED_MODEL ?? DEFAULT_EMBED_MODEL,
    // Un Ollama local no pide auth; queda el hueco por si algun dia el host es remoto.
    apiKey: process.env.OLLAMA_EMBED_API_KEY,
  };
}

/**
 * El texto que se embebe por señal: lo mismo que lee un miembro en la ficha
 * (titulo + TL;DR + "por que importa"), no el tweet crudo. Una señal publicada
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
 * Hash de (modelo + texto): si Frida edita el TL;DR a mano o cambia el modelo de
 * embeddings, el hash guardado deja de coincidir y el job re-embebe solo eso.
 */
export function embeddingHash(model: string, text: string): string {
  return createHash("sha256").update(`${model}\n${text}`).digest("hex");
}

/** Un vector por texto, en el mismo orden. Lanza si el host no responde o el
 *  modelo no esta descargado (`ollama pull embeddinggemma`). */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  const { host, model, apiKey } = embeddingConfig();

  const response = await fetch(`${host}/api/embed`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({ model, input: texts }),
    signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`Ollama (${host}) respondio ${response.status} al embeber: ${detail}`);
  }

  const body = (await response.json()) as { embeddings?: number[][] };
  if (!body.embeddings || body.embeddings.length !== texts.length) {
    throw new Error(
      `Ollama devolvio ${body.embeddings?.length ?? 0} embeddings para ${texts.length} textos.`,
    );
  }
  return body.embeddings;
}
