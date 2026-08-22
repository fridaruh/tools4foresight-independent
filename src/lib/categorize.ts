import type { Category } from "@/generated/prisma/client";
import { fallbackCategory } from "@/lib/categories";
import { ollamaChat, withOneRetry } from "@/lib/ollama";

// Un solo item puede tener poco texto (un tweet suelto) o bastante (tweet + titulo +
// descripcion del link). Se clasifican en lotes para no hacer una llamada por like:
// con ~4k items pendientes, de uno en uno serian ~4k llamadas.
export const BATCH_SIZE = 20;

/** Un lote de 20 tarda ~25s con gpt-oss:120b; 90s deja margen sin colgar la corrida. */
const REQUEST_TIMEOUT_MS = 90_000;

export type CategorizationInput = {
  tweetId: string;
  authorHandle: string;
  tweetText: string;
  contentTitle: string | null;
  contentDescription: string | null;
};

export type CategorizationResult = {
  tweetId: string;
  category: string;
  confidence: number;
  reasoning: string;
  /** El modelo propuso una categoria que no esta en el catalogo (ver PLAN 3.1). */
  isNewCategory: boolean;
};

// El catálogo ya no sale de src/config/categories.ts (plantilla de seed): lo carga
// el caller UNA vez por corrida con src/lib/categories.ts (loadCategories, dentro de
// withOwner) y lo pasa aquí por parámetro — así esta función no toca la DB ni sabe
// de tenants.
export function buildSystemPrompt(categories: Category[]): string {
  const fallback = fallbackCategory(categories);
  const catalog = categories
    .map((c) => {
      const examples = c.examples.map((e) => `    - "${e}"`).join("\n");
      return `- ${c.name}: ${c.description}\n  Ejemplos:\n${examples}`;
    })
    .join("\n\n");

  return `Clasificas tweets que una persona marco como "me gusta", para que pueda reencontrarlos despues.

Categorias disponibles:

${catalog}

Reglas:
- Asigna exactamente una categoria por item.
- Prefiere siempre una categoria existente. Solo propon una nueva (isNewCategory: true) cuando el item tiene un tema claro que ninguna categoria cubre y meterlo en "${fallback?.name ?? "Otros"}" perderia informacion util.
- Una categoria nueva se nombra en español o ingles corto, en Title Case, como las existentes.
- confidence va de 0 a 1: que tan seguro estas de la asignacion.
- reasoning: una frase corta (max 15 palabras) explicando por que. Sirve para auditar errores de clasificacion.
- Devuelve un arreglo JSON con exactamente un objeto por item, en el mismo orden, copiando el numero de "index" que se te dio. No agregues texto fuera del JSON.`;
}

function renderItem(item: CategorizationInput, index: number): string {
  // Se numera con un indice chico en vez del tweetId: los ids de X son snowflakes de
  // 19 digitos y varios modelos los emiten como number, que pierde precision arriba de
  // 2^53 y deja de hacer match (gpt-oss:120b lo hacia en el 100% de los items).
  const parts = [
    `index: ${index + 1}`,
    `autor: @${item.authorHandle}`,
    `tweet: ${item.tweetText.slice(0, 500)}`,
  ];
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
      category: { type: "string" },
      confidence: { type: "number" },
      reasoning: { type: "string" },
      isNewCategory: { type: "boolean" },
    },
    required: ["index", "category", "confidence", "reasoning", "isNewCategory"],
  },
} as const;

type RawResult = {
  index?: unknown;
  category?: unknown;
  confidence?: unknown;
  reasoning?: unknown;
  isNewCategory?: unknown;
};

/**
 * Ollama acepta un JSON schema en `format`, pero los modelos no lo respetan al pie de
 * la letra: algunos envuelven la respuesta en ```json, otros la meten en {results: [...]}.
 * Se aceptan las tres formas en vez de tirar el lote entero.
 */
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

export async function categorizeBatch(
  items: CategorizationInput[],
  categories: Category[],
): Promise<CategorizationResult[]> {
  if (items.length === 0) return [];

  // Un lote se pierde entero cuando el modelo trunca el JSON a medias (visto ~1 de cada
  // 40 lotes: "Unterminated fractional number"). Reintentar una vez recupera la mayoria
  // sin volver a leerlos de la DB en la siguiente corrida.
  return withOneRetry(() => requestBatch(items, categories));
}

async function requestBatch(
  items: CategorizationInput[],
  categories: Category[],
): Promise<CategorizationResult[]> {
  const content = await ollamaChat({
    system: buildSystemPrompt(categories),
    user: `Clasifica estos ${items.length} items:\n\n${items.map(renderItem).join("\n\n")}`,
    format: RESULT_SCHEMA,
    // Clasificacion acotada: se quiere la misma respuesta ante el mismo item, no
    // variedad, y asi una recorrida repetida es reproducible.
    temperature: 0,
    timeoutMs: REQUEST_TIMEOUT_MS,
  });

  const results = parseResults(content);

  // El modelo puede saltarse un item o devolver un indice que no pedimos, asi que se
  // hace match explicito por indice en vez de confiar en la posicion del arreglo.
  const byIndex = new Map<number, RawResult>();
  for (const result of results) {
    const index = typeof result.index === "number" ? result.index : Number(result.index);
    if (Number.isInteger(index) && index >= 1 && index <= items.length) {
      byIndex.set(index, result);
    }
  }

  const knownNames = new Set(categories.map((c) => c.name));
  const fallback = fallbackCategory(categories);

  return items.map((item, i) => {
    const result = byIndex.get(i + 1);
    const category = typeof result?.category === "string" ? result.category.trim() : "";

    if (!category) {
      return {
        tweetId: item.tweetId,
        category: fallback?.name ?? "Otros",
        confidence: 0,
        reasoning: "El modelo no devolvio resultado para este item.",
        isNewCategory: false,
      };
    }

    const confidence = typeof result?.confidence === "number" ? result.confidence : 0;

    return {
      tweetId: item.tweetId,
      category,
      // Se acota a [0,1]: algun modelo devuelve la confianza en porcentaje (85 en vez
      // de 0.85) y eso descuadraria cualquier filtro por confianza.
      confidence: Math.min(1, Math.max(0, confidence > 1 ? confidence / 100 : confidence)),
      reasoning: typeof result?.reasoning === "string" ? result.reasoning : "",
      // La bandera del modelo no decide: manda si el nombre esta o no en el catalogo
      // DEL TENANT.
      isNewCategory: !knownNames.has(category),
    };
  });
}
