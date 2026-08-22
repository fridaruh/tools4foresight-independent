/**
 * Cifrado de secretos por tenant (AES-256-GCM) — PLAN §1.5.
 *
 * Formato del blob:  `v1.<iv>.<authTag>.<ciphertext>`   (todo base64)
 *
 * El prefijo `v1.` es la VERSIÓN del esquema de cifrado y va dentro del blob a
 * propósito: sin él, cambiar de algoritmo o de derivación de clave obligaría a
 * adivinar por la forma del string. Los blobs viejos (los que se escribieron
 * antes de esta versión, con la forma de 3 partes `<iv>.<tag>.<ct>`) se leen
 * como v1 sin marca — la migración es perezosa: cualquier reescritura los deja
 * ya con el prefijo.
 *
 * Rotación de clave (`scripts/rotate-encryption-key.ts`):
 *   1. Se genera una clave nueva y se pone en `TOKEN_ENCRYPTION_KEY_NEXT`.
 *   2. `decryptToken` prueba, en orden, `TOKEN_ENCRYPTION_KEY`,
 *      `TOKEN_ENCRYPTION_KEY_NEXT` y `TOKEN_ENCRYPTION_KEY_PREV`. Probar es
 *      seguro porque GCM autentica: con la clave equivocada el `authTag` no
 *      cuadra y `final()` lanza, no devuelve basura.
 *   3. Se corre el script: descifra con la vieja y re-cifra con la nueva.
 *   4. Se promueve `NEXT` a `TOKEN_ENCRYPTION_KEY` (y la vieja pasa a `PREV`
 *      unos días, por si quedó algún blob sin migrar) y se despliega.
 *
 * Nada de esto se loguea nunca: ni la clave, ni el plaintext, ni el blob.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";

/** Versión del esquema. Va como primer segmento del blob. */
export const CURRENT_VERSION = "v1";

/** Variables de entorno que pueden contener una clave, en orden de preferencia. */
const KEY_ENV_VARS = [
  "TOKEN_ENCRYPTION_KEY",
  "TOKEN_ENCRYPTION_KEY_NEXT",
  "TOKEN_ENCRYPTION_KEY_PREV",
] as const;

/** Decodifica una clave base64 y valida que sean 32 bytes (AES-256). */
export function parseKey(raw: string, label = "TOKEN_ENCRYPTION_KEY"): Buffer {
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) {
    throw new Error(`${label} debe decodificar a 32 bytes (AES-256)`);
  }
  return buf;
}

/** La clave con la que se CIFRA (siempre la primaria). */
function primaryKey(): Buffer {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error("TOKEN_ENCRYPTION_KEY no esta configurado");
  }
  return parseKey(raw);
}

/** Todas las claves con las que se puede intentar DESCIFRAR, sin repetidas. */
function candidateKeys(): Buffer[] {
  const seen = new Set<string>();
  const keys: Buffer[] = [];
  for (const name of KEY_ENV_VARS) {
    const raw = process.env[name];
    if (!raw || seen.has(raw)) continue;
    seen.add(raw);
    keys.push(parseKey(raw, name));
  }
  if (keys.length === 0) {
    throw new Error("TOKEN_ENCRYPTION_KEY no esta configurado");
  }
  return keys;
}

type Blob = { version: string; iv: Buffer; authTag: Buffer; ciphertext: Buffer };

/**
 * Parsea el blob. Acepta las dos formas:
 *   - `v1.<iv>.<tag>.<ct>` (actual)
 *   - `<iv>.<tag>.<ct>`    (legado; se trata como v1)
 */
function parseBlob(encoded: string): Blob {
  const parts = encoded.split(".");
  const [version, ivB64, authTagB64, ciphertextB64] =
    parts.length === 4 ? parts : [CURRENT_VERSION, ...parts];

  if (parts.length !== 3 && parts.length !== 4) {
    throw new Error("Formato de token cifrado invalido");
  }
  if (version !== CURRENT_VERSION) {
    throw new Error(`Versión de cifrado desconocida: ${version}`);
  }
  if (!ivB64 || !authTagB64 || !ciphertextB64) {
    throw new Error("Formato de token cifrado invalido");
  }

  return {
    version,
    iv: Buffer.from(ivB64, "base64"),
    authTag: Buffer.from(authTagB64, "base64"),
    ciphertext: Buffer.from(ciphertextB64, "base64"),
  };
}

/** Cifra con una clave explícita. Lo usa el script de rotación. */
export function encryptTokenWithKey(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [
    CURRENT_VERSION,
    iv.toString("base64"),
    authTag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(".");
}

/** Descifra con una clave explícita. Lanza si el authTag no cuadra. */
export function decryptTokenWithKey(encoded: string, key: Buffer): string {
  const { iv, authTag, ciphertext } = parseBlob(encoded);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/** Cifra con la clave primaria. Salida: `v1.<iv>.<tag>.<ct>`. */
export function encryptToken(plaintext: string): string {
  return encryptTokenWithKey(plaintext, primaryKey());
}

/**
 * Descifra probando la clave primaria y, si falla, las de la ventana de
 * rotación (`_NEXT`, `_PREV`). GCM autentica, así que una clave equivocada
 * lanza en vez de devolver texto basura.
 *
 * El error nunca incluye el blob ni la clave: solo dice que no se pudo.
 */
export function decryptToken(encoded: string): string {
  parseBlob(encoded); // valida la forma antes de gastar intentos
  for (const key of candidateKeys()) {
    try {
      return decryptTokenWithKey(encoded, key);
    } catch {
      // Clave equivocada (authTag no cuadra): probar la siguiente.
    }
  }
  throw new Error("No se pudo descifrar el token con ninguna TOKEN_ENCRYPTION_KEY configurada");
}
