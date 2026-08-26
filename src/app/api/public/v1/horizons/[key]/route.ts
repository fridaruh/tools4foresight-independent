/**
 * `GET /api/public/v1/horizons/{key}` — un horizonte con sus temas vivos.
 *
 * Una clave fuera de H1/H2/H3 devuelve 400, no 404: el conjunto es cerrado y
 * conocido (H1/H2/H3), así que "H4" no es un recurso que falte sino un
 * parámetro inválido.
 */
import type { NextRequest } from "next/server";
import { PublicApiError } from "@/lib/public-api-auth";
import { handleOptions, ok, withPublicApi } from "@/lib/public-api-response";
import { withOwner } from "@/lib/tenant-db";
import { isHorizon } from "@/lib/horizons";
import { THEME_SELECT, toHorizon, toThemeSummary } from "@/lib/public-dto";
import { horizonCounts, macroThemesByHorizon } from "@/lib/public-horizons";

export const runtime = "nodejs";

async function handler(
  request: NextRequest,
  { params }: { params: Promise<{ key: string }> },
  { ownerId }: { ownerId: string; keyId: string },
) {
  const { key } = await params;

  if (!isHorizon(key)) {
    throw new PublicApiError("invalid_parameter", 'El horizonte debe ser H1, H2 o H3.', 400, "key");
  }

  // Misma transacción para las tres lecturas — mismo motivo que en `/horizons`:
  // `horizonCounts`/`macroThemesByHorizon` no abren la suya, y el `findMany` de
  // temas vivos del horizonte pertenece a la misma respuesta.
  const { counts, macros, themes } = await withOwner(ownerId, async (tx) => {
    const [counts, macros, themes] = await Promise.all([
      horizonCounts(tx, ownerId),
      macroThemesByHorizon(tx, ownerId, true),
      tx.semanticCluster.findMany({
        where: { ownerId, status: "alive", horizon: key },
        select: THEME_SELECT,
        orderBy: [{ vitality: "desc" }, { id: "desc" }],
      }),
    ]);
    return { counts, macros, themes };
  });

  const horizon = toHorizon({
    key,
    themeCount: counts[key].themeCount,
    signalCount: counts[key].signalCount,
    vitalitySum: counts[key].vitalitySum,
    macroThemes: macros[key],
  });

  return ok({ ...horizon, themes: themes.map(toThemeSummary) }, { cache: "graph", request });
}

export const GET = withPublicApi(handler);

export function OPTIONS(request: Request) {
  return handleOptions(request);
}
