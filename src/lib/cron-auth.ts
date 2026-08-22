import { NextResponse } from "next/server";
import { isRateLimited, requestIp } from "@/lib/rate-limit";
import { getEffectiveRole } from "@/lib/require-admin";

// Los endpoints de /api/jobs/* quedan fuera del matcher del proxy porque Vercel
// los invoca sin cookie de sesion (manda `Authorization: Bearer <CRON_SECRET>`).
// Pero el botón "Correr los jobs a mano" de /conexion (RunPipelineButton) llama a
// estos mismos endpoints desde el navegador, así que tambien aceptan una sesión
// de usuario para no romper ese flujo.
export async function isJobRequestAuthorized(request: Request): Promise<boolean> {
  const secret = process.env.CRON_SECRET;
  if (secret && request.headers.get("authorization") === `Bearer ${secret}`) {
    return true;
  }
  return (await getEffectiveRole()) !== null;
}

// Solo cuenta contra el límite lo que falla: el cron de Vercel y el botón manual
// nunca caen aquí, así que no hay riesgo de bloquear tráfico legítimo.
export function unauthorizedJobResponse(request: Request): NextResponse {
  if (isRateLimited(`job:${requestIp(request)}`)) {
    return NextResponse.json({ ok: false, error: "Demasiados intentos" }, { status: 429 });
  }
  return NextResponse.json({ ok: false, error: "No autorizado" }, { status: 401 });
}
