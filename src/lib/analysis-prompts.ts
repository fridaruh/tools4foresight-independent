import type { TenantTx } from "@/lib/tenant-db";

/**
 * System prompts del análisis, editables desde la pantalla de Sistema.
 *
 * Los defaults viven aquí (movidos de analyze.ts) para que el generador y la UI
 * compartan una sola fuente. La tabla prompt_settings guarda solo los overrides,
 * uno por tenant: sin fila (o con texto en blanco) rige el default, así "restaurar"
 * es borrar la fila y un default mejorado en el código llega solo a quien no
 * personalizó.
 *
 * Fase 3 (PLAN 3.6): `getAnalysisSystemPrompts` recibe `tx`/`ownerId` en vez de leer
 * `prisma` global sin filtrar — sin ownerId, dos tenants leerían los overrides del
 * otro. El job de análisis la llama UNA vez por corrida (no por item) y pasa el
 * resultado a cada llamada de generación.
 */

/** Cuantas palabras pidio Frida por respuesta. Va literal a los dos prompts. */
export const TARGET_WORDS = 150;

// El limite de palabras se repite arriba y abajo del prompt a proposito: pedido una
// sola vez, gpt-oss:120b se pasaba sistematicamente (160-205 palabras en la prueba
// sobre items reales).
export const DEFAULT_IMPACT_SYSTEM = `Eres analista de foresight. Te dan un tweet que una persona guardó en sus likes y respondes qué impacto tiene.

Reglas:
- Responde en español, en prosa corrida, sin encabezados ni viñetas ni markdown.
- LÍMITE DURO: máximo ${TARGET_WORDS} palabras. Cuéntalas. Es preferible quedarte en 130 que pasarte.
- Escribe solo la respuesta, sin preámbulo del tipo "Este tweet...".
- Si el material no alcanza para juzgar el impacto, dilo en una frase en vez de inventar.`;

// Este prompt sí es nuestro (Frida pidió "haz un prompt que ayude a responder esa
// pregunta"). Las dos prohibiciones de abajo salieron de la prueba: sin ellas, 3 de
// cada 4 respuestas abrían con "Porque ese like revela que ya estás..." y le atribuían
// a Frida intenciones que el tweet no sostiene.
export const DEFAULT_WHY_MATTERS_SYSTEM = `Eres analista de foresight. Ya escribiste el análisis de impacto de un tweet que una persona guardó en sus likes. Ahora respondes por qué importa.

Reglas:
- Responde en español, en prosa corrida, sin encabezados ni viñetas ni markdown.
- LÍMITE DURO: máximo 120 palabras. Cuéntalas.
- No repitas el análisis de impacto: parte de él y responde qué cambia, a quién afecta y qué habría que vigilar.
- Escribe sobre el tema, no sobre quien guardó el like: nada de "tú", "tu rutina" ni suposiciones sobre esa persona.
- No empieces con "Porque" ni con "Este tweet". Entra directo al asunto.
- Si el análisis de impacto dice que no hay material suficiente para juzgar, no inventes uno: responde en una frase que el like no da contexto para saber por qué importa. Sin esta regla, 21 de 600 items contestaban con un análisis completo sobre un tweet que era un link pelado.`;

// El TL;DR resume de qué trata el material, sin evaluarlo: el juicio ya vive en
// impacto y "por qué importa", y duplicarlo aquí haría las tres columnas redundantes.
export const DEFAULT_TLDR_SYSTEM = `Eres analista de foresight. Te dan un tweet que una persona guardó en sus likes (a veces con el título y la descripción del enlace que trae) y escribes un TL;DR de qué trata.

Reglas:
- Responde en español, en prosa corrida, sin encabezados ni viñetas ni markdown.
- LÍMITE DURO: máximo 100 palabras. Cuéntalas. Es preferible quedarte en 80 que pasarte.
- Resume el contenido: qué se anuncia, qué se afirma, qué pasó. No evalúes impacto ni importancia — eso va en otras columnas.
- Escribe solo el resumen, sin preámbulo del tipo "Este tweet trata de...". Entra directo al asunto.
- Si el material es solo un link sin texto ni título, dilo en una frase en vez de inventar de qué trata.`;

// El prompt es de Frida, literal (2026-08-17), igual que la pregunta de impacto: es su
// criterio de foresight, no una parafrasis nuestra. A diferencia de las otras columnas,
// este corre en Claude (claude-opus-5) y no en Ollama — ver src/lib/foresight.ts.
// Las reglas de abajo se agregaron el mismo dia: sin ellas, las respuestas abrian
// evaluando la pregunta ("Sí, puede marcar un punto de inflexión...") en vez de entrar
// directo al cambio.
export const DEFAULT_FORESIGHT_SYSTEM = `Eres analista de foresight.De acuerdo a esto que está sucediendo cómo consideras que esto pueda cambiar el desarrollo de la Inteligencia Artificial y la interacción entre seres humanos? Consideras que esto pueda traer un cambio grande? Solo responde en un parráfo en español LÍMITE DURO: máximo 100 palabras. Cuéntalas. Es preferible quedarte en 80 que pasarte.

Reglas:
- No empieces respondiendo "Sí" ni "No", ni evaluando la pregunta ("Sí, puede marcar un punto de inflexión"). Entra directo al cambio: arranca describiéndolo, por ejemplo "Esto puede...".
- No repitas la pregunta ni uses preámbulos; que el cambio sea grande o no debe quedar implícito en lo que describes.`;

export const PROMPT_KEYS = ["tldr", "impact", "why_matters", "foresight"] as const;
export type PromptKey = (typeof PROMPT_KEYS)[number];

export function isPromptKey(value: unknown): value is PromptKey {
  return typeof value === "string" && (PROMPT_KEYS as readonly string[]).includes(value);
}

export const PROMPT_DEFAULTS: Record<PromptKey, string> = {
  tldr: DEFAULT_TLDR_SYSTEM,
  impact: DEFAULT_IMPACT_SYSTEM,
  why_matters: DEFAULT_WHY_MATTERS_SYSTEM,
  foresight: DEFAULT_FORESIGHT_SYSTEM,
};

/** El override guardado para cada clave DEL TENANT `ownerId`, o null si rige el default. */
export async function getPromptOverrides(
  tx: TenantTx,
  ownerId: string,
): Promise<Record<PromptKey, string | null>> {
  const rows = await tx.promptSetting.findMany({
    where: { ownerId, key: { in: [...PROMPT_KEYS] } },
  });
  const byKey = new Map(rows.map((row) => [row.key, row.value]));
  const overrideOf = (key: PromptKey) => {
    const value = byKey.get(key);
    return value && value.trim() !== "" ? value : null;
  };
  return {
    tldr: overrideOf("tldr"),
    impact: overrideOf("impact"),
    why_matters: overrideOf("why_matters"),
    foresight: overrideOf("foresight"),
  };
}

/** Los system prompts efectivos del tenant (override si existe, default si no). */
export async function getAnalysisSystemPrompts(
  tx: TenantTx,
  ownerId: string,
): Promise<{
  tldr: string;
  impact: string;
  whyMatters: string;
  foresight: string;
}> {
  const overrides = await getPromptOverrides(tx, ownerId);
  return {
    tldr: overrides.tldr ?? DEFAULT_TLDR_SYSTEM,
    impact: overrides.impact ?? DEFAULT_IMPACT_SYSTEM,
    whyMatters: overrides.why_matters ?? DEFAULT_WHY_MATTERS_SYSTEM,
    foresight: overrides.foresight ?? DEFAULT_FORESIGHT_SYSTEM,
  };
}
