import Anthropic from "@anthropic-ai/sdk";
import { getAnalysisSystemPrompts } from "@/lib/analysis-prompts";
import { ANALYSIS_TIMEOUT_MS } from "@/lib/analyze";

/**
 * Foresight: la unica columna del analisis que corre en Claude (claude-opus-5) en vez
 * de Ollama — pedido de Frida (2026-08-17), junto con usar el cache de prompts.
 *
 * El system prompt (fijo entre llamadas) lleva el breakpoint de cache_control y lo
 * variable (TL;DR + "por que importa" de cada item) va en el mensaje de usuario,
 * despues del prefijo, para no invalidarlo. Ojo: claude-opus-5 solo cachea prefijos
 * de 512+ tokens, asi que con el prompt default (~250 tokens) el breakpoint queda
 * inerte; si el prompt crece desde la pantalla de Sistema, empieza a cachear solo.
 */
const MODEL = "claude-opus-5";

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "Falta ANTHROPIC_API_KEY. Agregala en el proyecto de Vercel (y en .env para correr local) para que la columna Foresight pueda generarse.",
    );
  }
  client ??= new Anthropic();
  return client;
}

export type ForesightInput = {
  tldr: string;
  whyMatters: string;
};

/**
 * "Esto que está sucediendo" del prompt = el TL;DR más el "por qué importa" ya
 * generados, asi que este paso corre al final de la cadena del job analyze.
 */
export async function generateForesight(input: ForesightInput): Promise<string> {
  const { foresight } = await getAnalysisSystemPrompts();

  const response = await getClient().beta.messages.create(
    {
      model: MODEL,
      max_tokens: 16000,
      // Si los clasificadores de seguridad declinan el item, el API lo reintenta
      // server-side en Opus 4.8 dentro de la misma llamada.
      betas: ["server-side-fallback-2026-06-01"],
      fallbacks: [{ model: "claude-opus-4-8" }],
      system: [
        {
          type: "text",
          text: foresight,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [
        {
          role: "user",
          content: `TL;DR:\n${input.tldr}\n\nPor qué es importante:\n${input.whyMatters}`,
        },
      ],
    },
    // Mismo tope por llamada que el resto del analisis, para que el presupuesto de
    // tiempo del job (TIME_BUDGET_MS) siga siendo valido.
    { timeout: ANALYSIS_TIMEOUT_MS },
  );

  if (response.stop_reason === "refusal") {
    throw new Error("Claude declinó generar el foresight de este item");
  }

  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();

  if (!text) throw new Error("Respuesta vacía del modelo de foresight");
  return text;
}
