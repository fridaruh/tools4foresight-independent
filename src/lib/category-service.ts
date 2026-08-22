/**
 * Lógica del CRUD de categorías (PLAN 4.3), extraída de las routes para poder
 * probarla sin HTTP (ver scripts/qa-categories.ts).
 *
 * Todas las funciones reciben `tx` (un `TenantTx`, ver src/lib/tenant-db.ts) y
 * `ownerId`: el caller es responsable de abrir la transacción con `withOwner`.
 * Ninguna función de aquí abre su propia transacción — eso permite componerlas
 * dentro de una sola (p. ej. "renombrar y releer" en la misma tx) y es lo que
 * las hace testeables contra un tenant real de QA sin pasar por una route.
 */
import type { Category } from "@/generated/prisma/client";
import type { TenantTx } from "@/lib/tenant-db";

/** Error de servicio con el status HTTP que la route debe devolver. */
export class CategoryServiceError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "CategoryServiceError";
    this.status = status;
  }
}

export type CategoryDistributionRow = {
  id: string;
  name: string;
  count: number;
};

export type ProposedCategory = {
  name: string;
  count: number;
};

export type CategoriesOverview = {
  categories: Category[];
  distribution: CategoryDistributionRow[];
  uncategorizedCount: number;
  proposed: ProposedCategory[];
};

/** Sólo strings no vacíos, recortados. Así una textarea con líneas en blanco no las guarda. */
function sanitizeExamples(examples: unknown): string[] {
  if (!Array.isArray(examples)) return [];
  return examples
    .filter((e): e is string => typeof e === "string")
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
}

/**
 * El catálogo del tenant (orden de posición) + cuántos `liked_items` tiene cada
 * categoría + las "propuestas": valores de `liked_items.category` que no están
 * en la tabla `categories` del tenant. Esto último pasa cuando el usuario
 * renombra o borra una categoría después de que el modelo ya la usó para
 * clasificar (el modelo solo puede devolver categorías del catálogo vigente al
 * momento de correr, pero el catálogo pudo cambiar desde entonces).
 */
export async function getCategoriesOverview(
  tx: TenantTx,
  ownerId: string,
): Promise<CategoriesOverview> {
  const [categories, grouped] = await Promise.all([
    tx.category.findMany({ where: { ownerId }, orderBy: { position: "asc" } }),
    tx.likedItem.groupBy({
      by: ["category"],
      where: { ownerId },
      _count: { _all: true },
    }),
  ]);

  const countByName = new Map<string | null, number>(
    grouped.map((row) => [row.category, row._count._all]),
  );
  const knownNames = new Set(categories.map((c) => c.name));

  const distribution: CategoryDistributionRow[] = categories.map((c) => ({
    id: c.id,
    name: c.name,
    count: countByName.get(c.name) ?? 0,
  }));

  const uncategorizedCount = countByName.get(null) ?? 0;

  const proposed: ProposedCategory[] = grouped
    .filter((row): row is typeof row & { category: string } => row.category !== null)
    .filter((row) => !knownNames.has(row.category))
    .map((row) => ({ name: row.category, count: row._count._all }))
    .sort((a, b) => b.count - a.count);

  return { categories, distribution, uncategorizedCount, proposed };
}

export type CreateCategoryInput = {
  name: string;
  description?: string;
  examples?: string[];
};

/** `position` = la más alta del tenant + 1. Nombre único por owner (409 si choca). */
export async function createCategory(
  tx: TenantTx,
  ownerId: string,
  input: CreateCategoryInput,
): Promise<Category> {
  const name = input.name?.trim() ?? "";
  if (!name) throw new CategoryServiceError("Falta el nombre de la categoría", 400);

  const existing = await tx.category.findFirst({ where: { ownerId, name } });
  if (existing) {
    throw new CategoryServiceError("Ya existe una categoría con ese nombre", 409);
  }

  const max = await tx.category.aggregate({ where: { ownerId }, _max: { position: true } });
  const position = (max._max.position ?? -1) + 1;

  return tx.category.create({
    data: {
      ownerId,
      name,
      description: input.description?.trim() ?? "",
      examples: sanitizeExamples(input.examples),
      position,
      isFallback: false,
    },
  });
}

export type UpdateCategoryPatch = {
  name?: string;
  description?: string;
  examples?: string[];
  position?: number;
  isFallback?: boolean;
};

/**
 * Edita una categoría del tenant. Si `isFallback: true`, desmarca cualquier otra
 * fallback del mismo tenant en la misma transacción (solo puede haber una). Si
 * cambia el nombre, renombra también `liked_items.category` del owner para que
 * los items ya clasificados no queden huérfanos.
 */
export async function updateCategory(
  tx: TenantTx,
  ownerId: string,
  id: string,
  patch: UpdateCategoryPatch,
): Promise<Category> {
  const current = await tx.category.findFirst({ where: { id, ownerId } });
  if (!current) throw new CategoryServiceError("Categoría no encontrada", 404);

  const data: Record<string, unknown> = {};
  let nextName: string | null = null;

  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw new CategoryServiceError("El nombre no puede quedar vacío", 400);
    if (name !== current.name) {
      const dup = await tx.category.findFirst({
        where: { ownerId, name, id: { not: id } },
      });
      if (dup) throw new CategoryServiceError("Ya existe una categoría con ese nombre", 409);
      nextName = name;
    }
    data.name = name;
  }

  if (patch.description !== undefined) data.description = patch.description.trim();
  if (patch.examples !== undefined) data.examples = sanitizeExamples(patch.examples);
  if (patch.position !== undefined) data.position = patch.position;
  if (patch.isFallback !== undefined) data.isFallback = patch.isFallback;

  if (Object.keys(data).length === 0) {
    throw new CategoryServiceError("Nada que actualizar", 400);
  }

  // Solo una fallback por tenant: marcar esta desmarca a las demás, en la misma tx.
  if (patch.isFallback === true) {
    await tx.category.updateMany({
      where: { ownerId, isFallback: true, id: { not: id } },
      data: { isFallback: false },
    });
  }

  const updated = await tx.category.update({ where: { id }, data });

  if (nextName) {
    await tx.likedItem.updateMany({
      where: { ownerId, category: current.name },
      data: { category: nextName },
    });
  }

  return updated;
}

/**
 * Borra una categoría del tenant. 409 si es la fallback (siempre debe quedar
 * una). Los items que la tenían quedan `category = null, categorySource =
 * 'auto'` para que la siguiente corrida de `categorize` los reclasifique.
 */
export async function deleteCategory(tx: TenantTx, ownerId: string, id: string): Promise<void> {
  const current = await tx.category.findFirst({ where: { id, ownerId } });
  if (!current) throw new CategoryServiceError("Categoría no encontrada", 404);
  if (current.isFallback) {
    throw new CategoryServiceError("No se puede borrar la categoría de fallback", 409);
  }

  await tx.likedItem.updateMany({
    where: { ownerId, category: current.name },
    data: { category: null, categorySource: "auto" },
  });

  await tx.category.delete({ where: { id } });
}

/**
 * "Re-categorizar todo (auto)": limpia la categoría de todo lo que el modelo
 * puso (`categorySource = 'auto'`), respetando lo corregido a mano. La
 * siguiente corrida del job `categorize` (cron 07:00 UTC o botón manual) vuelve
 * a clasificar lo que queda en null.
 */
export async function recategorizeAuto(tx: TenantTx, ownerId: string): Promise<number> {
  const count = await tx.$executeRaw`
    UPDATE liked_items
    SET category = NULL,
        category_confidence = NULL,
        category_reasoning = NULL,
        categorized_at = NULL
    WHERE owner_id = ${ownerId} AND category_source = 'auto'
  `;
  return count;
}
