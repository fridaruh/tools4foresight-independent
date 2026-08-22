/**
 * Alertas a Frida por email (PLAN Fase 5, tarea 5.2).
 *
 * `sendAdminAlert(kind, subject, body)` es el único punto de salida: quien la
 * llama no sabe (ni le importa) si el correo se mandó, se dedupe o solo se
 * logueó. Los tres disparadores del plan —créditos de X agotados, 5 corridas
 * seguidas en error de un tenant, gasto diario por encima del umbral— llaman a
 * esta función y ya.
 *
 * Dedupe: cada `kind` tiene su propio `platform_flags.key = alert:<kind>:lastSentAt`.
 * Si ya se mandó una alerta de ese `kind` hace menos de 24 h, esta llamada no
 * hace nada más que devolver `{ skipped: true }` — ni siquiera intenta el envío.
 * El flag se escribe ANTES de intentar mandar el correo: si Resend está caído o
 * sin key, igual queremos recordar "ya avisamos de esto hoy" en vez de reintentar
 * en cada corrida del cron y llenarle el inbox a Frida.
 *
 * Sin `RESEND_API_KEY` (o sin `ADMIN_ALERT_EMAIL`): la alerta se queda en un
 * `console.warn` y la función NUNCA lanza. Un fallo de alertas no puede tumbar
 * el job que la disparó.
 */
import { Resend } from "resend";
import { withPlatformBypass } from "@/lib/tenant-db";
import { emailFrom } from "@/lib/email-from";

const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

// Igual que en auth.ts: instanciar Resend solo al mandar, no al importar el
// módulo — este archivo se importa desde jobs y routes que pueden evaluarse
// sin RESEND_API_KEY configurado (build time, tests).
function getResend(): Resend | null {
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  return new Resend(key);
}

function flagKeyFor(kind: string): string {
  return `alert:${kind}:lastSentAt`;
}

export type SendAdminAlertResult =
  | { skipped: true }
  | { skipped: false; sent: boolean };

/**
 * Manda (o loguea) una alerta de plataforma, con dedupe de 24 h por `kind`.
 *
 * `kind` es la clave de dedupe: dos llamadas con el mismo `kind` dentro de la
 * ventana de 24 h solo mandan una vez. Los callers que necesitan dedupe más
 * fino (p. ej. por tenant+job) lo componen en el propio `kind`
 * (`job_failures:<job>:<ownerId>`), no aquí.
 */
export async function sendAdminAlert(
  kind: string,
  subject: string,
  body: string,
): Promise<SendAdminAlertResult> {
  const flagKey = flagKeyFor(kind);
  const now = new Date();

  // Lee y, si toca, marca el envío en la MISMA transacción: dos llamadas
  // concurrentes con el mismo kind no pueden las dos ver "no hay flag" y las
  // dos mandar correo (mismo patrón que reserveQuota, sin necesitar un UPDATE
  // condicionado porque el volumen de alertas no justifica esa complejidad).
  const alreadySentRecently = await withPlatformBypass(async (tx) => {
    const existing = await tx.platformFlag.findUnique({ where: { key: flagKey } });
    if (existing) {
      const lastSentAt = new Date(existing.value).getTime();
      if (!Number.isNaN(lastSentAt) && now.getTime() - lastSentAt < DEDUPE_WINDOW_MS) {
        return true;
      }
    }
    await tx.platformFlag.upsert({
      where: { key: flagKey },
      create: { key: flagKey, value: now.toISOString() },
      update: { value: now.toISOString() },
    });
    return false;
  });

  if (alreadySentRecently) {
    return { skipped: true };
  }

  const to = process.env.ADMIN_ALERT_EMAIL;
  const resend = getResend();

  if (!resend || !to) {
    console.warn(
      `[alerts] ${kind}: sin RESEND_API_KEY o ADMIN_ALERT_EMAIL, solo log — ${subject}: ${body}`,
    );
    return { skipped: false, sent: false };
  }

  try {
    await resend.emails.send({
      from: emailFrom(),
      to,
      subject: `[tools4foresight] ${subject}`,
      html: `<pre style="font-family:monospace;white-space:pre-wrap;">${escapeHtml(body)}</pre>`,
      text: body,
    });
    return { skipped: false, sent: true };
  } catch (error) {
    // Un correo que no sale no puede tumbar el job que disparó la alerta: se
    // loguea y se sigue. El flag de dedupe ya quedó puesto, así que no se
    // reintenta hasta mañana — es preferible a spamear reintentos.
    console.warn(`[alerts] ${kind}: no se pudo mandar el correo`, error);
    return { skipped: false, sent: false };
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
