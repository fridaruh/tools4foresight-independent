import { NextResponse } from "next/server";
import { isRateLimited, requestIp } from "@/lib/rate-limit";
import { resolveApiKey } from "@/lib/api-keys";
import type { ErrorCode } from "@/lib/public-api-response";

/**
 * Autenticación de `/api/public/v1` y del MCP remoto.
 *
 * Una sola fuente de claves: la tabla `api_keys` (src/lib/api-keys.ts). El origen
 * de este código tenía además claves de entorno (`T4F_PUBLIC_API_KEYS`) y aquí se
 * eliminaron por completo — PLAN_MCP §0.1: una clave sin dueño no tiene banco que
 * leer, así que sería una puerta sin tenant. Con ella se fue el 503 `api_disabled`
 * que dependía de esa variable: en este repo la API está habilitada siempre que
 * haya base, y una clave que no resuelve es un 401, no un "servicio apagado".
 */

/**
 * Una clave autorizada. Siempre tiene dueño — no hay unión env/usuario que
 * discriminar.
 *
 * `keyId` identifica la FILA de `api_keys`: es lo único que se loguea (la clave
 * cruda nunca sale de este módulo, y el email del dueño tampoco entra a un log).
 * `ownerId` es el tenant: todo lo que el handler lea después pasa por
 * `withOwner(ownerId, …)`, y es también el bucket del rate limit
 * (public-rate-limit.ts).
 */
export type PublicApiKey = {
  keyId: string;
  ownerId: string;
};

/**
 * Error tipado de toda la API pública: cualquier capa (auth, cursor, filtros, un
 * route handler) lanza uno de estos y `withPublicApi` (public-api-response.ts) lo
 * traduce al `{ error }` con el status/code correctos. Así ningún handler
 * individual tiene que acordarse del mapeo.
 */
export class PublicApiError extends Error {
  status: number;
  code: ErrorCode;
  param: string | null;

  constructor(code: ErrorCode, message: string, status: number, param: string | null = null) {
    super(message);
    this.name = "PublicApiError";
    this.code = code;
    this.status = status;
    this.param = param;
  }
}

// "v1" duplicado a propósito. `public-api-response.ts` importa de este archivo
// (PublicApiError, requirePublicApiKey) para armar `withPublicApi`, así que este
// archivo no puede importar en tiempo de ejecución nada de allá sin crear un ciclo
// de módulos. La versión está congelada por diseño (v1 congelado; cambios
// rompientes -> v2), así que duplicar el literal es más simple y más seguro que
// forzar el ciclo.
const API_VERSION = "v1";

function errorResponse(code: ErrorCode, message: string, status: number): NextResponse {
  const response = NextResponse.json(
    {
      error: { code, message, param: null },
      meta: { apiVersion: API_VERSION, generatedAt: new Date().toISOString() },
    },
    { status },
  );
  response.headers.set("Content-Type", "application/json; charset=utf-8");
  // Un error nunca se cachea: menos todavía el 401 de una clave recién revocada.
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("X-T4F-Api-Version", API_VERSION);
  response.headers.set("Vary", "Authorization, Origin");
  return response;
}

/**
 * `{ key }` si autoriza; si no, la `NextResponse` de error ya lista para devolver
 * (nunca `null`: quien llama solo tiene que mirar el tipo del resultado). Nunca
 * "abierto por defecto".
 *
 * Es `async` porque la única fuente de claves vive en Postgres. La consulta solo
 * la pagan las claves que empiezan con `t4f_` — `resolveApiKey` corta antes si no.
 */
export async function requirePublicApiKey(
  request: Request,
): Promise<{ key: PublicApiKey } | NextResponse> {
  const authHeader = request.headers.get("authorization");
  const token = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();

  // Falta la cabecera vs. la cabecera trae una clave que no vale: dos códigos
  // distintos porque son dos errores de cliente distintos. Al primero le falta
  // configuración; el segundo tiene una clave vieja, revocada o de otro sitio.
  if (!token) {
    return errorResponse("unauthorized", "Falta la cabecera Authorization: Bearer <api-key>.", 401);
  }

  const resolved = await resolveApiKey(token);
  if (resolved) {
    return { key: { keyId: resolved.keyId, ownerId: resolved.ownerId } };
  }

  // Bearer presente pero no resuelve a ninguna clave: solo pasa por fuerza bruta o
  // por una clave vieja/revocada. Aparte del 401, cuenta contra un límite por IP —
  // no por clave: todavía no tiene una que perder, así que el bucket por dueño de
  // public-rate-limit.ts no aplica aquí.
  if (await isRateLimited(`public-api:${requestIp(request)}`, { windowMs: 60_000, max: 10 })) {
    return errorResponse(
      "rate_limited",
      "Demasiados intentos con una clave inválida desde esta IP. Espera un minuto.",
      429,
    );
  }

  return errorResponse("invalid_api_key", "La clave de API no es válida.", 401);
}
