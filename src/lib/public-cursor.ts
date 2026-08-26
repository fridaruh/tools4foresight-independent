import { PublicApiError } from "@/lib/public-api-auth";

// Cursor keyset compuesto `(likedAt, id)`. `likedAt` no es único —es una
// estimación de cuándo se dio el like y tiene empates—, así que un cursor de un
// solo campo se saltaría filas al paginar. El id desempata y hace el orden total
// y estable.
const CURSOR_VERSION = "v1";

export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;

export type CursorRow = { likedAt: Date; id: string };

/** Cursor opaco en base64url: `v1|<likedAt ISO>|<id>`. No es (ni debe leerse como) un id de Prisma. */
export function encodeCursor(row: CursorRow): string {
  const raw = `${CURSOR_VERSION}|${row.likedAt.toISOString()}|${row.id}`;
  return Buffer.from(raw, "utf8").toString("base64url");
}

/**
 * `Buffer.from(x, "base64url")` no lanza con basura — decodifica lo que
 * puede y descarta el resto en silencio (verificado: no hay try/catch que
 * valga la pena acá). Lo que sí garantiza que un cursor corrupto no pase es
 * validar la forma resultante: exactamente 3 partes, versión conocida, id no
 * vacío y fecha ISO parseable.
 */
export function decodeCursor(rawCursor: string): CursorRow {
  const decoded = Buffer.from(rawCursor, "base64url").toString("utf8");
  const parts = decoded.split("|");

  if (parts.length !== 3) {
    throw new PublicApiError("invalid_parameter", "El cursor está corrupto.", 400, "cursor");
  }

  const [version, isoDate, id] = parts as [string, string, string];
  if (version !== CURSOR_VERSION) {
    throw new PublicApiError("invalid_parameter", `Versión de cursor desconocida: "${version}".`, 400, "cursor");
  }
  if (!id) {
    throw new PublicApiError("invalid_parameter", "El cursor está corrupto.", 400, "cursor");
  }

  const likedAt = new Date(isoDate);
  if (Number.isNaN(likedAt.getTime())) {
    throw new PublicApiError("invalid_parameter", "El cursor está corrupto.", 400, "cursor");
  }

  return { likedAt, id };
}

/**
 * `raw` es el query param `?limit=` tal cual. Sin valor o vacío -> `fallback`
 * (un cliente que no manda `limit` no debe explotar). Cualquier otro valor
 * inválido —no entero, <= 0, o por encima de `max`— es un **400**, no un
 * recorte silencioso: el contrato lo exige así para que un
 * cliente mal calibrado se entere de que no recibió lo que pidió, en vez de
 * creer que la página corta es todo lo que hay.
 *
 * `max` y `fallback` son parámetros porque cada endpoint tiene los suyos:
 * señales 25/100, vecinos 10/50, grafo 500/2000, historial 100/500.
 */
export function parseLimit(
  raw: string | null,
  options: { max?: number; fallback?: number; param?: string } = {},
): number {
  const { max = MAX_LIMIT, fallback = DEFAULT_LIMIT, param = "limit" } = options;
  if (raw === null || raw.trim() === "") return fallback;

  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > max) {
    throw new PublicApiError(
      "invalid_parameter",
      `El parámetro "${param}" debe ser un entero entre 1 y ${max}.`,
      400,
      param,
    );
  }
  return n;
}

/**
 * Cursor por id para las listas que NO ordenan por `likedAt` (temas,
 * snapshots). Prisma solo necesita el id de la fila de referencia: traduce ese
 * id a los valores de las columnas del `orderBy` y compara contra el par
 * completo, así que el cursor no tiene que cargar el valor de ordenamiento.
 *
 * Va con un prefijo distinto (`v1i`) a propósito: si alguien pega un cursor de
 * señales en `/themes` recibe un 400 claro en vez de una página silenciosamente
 * equivocada.
 */
const ID_CURSOR_VERSION = "v1i";

export function encodeIdCursor(id: string): string {
  return Buffer.from(`${ID_CURSOR_VERSION}|${id}`, "utf8").toString("base64url");
}

export function decodeIdCursor(rawCursor: string): string {
  const parts = Buffer.from(rawCursor, "base64url").toString("utf8").split("|");
  if (parts.length !== 2 || parts[0] !== ID_CURSOR_VERSION || !parts[1]) {
    throw new PublicApiError("invalid_parameter", "El cursor está corrupto.", 400, "cursor");
  }
  return parts[1];
}
