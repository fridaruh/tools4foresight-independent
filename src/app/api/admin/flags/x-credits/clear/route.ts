import { NextResponse } from "next/server";
import { requirePlatformAdminApi } from "@/lib/require-user";
import { clearXCreditsDepleted } from "@/lib/platform-flags";

/**
 * `POST /api/admin/flags/x-credits/clear` (PLAN 5.1): botón "Limpiar flag" del
 * panel. Se usa cuando Frida ya recargó créditos en la X App compartida y no
 * quiere esperar a que una ingesta exitosa lo apague sola.
 */
export async function POST() {
  const admin = await requirePlatformAdminApi();
  if (admin instanceof NextResponse) return admin;

  await clearXCreditsDepleted();
  return NextResponse.json({ ok: true, xCreditsDepleted: false });
}
