import { ollamaChat, withOneRetry } from "@/lib/ollama";
import { getAnalysisSystemPrompts, TARGET_WORDS } from "@/lib/analysis-prompts";

/**
 * Genera prosa, no una etiqueta: son dos llamadas por item (impacto primero, "por que
 * importa" despues usando el impacto como contexto) en vez de un lote como en
 * categorize.ts. Un lote de 20 respuestas de 150 palabras se trunca a media respuesta
 * y se pierde entero; item por item, lo que falla es un item.
 */
export const ANALYSIS_TIMEOUT_MS = 90_000;

export type AnalysisInput = {
  tweetText: string;
  contentTitle: string | null;
  contentDescription: string | null;
};

/**
 * El texto que ve el modelo. Un like a un articulo suele traer un tweet que es solo la
 * URL, asi que mandar `tweetText` pelado dejaria al modelo analizando un link: se le
 * agregan titulo y descripcion del contenido cuando existen.
 */
function renderSource(item: AnalysisInput): string {
  const parts = [item.tweetText.slice(0, 1500)];
  if (item.contentTitle) parts.push(`Título del enlace: ${item.contentTitle.slice(0, 300)}`);
  if (item.contentDescription) {
    parts.push(`Descripción del enlace: ${item.contentDescription.slice(0, 600)}`);
  }
  return parts.join("\n");
}

// Los system prompts viven en src/lib/analysis-prompts.ts (defaults) y en la tabla
// prompt_settings (overrides editables desde la pantalla de Sistema). Se leen en cada
// llamada: la consulta es un lookup por PK que no se nota junto a los 20-90s del
// modelo, y así una edición de Frida aplica a media corrida sin reiniciar nada.

/** TL;DR de ~100 palabras sobre lo que trata el material. Primera columna de la tabla. */
export async function generateTldr(item: AnalysisInput): Promise<string> {
  const { tldr } = await getAnalysisSystemPrompts();
  const content = await withOneRetry(() =>
    ollamaChat({
      system: tldr,
      user: `${renderSource(item)}

Escribe el TL;DR de qué trata. Máximo 100 palabras.`,
      temperature: 0.2,
      timeoutMs: ANALYSIS_TIMEOUT_MS,
    }),
  );
  return content.trim();
}

/**
 * La pregunta es de Frida, literal: es el criterio con el que quiere leer sus likes, no
 * una parafrasis nuestra. Si se reescribe, cambia el corpus de respuestas ya generadas.
 */
export async function generateImpact(item: AnalysisInput): Promise<string> {
  const { impact } = await getAnalysisSystemPrompts();
  const content = await withOneRetry(() =>
    ollamaChat({
      system: impact,
      user: `${renderSource(item)}

¿Esto qué impacto tiene al desarrollo de la Inteligencia Artificial, la manera en la que se mueve la política de los países, el poder geopolítico o la manera en la que interactuamos los seres humanos con otros o nos autopercibimos? Responde en ${TARGET_WORDS} palabras.`,
      temperature: 0.2,
      timeoutMs: ANALYSIS_TIMEOUT_MS,
    }),
  );
  return content.trim();
}

export async function generateWhyMatters(item: AnalysisInput, impact: string): Promise<string> {
  const { whyMatters } = await getAnalysisSystemPrompts();
  const content = await withOneRetry(() =>
    ollamaChat({
      system: whyMatters,
      user: `Tweet:
${renderSource(item)}

Análisis de impacto que ya escribiste:
${impact}

¿Por qué importa?`,
      temperature: 0.2,
      timeoutMs: ANALYSIS_TIMEOUT_MS,
    }),
  );
  return content.trim();
}
