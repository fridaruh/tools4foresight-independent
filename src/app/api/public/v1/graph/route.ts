/**
 * GET /api/public/v1/graph — el grafo semántico completo del banco del tenant
 * (nodos + aristas).
 *
 * Endpoint CARO (`expensive: true`, 10/min): puede devolver miles de nodos, y cada
 * respuesta reconstruye el mapa entero en vez de paginar una lista.
 *
 * Nodos, aristas y los conteos de temas vivos/muertos corren dentro de la MISMA
 * `withOwner(ownerId, …)`: es lectura pura (sin LLM/HTTP de por medio, CLAUDE.md
 * §2), así que componerlo todo en una sola transacción evita abrir tres o cuatro
 * conexiones sueltas contra el pooler de Neon para armar una única respuesta
 * (mismo criterio que `public-horizons.ts`). El `tx` es un cliente pelado —RLS ya
 * acota por `app.owner_id`, pero `ownerId` se repite a mano en cada `where` como
 * segunda barrera de aplicación, igual que hace `tenantClient` y que documenta el
 * encabezado de `public-horizons.ts`.
 *
 * La columna `embedding` nunca se toca: `GRAPH_NODE_SELECT` es un select explícito
 * (public-dto.ts) que no la incluye ni a ella ni a `ownerId`.
 */
import type { NextRequest } from "next/server";
import type { Prisma } from "@/generated/prisma/client";
import { withOwner } from "@/lib/tenant-db";
import { PublicApiError } from "@/lib/public-api-auth";
import { handleOptions, ok, withPublicApi } from "@/lib/public-api-response";
import { parseLimit } from "@/lib/public-cursor";
import { GRAPH_EDGE_SELECT, GRAPH_NODE_SELECT, toGraphEdge, toGraphNode } from "@/lib/public-dto";
import { isHorizon } from "@/lib/horizons";

// Prisma con @prisma/adapter-pg no corre en edge. Obligatorio en toda la API pública.
export const runtime = "nodejs";

const GRAPH_DEFAULT_LIMIT = 500;
const GRAPH_MAX_LIMIT = 2000;

function parseUnitInterval(raw: string | null, param: string): number | null {
  if (!raw || raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new PublicApiError("invalid_parameter", `El parámetro "${param}" debe estar entre 0 y 1.`, 400, param);
  }
  return n;
}

function parseMinVitality(raw: string | null): number | null {
  if (!raw || raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new PublicApiError("invalid_parameter", 'El parámetro "minVitality" debe ser >= 0.', 400, "minVitality");
  }
  return n;
}

async function handler(
  request: NextRequest,
  _ctx: unknown,
  { ownerId }: { ownerId: string; keyId: string },
) {
  const params = request.nextUrl.searchParams;
  const rawHorizon = params.get("horizon");
  if (rawHorizon && !isHorizon(rawHorizon)) {
    throw new PublicApiError("invalid_parameter", 'El parámetro "horizon" debe ser H1, H2 o H3.', 400, "horizon");
  }
  const minVitality = parseMinVitality(params.get("minVitality"));
  const minScore = parseUnitInterval(params.get("minScore"), "minScore");
  const limit = parseLimit(params.get("limit"), { max: GRAPH_MAX_LIMIT, fallback: GRAPH_DEFAULT_LIMIT });

  const { nodes, edges, totalNodes, themesAlive, themesDead } = await withOwner(ownerId, async (tx) => {
    // Nodos = señales YA EMBEBIDAS. El job de embeddings (jobs/embed.ts) solo
    // embebe señales con `publishStatus: "published"`, así que este único filtro
    // reemplaza al `PUBLISHED_ONLY` del origen sin reintroducirlo: una señal
    // `pending` nunca tiene `embeddedAt` (PLAN_MCP §0.2 — aquí no existe ese
    // filtro como cláusula fija, pero el efecto de fondo sigue siendo el mismo
    // para este endpoint en particular, por cómo funciona el pipeline).
    const nodeWhere: Prisma.LikedItemWhereInput = {
      ownerId,
      embeddedAt: { not: null },
      ...(rawHorizon ? { cluster: { horizon: rawHorizon } } : {}),
      ...(minVitality !== null ? { vitality: { gte: minVitality } } : {}),
    };

    const [totalNodes, nodeRows] = await Promise.all([
      tx.likedItem.count({ where: nodeWhere }),
      tx.likedItem.findMany({
        where: nodeWhere,
        select: GRAPH_NODE_SELECT,
        // El corte es por vitalidad: si hay que quedarse con 500 de 3000, que
        // sean las 500 más vivas y no 500 al azar.
        orderBy: [{ vitality: { sort: "desc", nulls: "last" } }, { id: "desc" }],
        take: limit,
      }),
    ]);

    const nodes = nodeRows.map(toGraphNode);
    const nodeIds = new Set(nodes.map((n) => n.id));

    // Aristas del tenant con AMBOS extremos entre los nodos que sobrevivieron al
    // corte. GRAPH_EDGE_SELECT (public-dto.ts) ya documenta por qué no hace falta
    // refiltrar por publicación: el job de grafo solo crea aristas entre señales
    // publicadas. Si se filtrara solo por tenant, el recorte de nodos dejaría
    // aristas colgando hacia ids fuera de la respuesta.
    const edgeRows =
      nodeIds.size === 0
        ? []
        : await tx.semanticLink.findMany({
            where: {
              ownerId,
              ...(minScore !== null ? { score: { gte: minScore } } : {}),
              itemAId: { in: [...nodeIds] },
              itemBId: { in: [...nodeIds] },
            },
            select: GRAPH_EDGE_SELECT,
            orderBy: { score: "desc" },
          });

    const edges = edgeRows.map(toGraphEdge);

    const [themesAlive, themesDead] = await Promise.all([
      tx.semanticCluster.count({ where: { ownerId, status: "alive" } }),
      tx.semanticCluster.count({ where: { ownerId, status: "dead" } }),
    ]);

    return { nodes, edges, totalNodes, themesAlive, themesDead };
  });

  const orphans = nodes.filter((n) => n.themeId === null).length;
  const truncated = totalNodes > nodes.length;

  return ok(
    {
      nodes,
      edges,
      stats: { nodes: nodes.length, edges: edges.length, themesAlive, themesDead, orphans },
    },
    {
      cache: "graph",
      request,
      meta: {
        count: nodes.length,
        total: totalNodes,
        hasMore: false,
        nextCursor: null,
        // Truncar en silencio sería lo peor que puede hacer este endpoint: un
        // agente que recibe 500 de 3000 nodos sin saberlo saca conclusiones
        // falsas sobre la estructura del mapa.
        ...(truncated ? { truncated: true } : {}),
      },
    },
  );
}

export const GET = withPublicApi(handler, { expensive: true });

export function OPTIONS(request: Request) {
  return handleOptions(request);
}
