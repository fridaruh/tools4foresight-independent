import { consumeRateLimit } from "@/lib/rate-limit";
import type { PublicApiKey } from "@/lib/public-api-auth";

/**
 * Rate limit de la API pública.
 *
 * El origen de este código llevaba el contador en un `Map` en memoria por
 * instancia serverless y tenía anotada la deuda de que el límite era best-effort
 * entre instancias. Aquí esa deuda está saldada de gratis: el contador vive en la
 * tabla `rate_limits` de Postgres (src/lib/rate-limit.ts), así que es **global** —
 * la misma persona golpeando desde tres lambdas distintas comparte bucket. Por eso
 * tampoco hace falta el Map paralelo que el origen mantenía solo para poder mandar
 * `X-RateLimit-Remaining`: esos números salen del mismo contador que tomó la
 * decisión (`consumeRateLimit` los devuelve), y no pueden desincronizarse.
 */
const NORMAL = { windowMs: 60_000, max: 120 };
const EXPENSIVE = { windowMs: 60_000, max: 10 };

export type PublicRateLimitResult =
  | { limited: false; headers: Record<string, string> }
  | { limited: true; headers: Record<string, string>; retryAfterSeconds: number };

/**
 * Límite por dueño de la clave, no por IP: dos personas detrás del mismo NAT no se
 * estorban entre sí. `expensive` usa el bucket reducido de 10/min para endpoints
 * que hacen mucho más trabajo por request (`/graph`,
 * `/snapshots/[id]?includeMembers`); es un bucket aparte del normal, no se
 * descuenta del de 120/min.
 */
export async function checkPublicRateLimit(
  key: PublicApiKey,
  options?: { expensive?: boolean },
): Promise<PublicRateLimitResult> {
  const cfg = options?.expensive ? EXPENSIVE : NORMAL;

  // El bucket es el DUEÑO de la clave, no la clave. Una persona puede tener hasta
  // 10 claves activas y revocar/crear sin límite (src/lib/api-keys.ts): si el
  // bucket fuera `key.keyId`, su cuota real sería 10x —o ilimitada rotando— y el
  // límite dejaría de cumplir su función, que es que nadie se lleve su banco entero
  // en un bucle ni le regale la clave a un scraper.
  const bucketKey = `public${options?.expensive ? ":expensive" : ""}:${key.ownerId}`;

  const state = await consumeRateLimit(bucketKey, cfg);

  const headers: Record<string, string> = {
    "X-RateLimit-Limit": String(state.limit),
    "X-RateLimit-Remaining": String(state.remaining),
    "X-RateLimit-Reset": String(state.resetSeconds),
  };

  if (state.limited) {
    return { limited: true, headers, retryAfterSeconds: Math.max(1, state.resetSeconds) };
  }
  return { limited: false, headers };
}
