// Template del correo de magic link, vestido de AI The New Sexy (DESIGN.md /
// DESIGN_TOKENS.md): Base White de fondo, card blanca con borde negro de 1px,
// kicker mono naranja, boton negro, radio cero, sin sombras. Todo va en tablas
// con estilos inline porque los clientes de correo (Gmail, Outlook) ignoran
// <style> y CSS moderno; las fuentes de marca (Inter Tight / IBM Plex Mono) no
// existen en email, asi que cada stack declara su fallback web-safe.

const ORANGE = "#ff4d00";
const INK = "#0a0a0a";
const CANVAS = "#f7f7f5";
const SURFACE = "#ffffff";
const INK_SUBTLE = "#63635f";
const INK_TERTIARY = "#8a8a85";

const SANS = "'Inter Tight','Helvetica Neue',Helvetica,Arial,sans-serif";
const MONO = "'IBM Plex Mono','Courier New',Courier,monospace";

// 11px uppercase con tracking: el equivalente inline de .label-mono.
const LABEL_MONO = `font-family:${MONO};font-size:11px;line-height:16px;letter-spacing:1.5px;text-transform:uppercase;`;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export type MagicLinkEmailInput = {
  url: string;
  // Con signup abierto el mismo correo sirve para entrar y para crear la
  // cuenta; el copy cambia segun exista ya el email. Esto solo lo ve el dueno
  // del inbox, asi que no rompe la anti-enumeracion del formulario.
  isNewAccount: boolean;
  expiresInMinutes: number;
};

export function magicLinkEmail({ url, isNewAccount, expiresInMinutes }: MagicLinkEmailInput): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = isNewAccount
    ? "Crea tu cuenta en tools4foresight"
    : "Tu link de acceso a tools4foresight";
  const kicker = isNewAccount ? "alta / tools4foresight" : "acceso / tools4foresight";
  const heading = isNewAccount ? "Crea tu cuenta" : "Entra al banco";
  const body = isNewAccount
    ? "Pediste acceso a tools4foresight con este correo. Confirma tu email con el botón y tu cuenta queda creada — sin passwords, este link es tu llave."
    : "Pediste entrar al banco de señales. Usa el botón y sigues donde te quedaste — sin passwords, este link es tu llave.";
  const cta = isNewAccount ? "Crear mi cuenta" : "Entrar al banco";

  const safeUrl = escapeHtml(url);
  const expiry = `el link expira en ${expiresInMinutes} minutos · un solo uso`;

  const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
</head>
<body style="margin:0;padding:0;background-color:${CANVAS};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${CANVAS};">
<tr><td align="center" style="padding:40px 16px;">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:560px;max-width:100%;">

<tr><td style="padding:0 4px 10px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td align="left" style="${LABEL_MONO}color:${INK_TERTIARY};">+</td>
<td align="right" style="${LABEL_MONO}color:${INK_TERTIARY};">+</td>
</tr></table>
</td></tr>

<tr><td style="background-color:${SURFACE};border:1px solid ${INK};padding:36px 32px;">
  <p style="margin:0 0 18px;${LABEL_MONO}color:${ORANGE};">${kicker}</p>
  <h1 style="margin:0 0 14px;font-family:${SANS};font-size:26px;line-height:30px;font-weight:700;letter-spacing:-0.5px;text-transform:uppercase;color:${INK};">${heading}</h1>
  <p style="margin:0 0 28px;font-family:${SANS};font-size:15px;line-height:23px;color:${INK_SUBTLE};">${body}</p>

  <table role="presentation" cellpadding="0" cellspacing="0"><tr>
  <td style="background-color:${INK};border:1px solid ${INK};">
    <a href="${safeUrl}" style="display:inline-block;padding:15px 30px;${LABEL_MONO}color:#f7f7f5;text-decoration:none;">${cta} &#8594;</a>
  </td>
  </tr></table>

  <p style="margin:16px 0 0;${LABEL_MONO}color:${INK_TERTIARY};letter-spacing:0.5px;text-transform:none;">${expiry}</p>

  <hr style="margin:28px 0 20px;border:0;border-top:1px solid #dcdcd7;">
  <p style="margin:0 0 6px;${LABEL_MONO}color:${INK_TERTIARY};">si el botón no funciona</p>
  <p style="margin:0;font-family:${MONO};font-size:11px;line-height:17px;color:${INK_SUBTLE};word-break:break-all;">
    <a href="${safeUrl}" style="color:${INK_SUBTLE};text-decoration:underline;">${safeUrl}</a>
  </p>
</td></tr>

<tr><td style="padding:18px 4px 0;">
  <p style="margin:0 0 6px;${LABEL_MONO}color:${INK_TERTIARY};">tools4foresight · señales del futuro, desclasificadas</p>
  <p style="margin:0;font-family:${SANS};font-size:12px;line-height:18px;color:${INK_TERTIARY};">Recibes este correo porque alguien pidió ${isNewAccount ? "crear una cuenta" : "un link de acceso"} con esta dirección. Si no fuiste tú, ignóralo — nadie entra sin este link.</p>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;

  const text = [
    heading.toUpperCase(),
    "",
    body,
    "",
    `${cta}: ${url}`,
    "",
    expiry,
    "",
    "Si no pediste este link, ignora este correo — nadie entra sin él.",
    "tools4foresight",
  ].join("\n");

  return { subject, html, text };
}
