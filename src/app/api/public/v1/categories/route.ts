/**
 * `GET /api/public/v1/categories` — catálogo de categorías del tenant, con su
 * conteo de señales.
 *
 * `LikedItem.category` es un String libre, NO una foreign key: el modelo puede
 * proponer una categoría que todavía no está en el catálogo curado. Eso es una
 * feature (así se descubren categorías nuevas), no un bug — por eso salen aquí
 * marcadas con `inCatalog: false` en vez de omitirse.
 *
 * --- Diferencia con el origen -------------------------------------------------
 * El origen (single-tenant) tenía su propia `getCategoriesOverview` en
 * `category-service.ts`, con un parámetro `publishedOnly: boolean` que aquí
 * llamaba con `true` (solo contaba señales publicadas). Este repo ya tenía su
 * PROPIA `category-service.ts` de antes (PLAN 4.3, CRUD de `/categorias`), con
 * una firma distinta: `getCategoriesOverview(tx, ownerId)`, sin ese parámetro —
 * siempre cuenta el catálogo completo del tenant. No hubo que forzar el
 * contrato del origen: la firma que ya existe aquí es exactamente la que
 * corresponde bajo PLAN_MCP §0.2 (sin `PUBLISHED_ONLY`, la persona ve su banco
 * entero), así que se reutiliza tal cual, solo envuelta en `withOwner`.
 * -------------------------------------------------------------------------------
 */
import type { NextRequest } from "next/server";
import { handleOptions, ok, withPublicApi } from "@/lib/public-api-response";
import { withOwner } from "@/lib/tenant-db";
import { getCategoriesOverview } from "@/lib/category-service";
import { toCategory, type CategoryDTO } from "@/lib/public-dto";

export const runtime = "nodejs";

async function handler(
  request: NextRequest,
  _ctx: unknown,
  { ownerId }: { ownerId: string; keyId: string },
) {
  const overview = await withOwner(ownerId, (tx) => getCategoriesOverview(tx, ownerId));

  const countByName = new Map(overview.distribution.map((row) => [row.name, row.count]));

  const fromCatalog: CategoryDTO[] = overview.categories.map((category) => ({
    name: category.name,
    description: category.description,
    examples: category.examples,
    position: category.position,
    isFallback: category.isFallback,
    signalCount: countByName.get(category.name) ?? 0,
    inCatalog: true,
  }));

  // Propuestas por el modelo: no hay fila de catálogo detrás, así que no tienen
  // descripción ni ejemplos. `position: -1` las deja fuera del orden curado.
  const proposed: CategoryDTO[] = overview.proposed.map((row) => ({
    name: row.name,
    description: "",
    examples: [],
    position: -1,
    isFallback: false,
    signalCount: row.count,
    inCatalog: false,
  }));

  const data = [...fromCatalog, ...proposed].map(toCategory);

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
