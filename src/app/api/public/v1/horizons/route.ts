/**
 * `GET /api/public/v1/horizons` — panorama de los tres horizontes del banco de
 * quien hace la llamada.
 *
 * Devuelve SIEMPRE los tres, aunque alguno esté vacío (conteos en 0): un horizonte
 * sin temas es información —"no hay nada consolidado todavía"—, no una ausencia.
 */
import type { NextRequest } from "next/server";
import { handleOptions, ok, withPublicApi } from "@/lib/public-api-response";
import { withOwner } from "@/lib/tenant-db";
import { HORIZONS } from "@/lib/horizons";
import { toHorizon } from "@/lib/public-dto";
import { horizonCounts, macroThemesByHorizon } from "@/lib/public-horizons";

export const runtime = "nodejs";

async function handler(
  request: NextRequest,
  _ctx: unknown,
  { ownerId }: { ownerId: string; keyId: string },
) {
  // `horizonCounts`/`macroThemesByHorizon` reciben un `tx` y no abren su propia
  // transacción (contrato de public-horizons.ts): las dos van dentro de la MISMA
  // `withOwner`, no una cada una — dos `withOwner` sueltas gastarían dos
  // conexiones del pooler de Neon para armar una sola respuesta.
  const { counts, macros } = await withOwner(ownerId, async (tx) => {
    const [counts, macros] = await Promise.all([
      horizonCounts(tx, ownerId),
      macroThemesByHorizon(tx, ownerId, false),
    ]);
    return { counts, macros };
  });

  const data = HORIZONS.map((key) =>
    toHorizon({
      key,
      themeCount: counts[key].themeCount,
      signalCount: counts[key].signalCount,
      vitalitySum: counts[key].vitalitySum,
      macroThemes: macros[key],
    }),
  );

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
