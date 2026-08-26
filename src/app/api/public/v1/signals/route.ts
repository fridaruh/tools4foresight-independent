/**
 * #3 `GET /api/public/v1/signals` — lista paginada de señales del banco del tenant.
 *
 * Toda la plomería (API key, tenant, rate limit, traducción de `PublicApiError` al
 * envelope de error, cabeceras) la hace `withPublicApi`: este handler solo valida
 * sus propios parámetros, consulta DENTRO de `withOwner(ownerId, …)` y devuelve
 * `ok(...)`. En el origen (single-tenant) esta consulta corría sobre `prisma`
 * global y `buildPublicWhere` siempre traía `PUBLISHED_ONLY` de fábrica; aquí no
 * hay claves de servicio ni acervo compartido — cada Bearer resuelve a un
 * `ownerId` y el filtro de publicación pasó a ser opcional (`?publishStatus=`,
 * ver public-query.ts).
 */
import type { NextRequest } from "next/server";
import type { Prisma } from "@/generated/prisma/client";
import { withOwner } from "@/lib/tenant-db";
import { PublicApiError } from "@/lib/public-api-auth";
import { handleOptions, ok, withPublicApi } from "@/lib/public-api-response";
import { encodeCursor, decodeCursor, parseLimit } from "@/lib/public-cursor";
import { SIGNAL_SUMMARY_SELECT, toSignalSummary } from "@/lib/public-dto";
import { buildPublicWhere, publicFiltersFromSearchParams } from "@/lib/public-query";

// Prisma con @prisma/adapter-pg no corre en edge. Obligatorio en toda la API pública.
export const runtime = "nodejs";

type SortKey = "likedAt" | "vitality";

function parseSort(raw: string | null): SortKey {
  if (!raw) return "likedAt";
  if (raw === "likedAt" || raw === "vitality") return raw;
  // Los enums son sensibles a mayúsculas: "likedat" es un 400, no un alias.
  throw new PublicApiError("invalid_parameter", 'El parámetro "sort" debe ser likedAt o vitality.', 400, "sort");
}

/** Un booleano solo acepta `true`/`false`; ausente = default documentado. */
function assertBooleanParam(raw: string | null, param: string): void {
  if (raw !== null && raw !== "" && raw !== "true" && raw !== "false") {
    throw new PublicApiError("invalid_parameter", `El parámetro "${param}" debe ser true o false.`, 400, param);
  }
}

/**
 * `to=YYYY-MM-DD` tiene que cubrir el día entero: `new Date("2026-08-31")` —lo
 * que hace `publicFiltersFromSearchParams`— da medianoche UTC y dejaría fuera
 * todo el día. Se corrige aquí, sobre el filtro ya parseado, en vez de tocar
 * public-query.ts. Solo aplica a la forma corta: un ISO completo se respeta tal cual.
 */
function endOfDayIfDateOnly(raw: string | null, parsed: Date | null): Date | null {
  if (!raw || !parsed) return parsed;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) return parsed;
  return new Date(parsed.getTime() + 24 * 60 * 60 * 1000 - 1);
}

async function handler(
  request: NextRequest,
  _ctx: unknown,
  { ownerId }: { ownerId: string; keyId: string },
) {
  const params = request.nextUrl.searchParams;

  assertBooleanParam(params.get("orphans"), "orphans");
  const filters = publicFiltersFromSearchParams(params);
  filters.to = endOfDayIfDateOnly(params.get("to"), filters.to);

  if (filters.minVitality !== null && filters.minVitality < 0) {
    throw new PublicApiError("invalid_parameter", 'El parámetro "minVitality" debe ser >= 0.', 400, "minVitality");
  }

  // `orphans=true` es "señales sin tema", así que cualquier filtro que hable del
  // tema de la señal es una combinación imposible. Se rechaza en vez de devolver
  // `[]` en silencio: una lista vacía se lee como "no hay datos", no como
  // "pediste algo contradictorio".
  if (filters.orphansOnly && (filters.themeId || filters.macroThemeId || filters.horizon || filters.status !== "any")) {
    throw new PublicApiError(
      "invalid_parameter",
      '"orphans=true" es incompatible con "theme", "macroTheme", "horizon" y un "status" distinto de any.',
      400,
      "orphans",
    );
  }

  const sort = parseSort(params.get("sort"));
  const limit = parseLimit(params.get("limit"));
  const rawCursor = params.get("cursor");
  const cursor = rawCursor ? decodeCursor(rawCursor) : null;

  // Keyset compuesto `(likedAt, id)`, no offset. `likedAt` es una ESTIMACIÓN con
  // empates frecuentes (varios ítems históricos comparten fecha): un cursor sobre
  // ese campo solo se salta las filas empatadas que quedaron del otro lado del
  // corte, y un offset se desordena entre páginas cuando entra contenido nuevo.
  // El par (likedAt, id) sí es un orden TOTAL: dentro de un empate de likedAt el
  // id desempata, así que "la fila siguiente" está definida sin ambigüedad y
  // ninguna fila se repite ni se pierde. Prisma lo implementa con
  // `cursor: { id }` + `skip: 1`, que traduce el id a los valores de las columnas
  // del `orderBy` y compara contra el par completo.
  const orderBy: Prisma.LikedItemOrderByWithRelationInput[] =
    sort === "vitality"
      ? // `vitality` es nullable y en Postgres un DESC pone los NULL PRIMERO:
        // sin `nulls: "last"` la primera página serían señales sin vitalidad
        // calculada, justo lo contrario de "más viva primero".
        [{ vitality: { sort: "desc", nulls: "last" } }, { id: "desc" }]
      : [{ likedAt: "desc" }, { id: "desc" }];

  const where = buildPublicWhere(filters);

  // limit + 1 filas: si vuelve la de más, hay página siguiente. Evita el
  // `count()` extra solo para saber `hasMore` (el `total` sí se cuenta, pero
  // porque el contrato lo muestra en meta, no para paginar).
  // Ambas queries dentro de la MISMA `withOwner`: es lectura pura, sin llamada a
  // LLM/HTTP de por medio (CLAUDE.md §2), así que no hay riesgo de retener la
  // transacción abierta más de lo necesario.
  const [rows, total] = await withOwner(ownerId, (tx) =>
    Promise.all([
      tx.likedItem.findMany({
        where,
        select: SIGNAL_SUMMARY_SELECT,
        orderBy,
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor.id }, skip: 1 } : {}),
      }),
      tx.likedItem.count({ where }),
    ]),
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);

  return ok(page.map(toSignalSummary), {
    cache: "short",
    request,
    meta: {
      // `nextCursor` es null si y solo si `hasMore` es false.
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
