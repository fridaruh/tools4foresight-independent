import { NextResponse } from "next/server";
import { requirePlatformAdminApi } from "@/lib/require-user";
import { markXCreditsDepleted } from "@/lib/platform-flags";

/**
 * `POST /api/admin/flags/x-credits/mark` (PLAN 5.1): botón "Marcar agotados"
 * del panel — pausa la ingesta de todos los tenants a mano, sin esperar a que
 * X devuelva el 402. Útil si Frida ve el saldo bajo desde el dashboard de X y
 * prefiere cortar antes de que falle en caliente. Pasa por el mismo camino que
 * el 402 real, así que también dispara la alerta (PLAN 5.2a).
 */
export async function POST() {
  const admin = await requirePlatformAdminApi();
  if (admin instanceof NextResponse) return admin;

  await markXCreditsDepleted();
  return NextResponse.json({ ok: true, xCreditsDepleted: true });
}
