// Los IDs de tweet de X son snowflake: los 41 bits altos son el timestamp de
// creacion en ms, con la epoca propia de Twitter. Eso nos deja recuperar la
// fecha exacta de cada tweet sin gastar una sola llamada a la API (relevante
// aqui: la cuenta es pay-per-use y ya se quedo sin creditos una vez).
//
// Solo aplica a IDs generados desde nov-2010 en adelante (snowflake). Los IDs
// secuenciales viejos son < 2^41, y para esos devolvemos null en vez de inventar
// una fecha de 1970.
const TWITTER_EPOCH_MS = 1288834974657n;
const MIN_SNOWFLAKE_ID = 1n << 41n;

export function tweetIdToDate(tweetId: string): Date | null {
  if (!/^\d+$/.test(tweetId)) return null;

  const id = BigInt(tweetId);
  if (id < MIN_SNOWFLAKE_ID) return null;

  const ms = (id >> 22n) + TWITTER_EPOCH_MS;
  const date = new Date(Number(ms));
  return Number.isNaN(date.getTime()) ? null : date;
}
