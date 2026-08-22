/**
 * Cuotas diarias por tenant (`user_quotas` / `usage_events`).
 *
 * `reserveQuota` es la única forma correcta de gastar cupo: reserva ANTES de
 * pagar el costo real (una página de X, un item analizado), nunca después. Es
 * atómica vía un `UPDATE ... WHERE used + n <= limit RETURNING` — dos
 * corridas concurrentes del mismo tenant no pueden las dos leer "me queda 1" y
 * las dos escribir de más; solo una gana la fila.
 *
 * Ambas funciones reciben `tx` (un `TenantTx` de `withOwner`) en vez de abrir su
 * propia transacción: quien llama decide el alcance — normalmente todo el job
 * corre dentro de un único `withOwner(ownerId, tx => ...)`.
 */
import type { TenantTx } from "@/lib/tenant-db";

export type QuotaKind = "x_pages" | "analyze_items";

/** Cuándo se reinician los contadores diarios de la cuota (00:00 UTC del día siguiente). */
function nextWindowReset(from: Date): Date {
  const reset = new Date(from);
  reset.setUTCHours(0, 0, 0, 0);
  reset.setUTCDate(reset.getUTCDate() + 1);
  return reset;
}

/**
 * Reserva `n` unidades de cupo de `kind` para `userId`, atómicamente.
 *
 * Primero, si la ventana ya venció (`windowResetAt` quedó en el pasado),
 * resetea los contadores del día y corre `windowResetAt` al próximo 00:00 UTC.
 * Después intenta el `UPDATE` condicionado: si el uso + `n` no rebasa el
 * límite, lo escribe y devuelve `true`; si no hay cupo, no toca nada y
 * devuelve `false`.
 *
 * DEBE llamarse dentro de `withOwner(userId, tx => reserveQuota(tx, userId, ...))`.
 */
export async function reserveQuota(
  tx: TenantTx,
  userId: string,
  kind: QuotaKind,
  n: number,
): Promise<boolean> {
  const now = new Date();

  const quota = await tx.userQuota.findUnique({ where: { userId } });
  if (!quota) return false;

  if (quota.windowResetAt.getTime() < now.getTime()) {
    // Condicionado por windowResetAt: si dos llamadas concurrentes ven la
    // ventana vencida, solo una hace el reset (la otra afecta 0 filas y sigue
    // con el intento de reserva de abajo, que ya ve los contadores en 0).
    await tx.userQuota.updateMany({
      where: { userId, windowResetAt: quota.windowResetAt },
      data: {
        xPagesUsedToday: 0,
        analyzeUsedToday: 0,
        windowResetAt: nextWindowReset(now),
      },
    });
  }

  const reserved =
    kind === "x_pages"
      ? await tx.$queryRaw<Array<{ user_id: string }>>`
          UPDATE user_quotas
          SET x_pages_used_today = x_pages_used_today + ${n}
          WHERE user_id = ${userId}
            AND x_pages_used_today + ${n} <= x_pages_per_day
          RETURNING user_id`
      : await tx.$queryRaw<Array<{ user_id: string }>>`
          UPDATE user_quotas
          SET analyze_used_today = analyze_used_today + ${n}
          WHERE user_id = ${userId}
            AND analyze_used_today + ${n} <= analyze_items_per_day
          RETURNING user_id`;

  return reserved.length > 0;
}

/** Registra una llamada externa (auditoría de costo por tenant). */
export async function recordUsage(
  tx: TenantTx,
  userId: string,
  kind: string,
  units: number,
  tokensIn?: number,
  tokensOut?: number,
): Promise<void> {
  await tx.usageEvent.create({
    data: {
      userId,
      kind,
      units,
      tokensIn: tokensIn ?? null,
      tokensOut: tokensOut ?? null,
    },
  });
}
