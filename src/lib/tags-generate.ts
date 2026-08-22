import { ollamaChat, withOneRetry } from "@/lib/ollama";

// Mismo patrón de lotes que pestel-classify.ts, prompt aparte: las etiquetas son
// texto libre (sin catálogo detrás), no una clasificación contra un enum fijo.
export const TAGS_BATCH_SIZE = 20;
const REQUEST_TIMEOUT_MS = 90_000;
const MIN_TAGS = 3;
const MAX_TAGS = 5;

export type TagsGenerateInput = {
  tweetId: string;
  tweetText: string;
  contentTitle: string | null;
  contentDescription: string | null;
};

export type TagsGenerateResult = {
  tweetId: string;
  tags: string[];
};

function buildSystemPrompt(): string {
  return `Generas etiquetas descriptivas para señales (tweets/enlaces guardados) de un banco de vigilancia tecnológica y de tendencias.

Reglas:
- Entre ${MIN_TAGS} y ${MAX_TAGS} etiquetas por item, nunca menos de ${MIN_TAGS} ni más de ${MAX_TAGS}.
- Cada etiqueta describe el CONTENIDO concreto (tema, tecnología, actor, lugar), no el formato ("artículo", "tweet") ni algo genérico ("noticia", "tecnología").
- 1 a 3 palabras por etiqueta, en español, todo en minúsculas, sin usar "#".
- No repitas la misma idea con sinónimos dentro del mismo item.
- Devuelve un arreglo JSON con exactamente un objeto por item, en el mismo orden, copiando el número de "index" que se te dio. No agregues texto fuera del JSON.
- Cada objeto lleva exactamente dos propiedades: "index" (numero) y "tags" (arreglo de strings). La propiedad se llama "tags", no "labels" ni otra cosa.`;
}

function renderItem(item: TagsGenerateInput, index: number): string {
  const parts = [`index: ${index + 1}`, `tweet: ${item.tweetText.slice(0, 500)}`];
  if (item.contentTitle) parts.push(`titulo del link: ${item.contentTitle.slice(0, 200)}`);
  if (item.contentDescription) {
    parts.push(`descripcion del link: ${item.contentDescription.slice(0, 400)}`);
  }
  return parts.join("\n");
}

const RESULT_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      index: { type: "integer" },
      tags: {
        type: "array",
        items: { type: "string" },
        minItems: MIN_TAGS,
        maxItems: MAX_TAGS,
      },
    },
    required: ["index", "tags"],
    additionalProperties: false,
  },
} as const;

type RawResult = { index?: unknown; tags?: unknown; labels?: unknown };

function parseResults(raw: string): RawResult[] {
  let text = raw.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) text = fenced[1].trim();

  const parsed: unknown = JSON.parse(text);
  if (Array.isArray(parsed)) return parsed as RawResult[];
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as { results?: unknown }).results)) {
    return (parsed as { results: RawResult[] }).results;
  }
  throw new Error("La respuesta del modelo no es un arreglo de resultados.");
}

/**
 * Limpia y acota lo que devolvió el modelo: strings no vacíos, sin duplicados,
 * cortados a MAX_TAGS. Si sobran menos de MIN_TAGS válidas, se devuelve lo que
 * haya en vez de inventar relleno — mejor 1 etiqueta real que 3 con ruido.
 */
function normalizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string") continue;
    const tag = value.trim().toLowerCase().replace(/^#/, "");
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
    if (tags.length >= MAX_TAGS) break;
  }
  return tags;
}

export async function tagsGenerateBatch(items: TagsGenerateInput[]): Promise<TagsGenerateResult[]> {
  if (items.length === 0) return [];
  return withOneRetry(() => requestBatch(items));
}

async function requestBatch(items: TagsGenerateInput[]): Promise<TagsGenerateResult[]> {
  const content = await ollamaChat({
    system: buildSystemPrompt(),
    user: `Genera etiquetas para estos ${items.length} items:\n\n${items.map(renderItem).join("\n\n")}`,
    format: RESULT_SCHEMA,
    temperature: 0.2,
    timeoutMs: REQUEST_TIMEOUT_MS,
  });

  const results = parseResults(content);

  const byIndex = new Map<number, RawResult>();
  for (const result of results) {
    const index = typeof result.index === "number" ? result.index : Number(result.index);
    if (Number.isInteger(index) && index >= 1 && index <= items.length) {
      byIndex.set(index, result);
    }
  }

  return items.map((item, i) => {
    const result = byIndex.get(i + 1);
    // "labels" como alias por si el modelo ignora el nombre pedido (mismo caso que pestel).
    const tags = normalizeTags(result?.tags ?? result?.labels);
    return { tweetId: item.tweetId, tags };
  });
}
