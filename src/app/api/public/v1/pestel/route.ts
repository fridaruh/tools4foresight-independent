/**
 * `GET /api/public/v1/pestel` — las seis dimensiones PESTEL con su conteo de
 * señales, dentro del banco de quien hace la llamada.
 *
 * Cada señal lleva HASTA DOS dimensiones, así que la suma de `signalCount` puede
 * superar el total de señales del banco. No es un error de conteo: es que una
 * señal sobre regulación de IA cuenta a la vez en Legal y en Tecnológico.
 *
 * El origen filtraba con `PUBLISHED_ONLY` (solo señales publicadas). Esa
 * constante no existe aquí (PLAN_MCP §0.2): se cuenta el banco completo, igual
 * que `horizonCounts` (public-horizons.ts) y `getCategoriesOverview`
 * (category-service.ts) ya hacen para sus propios agregados — consistencia
 * entre los tres endpoints de taxonomía/agregados de este grupo.
 */
import type { NextRequest } from "next/server";
import { handleOptions, ok, withPublicApi } from "@/lib/public-api-response";
import { withOwner } from "@/lib/tenant-db";
import { PESTEL_DIMENSIONS } from "@/config/pestel";
import { toPestel } from "@/lib/public-dto";

export const runtime = "nodejs";

async function handler(
  request: NextRequest,
  _ctx: unknown,
  { ownerId }: { ownerId: string; keyId: string },
) {
  // `pestel` es un String[] de Postgres: `has` traduce a `= ANY(...)`, así que
  // son seis conteos baratos en la base en vez de traer todas las filas y contar
  // en memoria. `ownerId` va en el `where` de cada uno (CLAUDE.md §1) aunque RLS
  // ya lo garantice dentro de `withOwner`: es la barrera de aplicación escrita a
  // mano, porque aquí el cliente es un `tx` pelado (mismo patrón que
  // public-horizons.ts).
  const counts = await withOwner(ownerId, (tx) =>
    Promise.all(
      PESTEL_DIMENSIONS.map((dimension) =>
        tx.likedItem.count({ where: { ownerId, pestel: { has: dimension.key } } }),
      ),
    ),
  );

  const data = PESTEL_DIMENSIONS.map((dimension, index) => toPestel(dimension, counts[index] ?? 0));

  return ok(data, {
    cache: "static",
    request,
    meta: { count: data.length, total: data.length, hasMore: false, nextCursor: null },
  });
}

export const GET = withPublicApi(handler);

export function OPTIONS(request: Request) {
  return handleOptions(request);
}
