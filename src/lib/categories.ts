// Catálogo de categorías DEL TENANT (tabla `categories`, Fase 3).
//
// Reemplaza a src/config/categories.ts como fuente para el pipeline: cada usuario
// tiene su propia copia (sembrada por src/lib/seed-tenant.ts) y la edita desde
// /categorias. `loadCategories` es la única forma correcta de leerla — siempre
// dentro de `withOwner`, como cualquier lectura de tenant (ver src/lib/tenant-db.ts).

import type { Category } from "@/generated/prisma/client";
import type { TenantTx } from "@/lib/tenant-db";

/** El catálogo completo del tenant, en el orden en que se muestra en /categorias. */
export async function loadCategories(tx: TenantTx, ownerId: string): Promise<Category[]> {
  return tx.category.findMany({
    where: { ownerId },
    orderBy: { position: "asc" },
  });
}

/**
 * La categoría a la que cae lo que el modelo no supo clasificar ("Otros" en la
 * plantilla de seed, pero el usuario puede renombrarla o mover el flag).
 *
 * Si por lo que sea ningún registro tiene `isFallback` (catálogo editado a mano
 * sin dejar una marcada), se usa la última del orden como mejor esfuerzo en vez
 * de fallar: el fallback es una degradación aceptable, nunca debe tumbar la
 * categorización de todo un lote.
 */
export function fallbackCategory(categories: Category[]): Category | undefined {
  return categories.find((c) => c.isFallback) ?? categories[categories.length - 1];
}
