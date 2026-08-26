/**
 * #10 `GET /api/public/v1/macro-themes` — macro-temas (agrupación de 2º nivel).
 *
 * OJO: a diferencia de un tema, un macro-tema NO tiene linaje. El job del grafo los
 * borra y los recrea enteros en cada corrida (rebuildMacroClusters), así que sus
 * ids NO son estables entre corridas: sirven para navegar la respuesta actual, no
 * para guardarlos y volver a pedirlos mañana. Máximo 5 por horizonte.
 */
import type { NextRequest } from "next/server";
import { withOwner } from "@/lib/tenant-db";
import { PublicApiError } from "@/lib/public-api-auth";
import { handleOptions, ok, withPublicApi } from "@/lib/public-api-response";
import { MACRO_THEME_SELECT, toMacroTheme } from "@/lib/public-dto";
import { isHorizon } from "@/lib/horizons";

// Prisma con @prisma/adapter-pg no corre en edge. Obligatorio en toda la API pública.
export const runtime = "nodejs";

async function handler(
  request: NextRequest,
  _ctx: unknown,
  { ownerId }: { ownerId: string; keyId: string },
) {
  const rawHorizon = request.nextUrl.searchParams.get("horizon");
  if (rawHorizon && !isHorizon(rawHorizon)) {
    throw new PublicApiError("invalid_parameter", 'El parámetro "horizon" debe ser H1, H2 o H3.', 400, "horizon");
  }

  // `macro_clusters` y su relación `clusters` (SemanticCluster) llevan `owner_id`:
  // ambas quedan acotadas por RLS dentro de esta transacción, sin filtro adicional.
  const macros = await withOwner(ownerId, (tx) =>
    tx.macroCluster.findMany({
      where: rawHorizon ? { horizon: rawHorizon } : undefined,
      select: MACRO_THEME_SELECT,
      orderBy: [{ horizon: "asc" }, { name: "asc" }],
    }),
  );

  const data = macros.map(toMacroTheme);

  return ok(data, {
    cache: "graph",
    request,
    meta: { count: data.length, hasMore: false, nextCursor: null, total: data.length },
  });
}

export const GET = withPublicApi(handler);

export function OPTIONS(request: Request) {
  return handleOptions(request);
}
