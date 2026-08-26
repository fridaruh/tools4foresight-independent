/**
 * #6 `GET /api/public/v1/themes` — lista paginada de temas (clusters semánticos).
 *
 * Un tema es un LINAJE: sobrevive entre corridas del grafo, acumula historia y
 * puede morir (fósil) y resucitar. Por eso el default de `status` es "cualquiera"
 * (`any`, ver `parseStatusParam` en public-query.ts) pero los fósiles siguen
 * siendo consultables: no se borran nunca.
 *
 * Aislamiento: `buildThemeWhere` (public-query.ts) NO filtra por dueño —lo dice su
 * propia cabecera—; lo hace esta transacción, que fija `app.owner_id` y deja que
 * RLS filtre en Postgres. En el origen (single-tenant) esta consulta corría sobre
 * `prisma` global; aquí cada Bearer resuelve a un `ownerId` y ese es el único
 * scope posible.
 */
import type { NextRequest } from "next/server";
import type { Prisma } from "@/generated/prisma/client";
import { withOwner } from "@/lib/tenant-db";
import { PublicApiError } from "@/lib/public-api-auth";
import { handleOptions, ok, withPublicApi } from "@/lib/public-api-response";
import { decodeIdCursor, encodeIdCursor, parseLimit } from "@/lib/public-cursor";
import { THEME_SELECT, toThemeSummary } from "@/lib/public-dto";
import { buildThemeWhere, publicThemeFiltersFromSearchParams } from "@/lib/public-query";

// Prisma con @prisma/adapter-pg no corre en edge. Obligatorio en toda la API pública.
export const runtime = "nodejs";

const SORTS = ["vitality", "size", "velocity", "lastSignal"] as const;
type SortKey = (typeof SORTS)[number];

function parseSort(raw: string | null): SortKey {
  if (!raw) return "vitality";
  if ((SORTS as readonly string[]).includes(raw)) return raw as SortKey;
  throw new PublicApiError(
    "invalid_parameter",
    `El parámetro "sort" debe ser uno de: ${SORTS.join(", ")}.`,
    400,
    "sort",
  );
}

function orderFor(sort: SortKey): Prisma.SemanticClusterOrderByWithRelationInput[] {
  // El `id` desempata siempre: sin él, dos temas con la misma vitalidad podrían
  // intercambiarse entre páginas y el cursor devolvería filas repetidas.
  switch (sort) {
    case "size":
      return [{ size: "desc" }, { id: "desc" }];
    case "velocity":
      return [{ velocity30d: "desc" }, { id: "desc" }];
    case "lastSignal":
      // `lastSignalAt` es nullable: un tema sin señales fechadas no debe encabezar
      // el orden "más reciente primero" (en Postgres, DESC pone los NULL primero).
      return [{ lastSignalAt: { sort: "desc", nulls: "last" } }, { id: "desc" }];
    case "vitality":
    default:
      return [{ vitality: "desc" }, { id: "desc" }];
  }
}

async function handler(
  request: NextRequest,
  _ctx: unknown,
  { ownerId }: { ownerId: string; keyId: string },
) {
  const params = request.nextUrl.searchParams;
  const filters = publicThemeFiltersFromSearchParams(params);
  const sort = parseSort(params.get("sort"));
  const limit = parseLimit(params.get("limit"));
  const rawCursor = params.get("cursor");
  // Cursor por id (`v1i…`), distinto del `v1…` de las listas por `likedAt`: pegar
  // aquí un cursor de /signals da un 400 claro en vez de una página mal cortada.
  const cursorId = rawCursor ? decodeIdCursor(rawCursor) : null;

  const where = buildThemeWhere(filters);

  // Ambas queries en la misma transacción: lectura pura, sin LLM/HTTP de por
  // medio (CLAUDE.md §2).
  const [rows, total] = await withOwner(ownerId, (tx) =>
    Promise.all([
      tx.semanticCluster.findMany({
        where,
        select: THEME_SELECT,
        orderBy: orderFor(sort),
        take: limit + 1,
        ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      }),
      tx.semanticCluster.count({ where }),
    ]),
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);

  return ok(page.map(toThemeSummary), {
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
