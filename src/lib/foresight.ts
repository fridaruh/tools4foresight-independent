import Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClient, markAnthropicKeyInvalid, recordAnthropicUsage } from "@/lib/anthropic-client";
import { ANALYSIS_TIMEOUT_MS } from "@/lib/analyze";

/**
 * Foresight: la unica columna del analisis que corre en Claude en vez de Ollama —
 * pedido de Frida (2026-08-17). Desde PLAN 3.7 usa BYOK: cada tenant trae su propia
 * key Anthropic (src/lib/anthropic-client.ts) en vez de una key global de la
 * plataforma, así que el job que la llama debe filtrar antes con
 * `hasVerifiedAnthropicKey(ownerId)` — esta función asume que ya hay key.
 *
 * `betas: ["server-side-fallback-2026-07-01"]` + `fallbacks: "default"` dejan que la
 * API reintente sola en el fallback server-side de ese modelo si el clasificador de
 * seguridad declina la respuesta, en vez de que este código tenga que hacerlo.
 */
const BETAS = ["server-side-fallback-2026-07-01"] as const;

export type ForesightInput = {
  tldr: string;
  whyMatters: string;
};

/**
 * "Esto que está sucediendo" del prompt = el TL;DR más el "por qué importa" ya
 * generados, asi que este paso corre al final de la cadena del job analyze.
 *
 * @param ownerId Tenant dueño del item (y de la key BYOK a usar).
 * @param systemPrompt Prompt efectivo del tenant (default + override), resuelto por
 *   el caller UNA vez por corrida — ver src/lib/analysis-prompts.ts.
 * @returns El texto generado, o `null` si:
 *   - el tenant no tiene key Anthropic verificada (el caller debería haber evitado
 *     llegar aquí, pero por si acaso no truena);
 *   - la key resultó inválida (401): se marca `verifiedAt = null` y se devuelve null
 *     para que el item quede pendiente, no para tumbar la corrida del tenant;
 *   - Claude se niega a responder (`stop_reason: "refusal"`): el item queda
 *     pendiente para reintento manual en vez de guardar un error como si fuera texto.
 */
export async function generateForesight(
  ownerId: string,
  input: ForesightInput,
  systemPrompt: string,
): Promise<string | null> {
  const clientInfo = await getAnthropicClient(ownerId);
  if (!clientInfo) return null;
  const { client, model } = clientInfo;

  let response;
  try {
    response = await client.beta.messages.create(
      {
        model,
        // 1024, no 16000: la respuesta es un párrafo de ~100 palabras (PLAN 3.7).
        max_tokens: 1024,
        betas: [...BETAS],
        fallbacks: "default",
        // Sin cache_control: el prompt default son ~250 tokens y Claude solo cachea
        // prefijos de 512+, así que el breakpoint quedaba inerte (y ahora, con BYOK,
        // cachear entre llamadas de tenants distintos no aplica de todos modos).
        system: [{ type: "text", text: systemPrompt }],
        messages: [
          {
            role: "user",
            content: `TL;DR:\n${input.tldr}\n\nPor qué es importante:\n${input.whyMatters}`,
          },
        ],
      },
      // Mismo tope por llamada que el resto del analisis, para que el presupuesto de
      // tiempo del job siga siendo valido.
      { timeout: ANALYSIS_TIMEOUT_MS },
    );
  } catch (error) {
    if (error instanceof Anthropic.APIError && error.status === 401) {
      await markAnthropicKeyInvalid(ownerId);
      return null;
    }
    throw error;
  }

  await recordAnthropicUsage(ownerId, response.usage?.input_tokens, response.usage?.output_tokens);

  if (response.stop_reason === "refusal") {
    return null;
  }

  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();

  return text || null;
}
