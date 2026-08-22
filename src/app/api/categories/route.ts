import { NextRequest, NextResponse } from "next/server";
import { requireUserApi } from "@/lib/require-user";
import { withOwner } from "@/lib/tenant-db";
import {
  CategoryServiceError,
  createCategory,
  getCategoriesOverview,
} from "@/lib/category-service";

export type CategoryOption = { name: string; count: number };

/**
 * GET: dos consumidores.
 *
 *  - `FiltersBar` (pantalla "/"): solo lee `options`/`uncategorized`, en el orden
 *    del catálogo del tenant y luego por volumen para lo que el modelo propuso.
 *    `scope=published` los recorta a lo publicado (filtro de UI).
 *  - `/categorias` (PLAN 4.3): lee `categories` (el catálogo completo, ordenado
 *    por posición, con descripción/ejemplos/fallback), `distribution` (conteo
 *    por categoría del tenant) y `proposed` (valores de `category` en
 *    `liked_items` que ya no están en la tabla `categories` — quedan tras
 *    renombrar o borrar).
 *
 * Todo dentro de `withOwner`: antes este handler leía con el `prisma` global y
 * un `where: { ownerId }` a mano, sin pasar por la barrera de RLS.
 */
export async function GET(request: NextRequest) {
  const user = await requireUserApi();
  if (user instanceof NextResponse) return user;

  const publishedOnly = request.nextUrl.searchParams.get("scope") === "published";

  const { categories, distribution, uncategorizedCount, proposed } = await withOwner(
    user.userId,
    async (tx) => {
      const overview = await getCategoriesOverview(tx, user.userId);
      if (!publishedOnly) return overview;

      // El conteo de `options` en scope=published es distinto del de `distribution`
      // (que siempre es del catálogo completo): se recalcula aparte para no mezclar
      // "cuántos tiene la categoría" con "cuántos publicados tiene".
      const publishedGrouped = await tx.likedItem.groupBy({
        by: ["category"],
        where: { ownerId: user.userId, publishStatus: "published" },
        _count: { _all: true },
      });
      const countByName = new Map(publishedGrouped.map((row) => [row.category, row._count._all]));
      const knownNames = new Set(overview.categories.map((c) => c.name));
      return {
        categories: overview.categories,
        distribution: overview.categories.map((c) => ({
          id: c.id,
          name: c.name,
          count: countByName.get(c.name) ?? 0,
        })),
        uncategorizedCount: countByName.get(null) ?? 0,
        proposed: publishedGrouped
          .filter((row): row is typeof row & { category: string } => row.category !== null)
          .filter((row) => !knownNames.has(row.category))
          .map((row) => ({ name: row.category, count: row._count._all }))
          .sort((a, b) => b.count - a.count),
      };
    },
  );

  // `options`: primero el catálogo en su orden (position), luego las propuestas
  // por volumen — el contrato que ya consume FiltersBar.
  const options: CategoryOption[] = [
    ...distribution.filter((row) => row.count > 0).map((row) => ({ name: row.name, count: row.count })),
    ...proposed,
  ];

  return NextResponse.json({
    categories,
    distribution,
    uncategorized: uncategorizedCount,
    proposed,
    options,
  });
}

/**
 * POST: crea una categoría del tenant. `position` = la más alta del tenant + 1;
 * 409 si el nombre ya existe (único por owner).
 */
export async function POST(request: NextRequest) {
  const user = await requireUserApi();
  if (user instanceof NextResponse) return user;

  const body = (await request.json().catch(() => null)) as
    | { name?: unknown; description?: unknown; examples?: unknown }
    | null;

  if (!body || typeof body.name !== "string") {
    return NextResponse.json({ error: "Falta el nombre de la categoría" }, { status: 400 });
  }

  try {
    const category = await withOwner(user.userId, (tx) =>
      createCategory(tx, user.userId, {
        name: body.name as string,
        description: typeof body.description === "string" ? body.description : "",
        examples: Array.isArray(body.examples) ? (body.examples as string[]) : [],
      }),
    );
    return NextResponse.json({ category }, { status: 201 });
  } catch (error) {
    if (error instanceof CategoryServiceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
