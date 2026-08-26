/**
 * #8 `GET /api/public/v1/themes/{id}/signals` — las señales que componen un tema.
 *
 * EL CASO QUE ROMPE: un tema `dead` (fósil) ya no tiene señales apuntándole con
 * `clusterId` — el job de grafo se lo quita al morir. Consultar por `clusterId` a
 * secas devolvería una lista vacía para todo fósil, que se lee como "este tema no
 * tuvo señales" cuando la verdad es "este tema ya no está vivo". Por eso, cuando
 * el tema está muerto, la membresía sale de `lastMemberIds`.
 *
 * Sin filtro de publicación: el origen acotaba siempre a `PUBLISHED_ONLY` porque
 * servía el acervo a lectores ajenos; aquí el dueño ve su banco completo
 * (PLAN_MCP §0.2), así que la lista incluye señales `pending` y `published` por
 * igual. Un id que no resuelve a un tema DE ESTE TENANT es 404 (ver
 * themes/[id]/route.ts para el razonamiento completo del 404-nunca-403).
 */
import type { NextRequest } from "next/server";
import type { Prisma } from "@/generated/prisma/client";
import { withOwner } from "@/lib/tenant-db";
import { PublicApiError } from "@/lib/public-api-auth";
import { handleOptions, ok, withPublicApi } from "@/lib/public-api-response";
import { decodeCursor, encodeCursor, parseLimit } from "@/lib/public-cursor";
import { SIGNAL_SUMMARY_SELECT, toSignalSummary } from "@/lib/public-dto";

// Prisma con @prisma/adapter-pg no corre en edge. Obligatorio en toda la API pública.
export const runtime = "nodejs";

const NOT_FOUND = "No existe un tema con ese id en tu banco.";

type SortKey = "vitality" | "likedAt";

function parseSort(raw: string | null): SortKey {
  if (!raw) return "vitality";
  if (raw === "vitality" || raw === "likedAt") return raw;
  throw new PublicApiError("invalid_parameter", 'El parámetro "sort" debe ser vitality o likedAt.', 400, "sort");
}

async function handler(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
  { ownerId }: { ownerId: string; keyId: string },
) {
  // Next 16: `params` es una Promise.
  const { id } = await ctx.params;
  const params = request.nextUrl.searchParams;
  const sort = parseSort(params.get("sort"));
  const limit = parseLimit(params.get("limit"));
  const rawCursor = params.get("cursor");
  const cursor = rawCursor ? decodeCursor(rawCursor) : null;

  const orderBy: Prisma.LikedItemOrderByWithRelationInput[] =
    sort === "vitality"
      ? [{ vitality: { sort: "desc", nulls: "last" } }, { id: "desc" }]
      : [{ likedAt: "desc" }, { id: "desc" }];

  // Todo en una transacción: el `where` de señales depende del `status` del tema,
  // que solo se conoce tras el primer query. Lectura pura (CLAUDE.md §2).
  const result = await withOwner(ownerId, async (tx) => {
    const cluster = await tx.semanticCluster.findFirst({
      where: { id },
      select: { id: true, status: true, lastMemberIds: true },
    });
    if (!cluster) return null;

    // Vivo -> la relación actual. Fósil -> la última membresía conocida.
    const where: Prisma.LikedItemWhereInput =
      cluster.status === "dead" ? { id: { in: cluster.lastMemberIds } } : { clusterId: cluster.id };

    const [rows, total] = await Promise.all([
      tx.likedItem.findMany({
        where,
        select: SIGNAL_SUMMARY_SELECT,
        orderBy,
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor.id }, skip: 1 } : {}),
      }),
      tx.likedItem.count({ where }),
    ]);

    return { rows, total };
  });

  if (!result) {
    throw new PublicApiError("not_found", NOT_FOUND, 404);
  }

  const { rows, total } = result;
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);

  return ok(page.map(toSignalSummary), {
    cache: "graph",
    request,
    meta: {
      nextCursor: hasMore && last ? encodeCursor({ likedAt: last.likedAt, id: last.id }) : null,
      hasMore,
      count: page.length,
      total,
    },
  });
}

export const GET = withPublicApi(handler);

export function OPTIONS(request: Request) {
  return handleOptions(request);
}
