// Remitente de todos los correos de la app. El display name es fijo
// ("Tools 4 Foresight"); la dirección sale de MAGIC_LINK_FROM_EMAIL para respetar
// el dominio verificado en Resend sin duplicarlo en el código.
const FALLBACK_ADDRESS = "noreply@resend.dev";

export const EMAIL_SENDER_NAME = "Tools 4 Foresight";

export function emailFrom(): string {
  const raw = process.env.MAGIC_LINK_FROM_EMAIL ?? FALLBACK_ADDRESS;
  const match = raw.match(/<([^>]+)>/);
  const address = (match ? match[1] : raw).trim();
  return `${EMAIL_SENDER_NAME} <${address}>`;
}
