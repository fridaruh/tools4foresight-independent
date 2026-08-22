import { NextResponse } from "next/server";
import { isRateLimited, requestIp } from "@/lib/rate-limit";
import { getSessionUser } from "@/lib/require-user";

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
  return (await getSessionUser()) !== null;
}

// Solo cuenta contra el límite lo que falla: el cron de Vercel y el botón manual
// nunca caen aquí, así que no hay riesgo de bloquear tráfico legítimo.
export async function unauthorizedJobResponse(request: Request): Promise<NextResponse> {
  const limited = await isRateLimited(`job:${requestIp(request)}`);
  if (limited) {
    return NextResponse.json({ ok: false, error: "Demasiados intentos" }, { status: 429 });
  }
  return NextResponse.json({ ok: false, error: "No autorizado" }, { status: 401 });
}

/**
 * ¿Es la request del cron de Vercel (o de alguien con el secreto)?
 *
 * Es la puerta del DISPATCHER (`POST /api/jobs/<job>`), que no corre para un
 * tenant sino para todos: no acepta sesión de usuario, porque un usuario no
 * tiene por qué poder disparar el pipeline de los demás. El botón manual de la
 * UI pega a `…/run`, que sí acepta sesión y queda acotado a su propio owner.
 */
export function isCronRequest(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export type JobRequest =
  | { ok: true; ownerId: string; isCron: boolean }
  | { ok: false; response: NextResponse };

/**
 * De qué tenant es esta corrida.
 *
 * Dos caminos, y ninguno acepta un owner sin credencial:
 *   - con `Authorization: Bearer <CRON_SECRET>`: el tenant viene en `?owner=<userId>`.
 *     Solo quien tiene el secreto del cron puede correr un job de otra persona.
 *   - con sesión de usuario (el botón de /conexion): el tenant ES el de la sesión;
 *     un `?owner=` de otro usuario se rechaza con 403.
 *
 * Quien llena el `?owner=` es el dispatcher (`/api/jobs/<job>`, PLAN 3.11): el
 * cron de Vercel le pega a él, no a `…/run`, y él hace fan-out con este mismo
 * header más el owner de cada tenant.
 */
export async function resolveJobRequest(request: Request): Promise<JobRequest> {
  const secret = process.env.CRON_SECRET;
  const requestedOwner = new URL(request.url).searchParams.get("owner");

  if (secret && request.headers.get("authorization") === `Bearer ${secret}`) {
    if (!requestedOwner) {
      return {
        ok: false,
        response: NextResponse.json(
          {
            ok: false,
            error:
              "Falta ?owner=<userId>: los jobs son por tenant. El dispatcher que lo llena llega en la Fase 3.",
          },
          { status: 400 },
        ),
      };
    }
    return { ok: true, ownerId: requestedOwner, isCron: true };
  }

  const user = await getSessionUser();
  if (!user) return { ok: false, response: await unauthorizedJobResponse(request) };

  if (requestedOwner && requestedOwner !== user.userId) {
    return {
      ok: false,
      response: NextResponse.json({ ok: false, error: "No autorizado" }, { status: 403 }),
    };
  }

  return { ok: true, ownerId: user.userId, isCron: false };
}
