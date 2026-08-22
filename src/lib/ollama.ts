// Capa compartida sobre /api/chat de Ollama.
//
// La usan la categorizacion (respuesta con JSON schema, por lotes) y el analisis de
// impacto (prosa, item por item). Lo que comparten es lo aburrido y facil de copiar
// mal: de donde sale la key, que errores vale la pena reintentar y como se lee la
// respuesta.

const DEFAULT_HOST = "https://ollama.com";
const DEFAULT_MODEL = "gpt-oss:120b";

/** Error que no tiene sentido reintentar dentro de la misma corrida. */
export class PermanentOllamaError extends Error {}

export function ollamaConfig() {
  const apiKey = process.env.OLLAMA_API_KEY;
  if (!apiKey) {
    throw new PermanentOllamaError(
      "Falta OLLAMA_API_KEY. Agregala en el proyecto de Vercel (y en .env para correr local) para que la categorizacion automatica pueda correr.",
    );
  }
  return {
    apiKey,
    host: (process.env.OLLAMA_HOST ?? DEFAULT_HOST).replace(/\/+$/, ""),
    model: process.env.OLLAMA_MODEL ?? DEFAULT_MODEL,
  };
}

export type ChatOptions = {
  system: string;
  user: string;
  timeoutMs: number;
  /** JSON schema para `format`. Se omite cuando se espera prosa. */
  format?: unknown;
  temperature?: number;
};

/**
 * Devuelve el contenido en crudo del mensaje del modelo.
 *
 * gpt-oss:120b razona antes de responder, pero Ollama deja ese texto en
 * `message.thinking` y no en `message.content`, asi que no hay que limpiarlo aqui.
 */
export async function ollamaChat({
  system,
  user,
  timeoutMs,
  format,
  temperature = 0,
}: ChatOptions): Promise<string> {
  const { apiKey, host, model } = ollamaConfig();

  const response = await fetch(`${host}/api/chat`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      stream: false,
      ...(format ? { format } : {}),
      options: { temperature },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    const message = `Ollama respondio ${response.status}: ${detail}`;
    // 429 sí puede pasar con reintento; el resto de los 4xx (key mala, modelo que
    // no existe, payload invalido) van a fallar igual.
    throw response.status >= 400 && response.status < 500 && response.status !== 429
      ? new PermanentOllamaError(message)
      : new Error(message);
  }

  const body = (await response.json()) as { message?: { content?: string } };
  const content = body.message?.content;
  if (!content) throw new Error("Respuesta de Ollama sin contenido.");
  return content;
}

/**
 * Reintenta una vez lo que puede ser un tropiezo pasajero (JSON truncado, 5xx, 429).
 * Un timeout no se reintenta: volver a esperar lo mismo se come el presupuesto de la
 * corrida y el item entra igual en la siguiente.
 */
export async function withOneRetry<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof PermanentOllamaError) throw error;
    if (error instanceof Error && error.name === "TimeoutError") throw error;
    return await run();
  }
}
