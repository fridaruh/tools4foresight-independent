/**
 * #9 `GET /api/public/v1/themes/{id}/history` — serie temporal de un tema.
 *
 * Es la respuesta a "¿esto está creciendo o apagándose?": una fila por corrida del
 * grafo con el tamaño, la vitalidad, la velocidad y el horizonte de ese momento.
 *
 * Orden ASCENDENTE por `takenAt`: una serie temporal se lee hacia adelante. Sin
 * cursor a propósito — el historial de un tema son decenas de puntos, no miles, y
 * paginarlo obligaría al agente a reconstruir la serie en varias llamadas.
 *
 * Un id que no resuelve a un tema de este tenant es 404 (ver themes/[id]/route.ts
 * para el razonamiento completo de por qué nunca 403).
 */
import type { NextRequest } from "next/server";
import { withOwner } from "@/lib/tenant-db";
import { PublicApiError } from "@/lib/public-api-auth";
import { handleOptions, ok, withPublicApi } from "@/lib/public-api-response";
import { parseLimit } from "@/lib/public-cursor";
import { toSnapshotThemeRow } from "@/lib/public-dto";

// Prisma con @prisma/adapter-pg no corre en edge. Obligatorio en toda la API pública.
export const runtime = "nodejs";

const NOT_FOUND = "No existe un tema con ese id en tu banco.";

const HISTORY_DEFAULT_LIMIT = 100;
const HISTORY_MAX_LIMIT = 500;

/** `to=YYYY-MM-DD` cubre el día entero; un ISO completo se respeta tal cual. */
function parseDate(raw: string | null, param: string, endOfDay = false): Date | null {
  if (!raw || raw.trim() === "") return null;
  const value = raw.trim();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new PublicApiError("invalid_parameter", `El parámetro "${param}" debe ser una fecha ISO.`, 400, param);
  }
  if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Date(parsed.getTime() + 24 * 60 * 60 * 1000 - 1);
  }
  return parsed;
}

async function handler(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
  { ownerId }: { ownerId: string; keyId: string },
) {
  // Next 16: `params` es una Promise.
  const { id } = await ctx.params;
  const params = request.nextUrl.searchParams;
  const from = parseDate(params.get("from"), "from");
  const to = parseDate(params.get("to"), "to", true);
  const limit = parseLimit(params.get("limit"), {
    max: HISTORY_MAX_LIMIT,
    fallback: HISTORY_DEFAULT_LIMIT,
  });

  const takenAt = from || to ? { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } : undefined;

  // El tema y su historia en la misma transacción: el segundo query depende de
  // que el primero haya confirmado que el tema es de este tenant. `graph_snapshot_
  // clusters` también lleva `owner_id` (TENANT_MODEL_FIELD), así que queda
  // acotado por la misma RLS sin filtro adicional. Lectura pura (CLAUDE.md §2).
  const rows = await withOwner(ownerId, async (tx) => {
    const cluster = await tx.semanticCluster.findFirst({ where: { id }, select: { id: true } });
    if (!cluster) return null;

    return tx.graphSnapshotCluster.findMany({
      where: { clusterId: id, ...(takenAt ? { snapshot: { takenAt } } : {}) },
      orderBy: { snapshot: { takenAt: "asc" } },
      take: limit,
      select: {
        clusterId: true,
        name: true,
        size: true,
        status: true,
        vitality: true,
        velocity30d: true,
        density: true,
        connectivity: true,
        novelty: true,
        horizon: true,
        snapshot: { select: { takenAt: true, trigger: true } },
      },
    });
  });

  if (rows === null) {
    throw new PublicApiError("not_found", NOT_FOUND, 404);
  }

  const points = rows.map((row) => ({
    ...toSnapshotThemeRow(row),
    takenAt: row.snapshot.takenAt.toISOString(),
    trigger: row.snapshot.trigger,
  }));

  return ok(
    { themeId: id, points },
    { cache: "graph", request, meta: { count: points.length, hasMore: false, nextCursor: null } },
  );
}

export const GET = withPublicApi(handler);

export function OPTIONS(request: Request) {
  return handleOptions(request);
}
