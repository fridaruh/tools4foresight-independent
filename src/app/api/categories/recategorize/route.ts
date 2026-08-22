import { NextResponse } from "next/server";
import { requireUserApi } from "@/lib/require-user";
import { withOwner } from "@/lib/tenant-db";
import { recategorizeAuto } from "@/lib/category-service";

/**
 * "Re-categorizar todo (auto)" (PLAN 4.3): limpia la categoría de todo lo que
 * puso el modelo (`category_source = 'auto'`) para que la siguiente corrida de
 * `categorize` (cron 07:00 UTC o el botón de Sistema) lo vuelva a clasificar
 * contra el catálogo vigente. Lo corregido a mano (`category_source = 'manual'`)
 * no se toca.
 *
 * Sin cooldown por servidor: no hay una columna de `user_quotas` pensada para
 * esta acción (las dos que existen, `lastManualSyncAt`/`lastGraphRefreshAt`, son
 * de otras acciones) y no toca agregar una a mitad de la Fase 4. La protección
 * contra doble click es la confirmación de dos pasos en `CategoryEditor`.
 */
export async function POST() {
  const user = await requireUserApi();
  if (user instanceof NextResponse) return user;

  const count = await withOwner(user.userId, (tx) => recategorizeAuto(tx, user.userId));
  return NextResponse.json({ ok: true, count });
}
