/**
 * Rate limiting distribuido en Postgres usando INSERT ... ON CONFLICT.
 *
 * Como Redis/Upstash sería una dependencia adicional y la tarea es "sin Redis",
 * usamos Postgres directamente con una tabla global `rate_limits` (sin RLS) que
 * guarda el estado de los buckets.
 *
 * La implementación es "best-effort": si la DB falla, losquea y devuelve false
 * (fail-open). La consulta es a nivel de transacción y no inyecta `app.owner_id`
 * porque esta tabla NO es de tenant.
 */

import { prisma } from "@/lib/prisma";

const WINDOW_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;

/** Lo que va en el header `Retry-After` de un 429 (segundos). */
export const RETRY_AFTER_SECONDS = Math.ceil(WINDOW_MS / 1000);

/**
 * Headers estándar para una respuesta 429. `Retry-After` es el que respetan los
 * clientes; los `X-RateLimit-*` son informativos y se mandan para que la UI (y
 * quien depure en producción) vea el límite sin adivinarlo.
 */
export function rateLimitHeaders(): Record<string, string> {
  return {
    "Retry-After": String(RETRY_AFTER_SECONDS),
    "X-RateLimit-Limit": String(MAX_ATTEMPTS),
    "X-RateLimit-Remaining": "0",
    "X-RateLimit-Reset": String(Math.floor((Date.now() + WINDOW_MS) / 1000)),
  };
}

type RateLimitResult = {
  count: number;
};

/**
 * Verifica e incrementa el contador de rate limit para una clave.
 *
 * Devuelve `true` si se ha superado el límite, `false` en otro caso.
 * Si la DB falla, loguea y devuelve `false` (fail-open).
 */
export async function isRateLimited(key: string): Promise<boolean> {
  try {
    const now = new Date();
    const windowStart = new Date(now.getTime() - WINDOW_MS);

    // INSERT ... ON CONFLICT: atomicidad sin lock explicito.
    // Si la clave no existe, crea una fila con count=1.
    // Si existe, compara la ventana y resetea si es vieja; luego incrementa.
    const result = await prisma.$queryRaw<RateLimitResult[]>`
      INSERT INTO rate_limits (key, count, window_start)
      VALUES (${key}, 1, ${now})
      ON CONFLICT (key) DO UPDATE SET
        count = CASE
          WHEN rate_limits.window_start < ${windowStart}
          THEN 1
          ELSE rate_limits.count + 1
        END,
        window_start = CASE
          WHEN rate_limits.window_start < ${windowStart}
          THEN ${now}
          ELSE rate_limits.window_start
        END
      RETURNING count
    `;

    if (!result || result.length === 0) {
      // No debería ocurrir, pero si pasa, fail-open.
      return false;
    }

    return result[0]!.count > MAX_ATTEMPTS;
  } catch (error) {
    console.error("[rate-limit] DB error; fail-open:", error);
    // Fail-open: permitir el request si la DB no responde.
    return false;
  }
}

export function requestIp(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}
