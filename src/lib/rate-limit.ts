/**
 * Rate limiting distribuido en Postgres usando INSERT ... ON CONFLICT.
 *
 * Como Redis/Upstash sería una dependencia adicional y la tarea es "sin Redis",
 * usamos Postgres directamente con una tabla global `rate_limits` (sin RLS) que
 * guarda el estado de los buckets.
 *
 * Que el contador viva en la base y no en un `Map` por instancia es lo que hace
 * que el límite sea GLOBAL: en serverless, dos requests de la misma persona caen
 * en lambdas distintas y un contador en memoria las contaría por separado.
 *
 * La implementación es "best-effort" en el otro sentido: si la DB falla, loguea y
 * devuelve false (fail-open). La consulta no inyecta `app.owner_id` porque esta
 * tabla NO es de tenant.
 */

import { prisma } from "@/lib/prisma";

/**
 * Ventana y tope por defecto: los de los flujos de auth (login, magic link, OAuth
 * de X, cron). Son el default de `isRateLimited` para que los llamadores que ya
 * existían no cambien de comportamiento al parametrizarse la función.
 */
const WINDOW_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;

/**
 * Opciones por llamada. Omitirlas = el bucket de auth de siempre (5 min / 5
 * intentos). La API pública pasa los suyos (ver src/lib/public-rate-limit.ts).
 */
export type RateLimitOptions = {
  /** Largo de la ventana deslizante, en ms. */
  windowMs?: number;
  /** Cuántos intentos se permiten dentro de la ventana antes de bloquear. */
  max?: number;
};

/**
 * Lo que va en el header `Retry-After` de un 429 del bucket por defecto
 * (segundos). Se mantiene exportado y con el valor de siempre porque los
 * llamadores de auth lo usan tal cual; un bucket con otra ventana calcula el suyo
 * con `rateLimitHeaders({ windowMs, max })`.
 */
export const RETRY_AFTER_SECONDS = Math.ceil(WINDOW_MS / 1000);

/**
 * Headers estándar para una respuesta 429. `Retry-After` es el que respetan los
 * clientes; los `X-RateLimit-*` son informativos y se mandan para que la UI (y
 * quien depure en producción) vea el límite sin adivinarlo.
 *
 * Sin argumentos devuelve exactamente lo de antes (5 min / 5): los llamadores de
 * auth no se enteran de que la función se parametrizó.
 */
export function rateLimitHeaders(options: RateLimitOptions = {}): Record<string, string> {
  const windowMs = options.windowMs ?? WINDOW_MS;
  const max = options.max ?? MAX_ATTEMPTS;
  return {
    "Retry-After": String(Math.ceil(windowMs / 1000)),
    "X-RateLimit-Limit": String(max),
    "X-RateLimit-Remaining": "0",
    "X-RateLimit-Reset": String(Math.floor((Date.now() + windowMs) / 1000)),
  };
}

type RateLimitRow = {
  count: number;
  window_start: Date;
};

/** Estado del bucket después de contar esta request. */
export type RateLimitState = {
  /** `true` si esta request se pasó del tope. */
  limited: boolean;
  /** Cuántas van dentro de la ventana, contando esta. */
  count: number;
  /** El tope que se aplicó (el default o el que pidió el caller). */
  limit: number;
  /** Cuántos intentos quedan antes de bloquear. Nunca negativo. */
  remaining: number;
  /** Segundos hasta que la ventana se recicle. Mínimo 1 mientras esté limitado. */
  resetSeconds: number;
};

/**
 * Cuenta una request contra un bucket y devuelve su estado completo.
 *
 * Es la versión "con detalle" de `isRateLimited`: existe porque la API pública
 * manda `X-RateLimit-Remaining`/`Reset` en CADA respuesta, no solo en el 429, y
 * esos números tienen que salir del mismo contador que tomó la decisión — si se
 * llevaran aparte (en memoria, por instancia) dirían una cosa mientras la base
 * decide otra.
 *
 * Fail-open igual que antes: si la base no responde, no se bloquea a nadie.
 */
export async function consumeRateLimit(
  key: string,
  options: RateLimitOptions = {},
): Promise<RateLimitState> {
  const windowMs = options.windowMs ?? WINDOW_MS;
  const max = options.max ?? MAX_ATTEMPTS;

  try {
    const now = new Date();
    const windowStart = new Date(now.getTime() - windowMs);

    // INSERT ... ON CONFLICT: atomicidad sin lock explicito.
    // Si la clave no existe, crea una fila con count=1.
    // Si existe, compara la ventana y resetea si es vieja; luego incrementa.
    const result = await prisma.$queryRaw<RateLimitRow[]>`
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
      RETURNING count, window_start
    `;

    const row = result?.[0];
    if (!row) {
      // No debería ocurrir, pero si pasa, fail-open.
      return openState(max, windowMs);
    }

    const resetAt = new Date(row.window_start).getTime() + windowMs;
    const limited = row.count > max;
    return {
      limited,
      count: row.count,
      limit: max,
      remaining: Math.max(0, max - row.count),
      resetSeconds: Math.max(limited ? 1 : 0, Math.ceil((resetAt - Date.now()) / 1000)),
    };
  } catch (error) {
    console.error("[rate-limit] DB error; fail-open:", error);
    // Fail-open: permitir el request si la DB no responde.
    return openState(max, windowMs);
  }
}

function openState(max: number, windowMs: number): RateLimitState {
  return {
    limited: false,
    count: 0,
    limit: max,
    remaining: max,
    resetSeconds: Math.ceil(windowMs / 1000),
  };
}

/**
 * Verifica e incrementa el contador de rate limit para una clave.
 *
 * Devuelve `true` si se ha superado el límite, `false` en otro caso.
 * Si la DB falla, loguea y devuelve `false` (fail-open).
 *
 * `options` es opcional y omitirlo conserva el bucket de siempre (5 min / 5
 * intentos), que es el que usan login, magic link, el OAuth de X y el cron.
 */
export async function isRateLimited(
  key: string,
  options: RateLimitOptions = {},
): Promise<boolean> {
  const state = await consumeRateLimit(key, options);
  return state.limited;
}

export function requestIp(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}
