#!/usr/bin/env tsx
/**
 * QA de `src/lib/token-crypto.ts` (PLAN Fase 5, tarea 5.4).
 *
 * Lo que protege: los blobs viejos (formato de 3 partes, sin `v1.`) tienen que
 * seguir descifrándose después de haber añadido la versión al formato, y la
 * ventana de rotación (`_NEXT` / `_PREV`) tiene que poder leer las dos claves.
 * Si algo de esto se rompe, todos los usuarios pierden su conexión de X sin
 * que ningún test de tenant se entere.
 *
 * No toca la base: solo entra y sale del módulo de cifrado.
 */
import { randomBytes, createCipheriv } from "node:crypto";
import {
  CURRENT_VERSION,
  decryptToken,
  decryptTokenWithKey,
  encryptToken,
  encryptTokenWithKey,
  parseKey,
} from "../src/lib/token-crypto";

let failed = 0;

function check(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}`);
    failed += 1;
  }
}

function throws(label: string, fn: () => unknown): void {
  try {
    fn();
    console.error(`  ✗ ${label} (no lanzó)`);
    failed += 1;
  } catch {
    console.log(`  ✓ ${label}`);
  }
}

function newKeyB64(): string {
  return randomBytes(32).toString("base64");
}

/** Cifra con el formato VIEJO (3 partes, sin prefijo de versión). */
function encryptLegacy(plaintext: string, keyB64: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(keyB64, "base64"), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), ct.toString("base64")].join(".");
}

const SECRET = "sk-ant-api03-lo-que-sea-que-un-usuario-pegue";

function main(): void {
  const keyA = newKeyB64();
  const keyB = newKeyB64();

  const restore = {
    key: process.env.TOKEN_ENCRYPTION_KEY,
    next: process.env.TOKEN_ENCRYPTION_KEY_NEXT,
    prev: process.env.TOKEN_ENCRYPTION_KEY_PREV,
  };

  try {
    process.env.TOKEN_ENCRYPTION_KEY = keyA;
    delete process.env.TOKEN_ENCRYPTION_KEY_NEXT;
    delete process.env.TOKEN_ENCRYPTION_KEY_PREV;

    console.log("formato v1");
    const blob = encryptToken(SECRET);
    check(`el blob empieza con "${CURRENT_VERSION}."`, blob.startsWith(`${CURRENT_VERSION}.`));
    check("el blob tiene 4 segmentos", blob.split(".").length === 4);
    check("round-trip", decryptToken(blob) === SECRET);
    check("dos cifrados del mismo texto difieren (IV aleatorio)", encryptToken(SECRET) !== blob);

    console.log("retrocompatibilidad");
    const legacy = encryptLegacy(SECRET, keyA);
    check("un blob viejo (3 partes) se lee como v1", decryptToken(legacy) === SECRET);

    console.log("integridad");
    throws("un blob con la versión equivocada no se descifra", () => decryptToken(`v9.${blob.slice(3)}`));
    throws("un blob con basura no se descifra", () => decryptToken("no-es-un-blob"));
    const [v, iv, tag] = blob.split(".");
    const tampered = [v, iv, tag, Buffer.from("otro texto").toString("base64")].join(".");
    throws("un ciphertext manipulado falla el authTag", () => decryptToken(tampered));

    console.log("ventana de rotación");
    const withB = encryptTokenWithKey(SECRET, parseKey(keyB));
    throws("sin la clave B, un blob cifrado con B no se lee", () => decryptToken(withB));
    process.env.TOKEN_ENCRYPTION_KEY_NEXT = keyB;
    check("con _NEXT puesta, el blob de B se lee", decryptToken(withB) === SECRET);
    check("y el blob de A se sigue leyendo", decryptToken(blob) === SECRET);
    check("decryptTokenWithKey es explícito", decryptTokenWithKey(withB, parseKey(keyB)) === SECRET);

    console.log("validación de clave");
    throws("una clave que no son 32 bytes se rechaza", () => parseKey("dGVzdA=="));
  } finally {
    process.env.TOKEN_ENCRYPTION_KEY = restore.key;
    if (restore.next === undefined) delete process.env.TOKEN_ENCRYPTION_KEY_NEXT;
    else process.env.TOKEN_ENCRYPTION_KEY_NEXT = restore.next;
    if (restore.prev === undefined) delete process.env.TOKEN_ENCRYPTION_KEY_PREV;
    else process.env.TOKEN_ENCRYPTION_KEY_PREV = restore.prev;
  }

  if (failed > 0) {
    console.error(`\n❌ ${failed} chequeo(s) fallaron`);
    process.exit(1);
  }
  console.log("\n✨ token-crypto OK");
}

main();
