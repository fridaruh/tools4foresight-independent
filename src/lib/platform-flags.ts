/**
 * Flags globales de la plataforma (`platform_flags`, sin RLS: no es una tabla
 * de tenant, la comparten todos).
 *
 * Hoy solo hay uno: `x_credits_depleted`. La X App es UNA sola compartida por
 * todos los tenants (PLAN §0), asi que si X responde 402 / "credits depleted"
 * no es un problema del tenant que estaba corriendo en ese momento — es que se
 * acabo el saldo de la app entera. El flag se prende ahi y se apaga solo
 * cuando alguna corrida de ingesta vuelve a completarse sin errores.
 */
import { withPlatformBypass } from "@/lib/tenant-db";
import { sendAdminAlert } from "@/lib/alerts";

const X_CREDITS_DEPLETED_KEY = "x_credits_depleted";

export async function isXCreditsDepleted(): Promise<boolean> {
  const flag = await withPlatformBypass((tx) =>
    tx.platformFlag.findUnique({ where: { key: X_CREDITS_DEPLETED_KEY } }),
  );
  return flag !== null;
}

/**
 * Prende el flag global. Se llama cuando X devuelve XCreditsDepleted (402).
 *
 * También dispara la alerta a Frida (PLAN 5.2a): la X App es una sola,
 * compartida por todos los tenants, así que esto pausa la ingesta de TODOS —
 * es justo el tipo de cosa que no debería esperar a que alguien note el banner
 * en /conexion.
 */
export async function markXCreditsDepleted(): Promise<void> {
  const value = new Date().toISOString();
  await withPlatformBypass((tx) =>
    tx.platformFlag.upsert({
      where: { key: X_CREDITS_DEPLETED_KEY },
      create: { key: X_CREDITS_DEPLETED_KEY, value },
      update: { value },
    }),
  );
  await sendAdminAlert(
    "x_credits_depleted",
    "Créditos de X agotados",
    `La cuenta de X compartida se quedó sin créditos de API el ${value}. La ingesta de todos los tenants está pausada hasta que se recargue o se limpie el flag desde /admin.`,
  );
}

/** Apaga el flag global. Se llama al completar una corrida de ingesta sin error. */
export async function clearXCreditsDepleted(): Promise<void> {
  await withPlatformBypass((tx) =>
    tx.platformFlag.deleteMany({ where: { key: X_CREDITS_DEPLETED_KEY } }),
  );
}
