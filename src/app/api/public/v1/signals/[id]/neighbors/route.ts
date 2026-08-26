/**
 * #5 `GET /api/public/v1/signals/{id}/neighbors` — señales semánticamente cercanas.
 *
 * Devuelve `score` (coseno crudo) y `strength` (fuerte/media/débil). La regla de
 * producto es que al LECTOR HUMANO nunca se le muestra el porcentaje de similitud
 * —un 0.63 se lee como precisión falsa y la conversación se va al número en vez de
 * a la relación—, pero un agente sí necesita el float para ordenar y poner
 * umbrales. Por eso viajan los dos, y la instrucción de cuál usar al redactar vive
 * en la descripción de la tool MCP, que es donde un modelo la obedece.
 *
 * Un id que no resuelve en el banco del tenant es 404, igual que en
 * `/signals/{id}` y por la misma razón (ver el comentario de ese archivo): nunca
 * 403, para no confirmar que el id existe en el banco de otra persona.
 */
import type { NextRequest } from "next/server";
import { withOwner } from "@/lib/tenant-db";
import { PublicApiError } from "@/lib/public-api-auth";
import { handleOptions, ok, withPublicApi } from "@/lib/public-api-response";
import { parseLimit } from "@/lib/public-cursor";
import { SIGNAL_SUMMARY_SELECT, toNeighbor } from "@/lib/public-dto";

export const runtime = "nodejs";

const NEIGHBORS_DEFAULT_LIMIT = 10;
const NEIGHBORS_MAX_LIMIT = 50;

function parseMinScore(raw: string | null): number | null {
  if (!raw || raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new PublicApiError(
      "invalid_parameter",
      'El parámetro "minScore" debe ser un número entre 0 y 1.',
      400,
      "minScore",
    );
  }
  return n;
}

async function handler(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
  { ownerId }: { ownerId: string; keyId: string },
) {
  const { id } = await ctx.params;
  const params = request.nextUrl.searchParams;
  const limit = parseLimit(params.get("limit"), {
    max: NEIGHBORS_MAX_LIMIT,
    fallback: NEIGHBORS_DEFAULT_LIMIT,
  });
  const minScore = parseMinScore(params.get("minScore"));

  // Todo en una transacción: confirmar que la señal es de este tenant y, si lo
  // es, traer sus vecinos. Lectura pura, sin LLM/HTTP de por medio (CLAUDE.md §2).
  const data = await withOwner(ownerId, async (tx) => {
    const signal = await tx.likedItem.findFirst({ where: { id }, select: { id: true } });
    if (!signal) return null;

    // El par en `semantic_links` va ordenado (itemAId < itemBId), así que la
    // señal puede estar en cualquiera de los dos lados: se buscan ambos y luego
    // se normaliza "el otro extremo". A diferencia del origen, no hace falta
    // exigir que el otro extremo esté publicado: RLS ya acotó ambos lados a este
    // tenant, y el dueño ve su banco completo, publicado o no.
    const links = await tx.semanticLink.findMany({
      where: {
        ...(minScore !== null ? { score: { gte: minScore } } : {}),
        OR: [{ itemAId: id }, { itemBId: id }],
      },
      orderBy: { score: "desc" },
      take: limit,
      select: {
        score: true,
        itemAId: true,
        itemBId: true,
        itemA: { select: SIGNAL_SUMMARY_SELECT },
        itemB: { select: SIGNAL_SUMMARY_SELECT },
      },
    });

    return links.map((link) => {
      const other = link.itemAId === id ? link.itemB : link.itemA;
      return toNeighbor(other, link.score);
    });
  });

  if (data === null) {
    throw new PublicApiError("not_found", "No existe una señal con ese id en tu banco.", 404);
  }

  return ok(data, {
    cache: "graph",
    request,
    meta: { count: data.length, total: data.length, hasMore: false, nextCursor: null },
  });
}

export const GET = withPublicApi(handler);

export function OPTIONS(request: Request) {
  return handleOptions(request);
}
