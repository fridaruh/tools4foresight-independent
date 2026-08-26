/**
 * Claves de API por persona: cada quien genera las suyas desde /perfil y las usa
 * contra `/api/public/v1` o contra el MCP remoto. Son la ÚNICA fuente de
 * credenciales de la API pública — no hay claves de entorno (PLAN_MCP §0.1): una
 * clave sin dueño no tendría banco que leer.
 *
 * Aquí la clave no prueba que pagaste: **es la identidad del banco**. Resolverla
 * devuelve un `ownerId`, y todo lo que se lea después pasa por
 * `withOwner(ownerId, …)`.
 *
 * POR QUÉ ESTE MÓDULO USA `prisma` GLOBAL Y NO `tenantClient`:
 *   `api_keys` NO es una tabla de tenant y no lleva política de RLS — es la misma
 *   excepción que sessions/accounts/verifications (ver la cabecera de
 *   src/lib/tenant-db.ts). `resolveApiKey()` es justamente el query que DESCUBRE
 *   quién es el tenant: corre antes de que exista un `app.owner_id` que fijar, así
 *   que con RLS encima devolvería cero filas siempre y nadie podría autenticarse.
 *   La compensación es de aplicación y no admite excepciones: **todo** acceso a
 *   `api_keys` lleva `userId` en el `where`. La única lectura sin `userId` es la
 *   de `resolveApiKey` por `keyHash`, y ese hash ES la credencial — quien lo
 *   conoce ya probó ser el dueño.
 *
 * Invariante del módulo: el texto plano de una clave existe en un solo momento de
 * su vida, dentro de `createApiKey`, y viaja una única vez al usuario en la
 * respuesta del POST. En la base solo queda su SHA-256 (ver el comentario largo de
 * `model ApiKey` en prisma/schema.prisma).
 */
import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";

/** Prefijo fijo de toda clave: la hace reconocible en un log, un .env o un secret scanner. */
export const KEY_PREFIX = "t4f_";

/**
 * 32 bytes de entropía. En base64url son 43 caracteres, así que una clave
 * completa mide 47. Suficiente para que la fuerza bruta contra el endpoint no sea
 * una hipótesis (y aparte hay rate limit por IP en public-api-auth.ts).
 */
const KEY_BYTES = 32;

/** Los primeros ~10 caracteres ("t4f_" + 6 del cuerpo). Identifican sin autenticar. */
const PREFIX_LENGTH = 10;

/**
 * Tope de claves activas por usuario. No es una defensa de seguridad (el dueño ya
 * tiene acceso a su propio banco) sino de higiene: una lista de 3 claves se audita
 * y se revoca, una de 200 no. Las revocadas no cuentan — si no, revocar y crear
 * otra chocaría con el tope al décimo intento.
 */
export const MAX_ACTIVE_KEYS = 10;

/**
 * Cada cuánto se permite reescribir `lastUsedAt`. Un agente puede hacer decenas de
 * llamadas por minuto con la misma clave y `lastUsedAt` solo existe para que el
 * usuario vea "se usó hoy" / "no se usa desde marzo": esa pregunta no necesita
 * precisión de segundos, pero un UPDATE por request sí es una escritura en el
 * camino caliente de cada lectura de la API (y en Neon, con el pooler, tráfico y
 * latencia que no le sirven a nadie). Con una hora, el peor caso es que la fecha
 * mostrada esté una hora vieja.
 */
const LAST_USED_THROTTLE_MS = 60 * 60 * 1000;

export type NewApiKey = {
  id: string;
  name: string;
  prefix: string;
  /** El texto plano. Se devuelve UNA vez y no se persiste en ningún lado. */
  plaintext: string;
  createdAt: Date;
};

export type ApiKeyRow = {
  id: string;
  name: string;
  prefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
};

/** Se lanza cuando el usuario ya llegó a `MAX_ACTIVE_KEYS`. El endpoint lo traduce a 400. */
export class ApiKeyLimitError extends Error {
  constructor() {
    super(`Ya tienes ${MAX_ACTIVE_KEYS} claves activas. Revoca alguna antes de crear otra.`);
    this.name = "ApiKeyLimitError";
  }
}

/**
 * SHA-256 hex del texto plano. Determinista y sin sal a propósito: la sal haría
 * imposible el `findUnique` por hash (habría que probar fila por fila), y no
 * aporta nada frente a un secreto de 32 bytes aleatorios, que no está en ninguna
 * tabla arcoíris ni en ningún diccionario. Misma función para escribir y para
 * resolver: si cambia, todas las claves existentes dejan de servir.
 */
export function hashKey(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

/** Genera el texto plano de una clave nueva: `t4f_` + 32 bytes en base64url. */
export function generateKeyPlaintext(): string {
  return `${KEY_PREFIX}${randomBytes(KEY_BYTES).toString("base64url")}`;
}

/** El trozo visible que se guarda para que el usuario reconozca la clave en la lista. */
export function prefixOf(plaintext: string): string {
  return plaintext.slice(0, PREFIX_LENGTH);
}

/**
 * Genera una clave nueva. El texto plano se devuelve UNA vez y no se persiste.
 * El conteo del tope se hace justo antes del insert: no es una transacción
 * serializable, así que dos POST simultáneos podrían dejar 11 claves. Es un límite
 * de higiene, no de seguridad, y el usuario está compitiendo consigo mismo — no
 * vale una transacción por request.
 */
export async function createApiKey(userId: string, name: string): Promise<NewApiKey> {
  const activas = await prisma.apiKey.count({ where: { userId, revokedAt: null } });
  if (activas >= MAX_ACTIVE_KEYS) throw new ApiKeyLimitError();

  const plaintext = generateKeyPlaintext();
  const row = await prisma.apiKey.create({
    data: { userId, name, keyHash: hashKey(plaintext), prefix: prefixOf(plaintext) },
    select: { id: true, name: true, prefix: true, createdAt: true },
  });

  return { ...row, plaintext };
}

/** Las claves vigentes del usuario, más nuevas primero. Nunca incluye el hash ni el texto plano. */
export async function listApiKeys(userId: string): Promise<ApiKeyRow[]> {
  return prisma.apiKey.findMany({
    where: { userId, revokedAt: null },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, prefix: true, createdAt: true, lastUsedAt: true },
  });
}

/**
 * Revoca (soft-delete) una clave del usuario. `false` si no existe, si no es suya
 * o si ya estaba revocada — el `userId` va en el `where` y no en una comprobación
 * posterior, para que no exista la ventana en la que se lee una clave ajena.
 * Devolver el mismo `false` en los tres casos evita además que alguien use este
 * endpoint para averiguar qué ids de clave existen.
 */
export async function revokeApiKey(userId: string, keyId: string): Promise<boolean> {
  const { count } = await prisma.apiKey.updateMany({
    where: { id: keyId, userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return count > 0;
}

/**
 * Actualiza `lastUsedAt` sin bloquear la respuesta y como mucho una vez por
 * `LAST_USED_THROTTLE_MS`. Se llama sin `await` a propósito: el valor no lo lee
 * nadie en esta request, así que esperar el round-trip a Neon solo le sumaría
 * latencia a cada llamada de la API. Un fallo se traga (se loguea): no poder
 * anotar la fecha de último uso jamás debe tumbar una lectura.
 *
 * El `userId` va en el `where` aunque el `id` ya sea único: es la regla del módulo
 * (ver cabecera) y aquí no cuesta nada mantenerla.
 */
function touchLastUsed(keyId: string, userId: string, lastUsedAt: Date | null): void {
  if (lastUsedAt && Date.now() - lastUsedAt.getTime() < LAST_USED_THROTTLE_MS) return;
  void prisma.apiKey
    .updateMany({ where: { id: keyId, userId }, data: { lastUsedAt: new Date() } })
    .catch((error: unknown) => {
      console.error("[api-keys] no se pudo actualizar lastUsedAt:", error);
    });
}

/**
 * Resuelve una clave a su dueño: `{ keyId, ownerId }`, o `null` si no vale.
 *
 * `ownerId` y no `userId` a propósito: en este repo el dueño de la clave ES el
 * dueño del banco, y llamarlo por el nombre que espera `withOwner()` evita que
 * alguien lo pase donde no va.
 *
 * La regla de acceso es la mínima (PLAN_MCP §3): la clave existe, no está
 * revocada, y el usuario existe. No hay Stripe, planes ni paywall en este repo —
 * cada quien lee su propio banco, no contenido ajeno de pago. El `include` del
 * usuario no es decorativo: confirma que la fila de `users` sigue ahí, porque un
 * banco sin dueño no es leíble. Si algún día hay planes, ESTE es el punto de
 * enganche y solo este.
 */
export async function resolveApiKey(
  plaintext: string,
): Promise<{ keyId: string; ownerId: string } | null> {
  if (!plaintext.startsWith(KEY_PREFIX)) return null; // no es una clave nuestra: ni consultamos

  const row = await prisma.apiKey.findUnique({
    where: { keyHash: hashKey(plaintext) },
    select: {
      id: true,
      userId: true,
      revokedAt: true,
      lastUsedAt: true,
      user: { select: { id: true } },
    },
  });

  if (!row || row.revokedAt !== null) return null;
  if (!row.user) return null;

  touchLastUsed(row.id, row.userId, row.lastUsedAt);
  return { keyId: row.id, ownerId: row.userId };
}
