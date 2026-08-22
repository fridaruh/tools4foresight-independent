/**
 * Siembra el tenant de un usuario recién creado.
 *
 * Qué deja listo:
 *   - `UserQuota` con los límites default del plan (backfill 3 meses / 3 páginas,
 *     2 páginas de X al día, 150 items de análisis al día).
 *   - El catálogo de categorías: una copia por usuario de la plantilla genérica de
 *     src/config/categories.ts, editable desde /categorias.
 *
 * Lo que NO siembra: `PromptSetting`. Esa tabla guarda solo overrides; sin fila
 * rige el default de src/lib/analysis-prompts.ts, y sembrar copias vacías haría que
 * un cambio en el default nunca llegue a los usuarios existentes.
 *
 * Corre con `withPlatformBypass` a propósito: en el hook de better-auth todavía no
 * hay sesión de la cual sacar `app.owner_id`, así que las políticas de RLS
 * rechazarían los INSERT. El bypass es LOCAL a esta transacción.
 *
 * Es idempotente (`skipDuplicates` + `upsert`): si el hook se re-dispara o alguien
 * lo corre a mano sobre una cuenta vieja, no duplica nada.
 */
import { CATEGORIES } from "@/config/categories";
import { withPlatformBypass } from "@/lib/tenant-db";

/** Cuándo se reinician los contadores diarios de la cuota. */
function nextWindowReset(from: Date = new Date()): Date {
  const reset = new Date(from);
  reset.setUTCHours(0, 0, 0, 0);
  reset.setUTCDate(reset.getUTCDate() + 1);
  return reset;
}

export async function seedTenant(userId: string): Promise<void> {
  if (!userId) throw new Error("seedTenant: falta userId");

  await withPlatformBypass(async (tx) => {
    await tx.userQuota.upsert({
      where: { userId },
      create: { userId, windowResetAt: nextWindowReset() },
      update: {},
    });

    await tx.category.createMany({
      data: CATEGORIES.map((category, index) => ({
        ownerId: userId,
        name: category.name,
        description: category.description,
        examples: category.examples,
        position: index,
        isFallback: category.isFallback ?? false,
      })),
      skipDuplicates: true,
    });
  });
}
