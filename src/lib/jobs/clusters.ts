import { createHash } from "crypto";
import { ollamaChat, withOneRetry } from "@/lib/ollama";

// Cuantas señales necesita una comunidad para ser un tema con nombre. Por debajo
// de esto el grupo no da para bautizarlo y sus nodos quedan "sin tema" (gris).
export const MIN_CLUSTER_SIZE = Number(process.env.SEMANTIC_CLUSTER_MIN_SIZE ?? "3");

// Este modulo tiene las piezas puras del calculo de temas (deteccion de
// comunidades, hash de membresia, bautizo con el modelo). Quien las orquesta,
// empareja linajes entre corridas y escribe en la base es src/lib/jobs/graph.ts.

/** Con ~10 miembros por tema el prompt ya explica bien el grupo; el tope evita
 *  mandar 60 TL;DRs si un dia un tema se traga medio catalogo. */
const MAX_MEMBERS_IN_PROMPT = 25;

const NAME_TIMEOUT_MS = 90_000;

export type GraphNode = { id: string; title: string; tldr: string | null };
export type GraphEdge = { a: string; b: string; score: number };

export function membersHash(members: string[]): string {
  return createHash("sha256").update([...members].sort().join("\n")).digest("hex");
}

/**
 * Propagacion de etiquetas ponderada por similitud: cada nodo adopta, por rondas,
 * la etiqueta que mas "pesa" entre sus vecinas (suma de scores). Determinista a
 * proposito — orden de visita fijo y desempate por etiqueta menor — para que dos
 * corridas sobre el mismo grafo den los mismos temas y el hash de membresia sirva
 * de cache. Con ~130 nodos converge en un punado de rondas.
 */
export function detectCommunities(ids: string[], edges: GraphEdge[]): string[][] {
  const neighbors = new Map<string, { id: string; score: number }[]>();
  for (const id of ids) neighbors.set(id, []);
  for (const edge of edges) {
    neighbors.get(edge.a)?.push({ id: edge.b, score: edge.score });
    neighbors.get(edge.b)?.push({ id: edge.a, score: edge.score });
  }

  const order = [...ids].sort();
  const label = new Map<string, string>(order.map((id) => [id, id]));

  for (let round = 0; round < 30; round += 1) {
    let changed = false;
    for (const id of order) {
      const weights = new Map<string, number>();
      for (const { id: other, score } of neighbors.get(id) ?? []) {
        const l = label.get(other)!;
        weights.set(l, (weights.get(l) ?? 0) + score);
      }
      if (weights.size === 0) continue;

      let best = label.get(id)!;
      let bestWeight = weights.get(best) ?? 0;
      for (const [l, w] of weights) {
        if (w > bestWeight || (w === bestWeight && l < best)) {
          best = l;
          bestWeight = w;
        }
      }
      if (best !== label.get(id)) {
        label.set(id, best);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const groups = new Map<string, string[]>();
  for (const id of order) {
    const l = label.get(id)!;
    const group = groups.get(l);
    if (group) group.push(id);
    else groups.set(l, [id]);
  }
  // De mayor a menor para que el tema mas grande reciba el primer color de la paleta.
  return [...groups.values()].sort((a, b) => b.length - a.length || (a[0] < b[0] ? -1 : 1));
}

const NAME_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    summary: { type: "string" },
  },
  required: ["name", "summary"],
} as const;

export async function nameCluster(members: GraphNode[]): Promise<{ name: string; summary: string }> {
  const sample = members.slice(0, MAX_MEMBERS_IN_PROMPT);
  const listing = sample
    .map((m, i) => {
      const parts = [`${i + 1}. ${m.title.slice(0, 160)}`];
      if (m.tldr) parts.push(`   ${m.tldr.slice(0, 260)}`);
      return parts.join("\n");
    })
    .join("\n");

  const raw = await withOneRetry(() =>
    ollamaChat({
      system: `Bautizas grupos de señales de un radar de tendencias tecnologicas. Recibes los titulos y resumenes de las señales de un grupo que un algoritmo detecto como tematicamente cercanas.

Reglas:
- "name": el tema comun, en español, maximo 5 palabras, sin punto final. Concreto y especifico (nombra tecnologias, empresas o fenomenos), no generico tipo "Tecnologia e innovacion".
- "summary": 1 o 2 frases en español explicando que une a estas señales — el hilo conductor, no una lista de lo que contiene.
- Devuelve solo el JSON pedido, sin texto extra.`,
      user: `Estas ${sample.length} señales forman un grupo:\n\n${listing}`,
      format: NAME_SCHEMA,
      temperature: 0,
      timeoutMs: NAME_TIMEOUT_MS,
    }),
  );

  const parsed = parseName(raw);
  if (!parsed) throw new Error(`El modelo no devolvio name/summary: ${raw.slice(0, 200)}`);
  return parsed;
}

/** Mismo pragmatismo que categorize.parseResults: el modelo a veces envuelve el
 *  JSON en \`\`\`json aunque el schema diga otra cosa. */
function parseName(raw: string): { name: string; summary: string } | null {
  let text = raw.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) text = fenced[1].trim();
  try {
    const parsed = JSON.parse(text) as { name?: unknown; summary?: unknown };
    if (typeof parsed.name === "string" && parsed.name.trim().length > 0) {
      return {
        name: parsed.name.trim().slice(0, 60),
        summary: typeof parsed.summary === "string" ? parsed.summary.trim().slice(0, 400) : "",
      };
    }
  } catch {
    // cae al null de abajo
  }
  return null;
}

// ---------------------------------------------------------------------------
// Macro-temas: segundo nivel que agrupa temas finos del MISMO horizonte
// (PLAN Horizontes, 2026-08-23). Un tema fino ya trae nombre/resumen del
// bautizo de arriba; aquí no se mira contenido de señales, se agrupan esos
// nombres/resúmenes entre sí.
// ---------------------------------------------------------------------------

export type MacroInput = { id: string; name: string; summary: string; size: number };
export type MacroGroup = { name: string; summary: string; memberIds: string[] };

const GROUP_TIMEOUT_MS = 90_000;

const GROUP_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      name: { type: "string" },
      summary: { type: "string" },
      memberIndexes: { type: "array", items: { type: "integer" } },
    },
    required: ["name", "summary", "memberIndexes"],
    additionalProperties: false,
  },
} as const;

type RawGroup = { name?: unknown; summary?: unknown; memberIndexes?: unknown };

function parseGroups(raw: string): RawGroup[] {
  let text = raw.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) text = fenced[1].trim();
  const parsed: unknown = JSON.parse(text);
  if (Array.isArray(parsed)) return parsed as RawGroup[];
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as { results?: unknown }).results)) {
    return (parsed as { results: RawGroup[] }).results;
  }
  throw new Error("La respuesta del modelo no es un arreglo de grupos.");
}

/**
 * Agrupa `clusters` (todos del MISMO horizonte, ya bautizados) en como mucho
 * `maxGroups` macro-temas. Si el modelo deja algún índice sin asignar, o repite
 * uno en más de un grupo, o devuelve más grupos de los pedidos, se corrige acá:
 * nunca debe perderse un tema fino ni terminar en dos macro-temas a la vez.
 */
export async function groupClusters(clusters: MacroInput[], maxGroups: number): Promise<MacroGroup[]> {
  if (clusters.length <= maxGroups) {
    // Nada que agrupar: cada tema fino es su propio "macro-tema" de 1.
    return clusters.map((c) => ({ name: c.name, summary: c.summary, memberIds: [c.id] }));
  }

  const listing = clusters
    .map((c, i) => `${i + 1}. ${c.name} (${c.size} señales)\n   ${c.summary.slice(0, 300)}`)
    .join("\n");

  const raw = await withOneRetry(() =>
    ollamaChat({
      system: `Agrupas temas de un radar de tendencias en macro-temas más amplios, porque hay demasiados para mostrarlos sueltos.

Reglas:
- Como máximo ${maxGroups} macro-temas. Pueden ser menos si de verdad no hay forma natural de llegar a ${maxGroups}.
- Cada tema fino (por su índice) va en EXACTAMENTE un macro-tema. No dejes ninguno fuera, no repitas un índice en dos grupos.
- "name": el hilo común del macro-tema, en español, máximo 6 palabras, sin punto final. Concreto, no genérico tipo "Tecnología y sociedad".
- "summary": 1-2 frases en español explicando qué reúne a los temas de ese macro-tema.
- Devuelve solo el JSON pedido: un arreglo de objetos con "name", "summary" y "memberIndexes" (los índices, en base 1, de los temas finos que agrupa). Sin texto extra.`,
      user: `Estos ${clusters.length} temas son del mismo horizonte y hay que agruparlos:\n\n${listing}`,
      format: GROUP_SCHEMA,
      temperature: 0,
      timeoutMs: GROUP_TIMEOUT_MS,
    }),
  );

  const parsed = parseGroups(raw);
  const seen = new Set<number>();
  const groups: MacroGroup[] = [];

  for (const g of parsed.slice(0, maxGroups)) {
    if (typeof g.name !== "string" || !g.name.trim()) continue;
    const indexes = Array.isArray(g.memberIndexes) ? g.memberIndexes : [];
    const memberIds: string[] = [];
    for (const idx of indexes) {
      const i = typeof idx === "number" ? idx : Number(idx);
      if (!Number.isInteger(i) || i < 1 || i > clusters.length || seen.has(i)) continue;
      seen.add(i);
      memberIds.push(clusters[i - 1].id);
    }
    if (memberIds.length > 0) {
      groups.push({
        name: g.name.trim().slice(0, 80),
        summary: typeof g.summary === "string" ? g.summary.trim().slice(0, 400) : "",
        memberIds,
      });
    }
  }

  // Red de seguridad: cualquier índice que el modelo haya dejado fuera (o que
  // haya llegado en un grupo #16+ que se recortó arriba) cae en un macro-tema
  // propio, uno por tema huérfano — mejor de más que perder un tema de la vista.
  const orphans = clusters.filter((_, i) => !seen.has(i + 1));
  for (const orphan of orphans) {
    groups.push({ name: orphan.name, summary: orphan.summary, memberIds: [orphan.id] });
  }

  // Si aun así quedaron más de maxGroups (por huérfanos), se funden los más
  // chicos en un cajón "Otros temas" para respetar el tope.
  if (groups.length > maxGroups) {
    groups.sort((a, b) => b.memberIds.length - a.memberIds.length);
    const kept = groups.slice(0, maxGroups - 1);
    const merged = groups.slice(maxGroups - 1);
    kept.push({
      name: "Otros temas",
      summary: "Temas que no encajaron con claridad en los demás macro-temas de este horizonte.",
      memberIds: merged.flatMap((g) => g.memberIds),
    });
    return kept;
  }

  return groups;
}
