import { PESTEL_DIMENSIONS, normalizePestel } from "@/config/pestel";
import { ollamaChat, withOneRetry } from "@/lib/ollama";

// Mismo patron de lotes que categorize.ts, prompt aparte a proposito: no se toca el
// prompt de categoria (bien afinado, ver comentarios ahi) para clasificar algo
// distinto en la misma llamada.
export const PESTEL_BATCH_SIZE = 20;
const REQUEST_TIMEOUT_MS = 90_000;

export type PestelClassifyInput = {
  tweetId: string;
  tweetText: string;
  contentTitle: string | null;
  contentDescription: string | null;
};

export type PestelClassifyResult = {
  tweetId: string;
  pestel: string[];
};

function buildSystemPrompt(): string {
  const catalog = PESTEL_DIMENSIONS.map((d) => `- ${d.key}: ${d.label} (${d.letter})`).join("\n");

  return `Clasificas tweets que una persona marco como "me gusta" segun el marco PESTEL.

Dimensiones disponibles:

${catalog}

Reglas:
- Maximo 2 dimensiones por item, las mas relevantes. Casi nunca son mas de 2.
- Si el tweet no encaja con claridad en ninguna dimension, devuelve un arreglo vacio en vez de forzar una.
- No inventes dimensiones fuera del catalogo; usa las claves tal cual (political, economic, social, technological, environmental, legal).
- Devuelve un arreglo JSON con exactamente un objeto por item, en el mismo orden, copiando el numero de "index" que se te dio. No agregues texto fuera del JSON.
- Cada objeto lleva exactamente dos propiedades: "index" (numero) y "pestel" (arreglo de claves). La propiedad se llama "pestel", no "dimensions" ni otra cosa.`;
}

function renderItem(item: PestelClassifyInput, index: number): string {
  const parts = [`index: ${index + 1}`, `tweet: ${item.tweetText.slice(0, 500)}`];
  if (item.contentTitle) parts.push(`titulo del link: ${item.contentTitle.slice(0, 200)}`);
  if (item.contentDescription) {
    parts.push(`descripcion del link: ${item.contentDescription.slice(0, 400)}`);
  }
  return parts.join("\n");
}

// El enum y additionalProperties son deliberados: sin ellos gpt-oss respondia con la
// propiedad "dimensions" en vez de "pestel" (el format de Ollama no lo forzaba y el
// prompt no la nombraba), el parser leia undefined y TODO quedaba clasificado como [].
const RESULT_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      index: { type: "integer" },
      pestel: {
        type: "array",
        items: {
          type: "string",
          enum: ["political", "economic", "social", "technological", "environmental", "legal"],
        },
      },
    },
    required: ["index", "pestel"],
    additionalProperties: false,
  },
} as const;

type RawResult = { index?: unknown; pestel?: unknown; dimensions?: unknown };

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

export async function pestelClassifyBatch(
  items: PestelClassifyInput[],
): Promise<PestelClassifyResult[]> {
  if (items.length === 0) return [];
  return withOneRetry(() => requestBatch(items));
}

async function requestBatch(items: PestelClassifyInput[]): Promise<PestelClassifyResult[]> {
  const content = await ollamaChat({
    system: buildSystemPrompt(),
    user: `Clasifica estos ${items.length} items:\n\n${items.map(renderItem).join("\n\n")}`,
    format: RESULT_SCHEMA,
    temperature: 0,
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
    // "dimensions" como alias por si el modelo vuelve a ignorar el nombre pedido.
    const pestel = normalizePestel(result?.pestel ?? result?.dimensions).slice(0, 2);
    return { tweetId: item.tweetId, pestel };
  });
}
