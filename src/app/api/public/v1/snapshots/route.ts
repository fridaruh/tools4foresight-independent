/**
 * GET /api/public/v1/snapshots — corridas del grafo del tenant, la más reciente
 * primero.
 *
 * Cada snapshot es una foto completa del mapa del banco en un momento. Con dos o
 * más se ve nacer, crecer y apagarse a los temas: es la base de cualquier lectura
 * de evolución. Cursor por ID (`v1i…`, ver public-cursor.ts) porque el orden es
 * por `takenAt`, no por `likedAt` — el cursor keyset de `/signals` no aplica aquí.
 */
import type { NextRequest } from "next/server";
import { withOwner } from "@/lib/tenant-db";
import { PublicApiError } from "@/lib/public-api-auth";
import { handleOptions, ok, withPublicApi } from "@/lib/public-api-response";
import { decodeIdCursor, encodeIdCursor, parseLimit } from "@/lib/public-cursor";
import { SNAPSHOT_SUMMARY_SELECT, toSnapshotSummary } from "@/lib/public-dto";

export const runtime = "nodejs";

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
  _ctx: unknown,
  { ownerId }: { ownerId: string; keyId: string },
) {
  const params = request.nextUrl.searchParams;
  const from = parseDate(params.get("from"), "from");
  const to = parseDate(params.get("to"), "to", true);
  const limit = parseLimit(params.get("limit"));
  const rawCursor = params.get("cursor");
  const cursorId = rawCursor ? decodeIdCursor(rawCursor) : null;

  const where = {
    ownerId,
    ...(from || to ? { takenAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
  };

  // Ambas queries en la misma `withOwner`: lectura pura, sin LLM/HTTP de por medio
  // (CLAUDE.md §2).
  const [rows, total] = await withOwner(ownerId, (tx) =>
    Promise.all([
      tx.graphSnapshot.findMany({
        where,
        select: SNAPSHOT_SUMMARY_SELECT,
        orderBy: [{ takenAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      }),
      tx.graphSnapshot.count({ where }),
    ]),
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);

  return ok(page.map(toSnapshotSummary), {
    cache: "graph",
    request,
    meta: {
      nextCursor: hasMore && last ? encodeIdCursor(last.id) : null,
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
