#!/usr/bin/env tsx
/**
 * Rotación de `TOKEN_ENCRYPTION_KEY` (PLAN Fase 5, tarea 5.4).
 *
 * Re-cifra TODO lo que guarda secretos por tenant:
 *   - `x_auth_tokens.access_token` y `.refresh_token` (OAuth de X)
 *
 * Cómo se usa (el orden importa: si se promueve la clave antes de re-cifrar,
 * los tokens quedan ilegibles y todo el mundo tiene que reconectar X):
 *
 *   1. Generar la clave nueva:
 *        node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 *   2. Ponerla en el entorno como `TOKEN_ENCRYPTION_KEY_NEXT` (dejando
 *      `TOKEN_ENCRYPTION_KEY` como está) y desplegar. En este punto la app ya
 *      sabe descifrar con las dos (ver src/lib/token-crypto.ts).
 *   3. Ensayar:  npx tsx scripts/rotate-encryption-key.ts --dry-run
 *   4. Rotar:    npx tsx scripts/rotate-encryption-key.ts
 *   5. Promover: `TOKEN_ENCRYPTION_KEY = <la nueva>`,
 *                `TOKEN_ENCRYPTION_KEY_PREV = <la vieja>` (unos días, por si
 *                quedó algo), borrar `TOKEN_ENCRYPTION_KEY_NEXT`, desplegar.
 *   6. Después de la ventana, borrar `TOKEN_ENCRYPTION_KEY_PREV`.
 *
 * Corre con `withPlatformBypass`: re-cifrar los secretos de TODOS los tenants
 * es, por definición, cross-tenant — es uno de los usos legítimos que documenta
 * src/lib/tenant-db.ts.
 *
 * Idempotente y reanudable: cada fila se descifra probando las claves
 * disponibles, así que volver a correrlo sobre filas ya rotadas no rompe nada
 * (se re-cifran con la misma clave destino). Nunca imprime un secreto: el log
 * es por id de fila y conteos.
 */
import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { withPlatformBypass } from "../src/lib/tenant-db";
import {
  decryptToken,
  encryptTokenWithKey,
  parseKey,
} from "../src/lib/token-crypto";

/** Cuántas filas se traen por vuelta. Los volúmenes aquí son chicos (1 fila por tenant). */
const PAGE_SIZE = 200;

type Stats = { scanned: number; rotated: number; failed: number };

function emptyStats(): Stats {
  return { scanned: 0, rotated: 0, failed: 0 };
}

function targetKey() {
  const raw = process.env.TOKEN_ENCRYPTION_KEY_NEXT;
  if (!raw) {
    throw new Error(
      "Falta TOKEN_ENCRYPTION_KEY_NEXT: es la clave DESTINO de la rotación. " +
        "Genérala con: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
    );
  }
  if (raw === process.env.TOKEN_ENCRYPTION_KEY) {
    throw new Error("TOKEN_ENCRYPTION_KEY_NEXT es idéntica a TOKEN_ENCRYPTION_KEY: no hay nada que rotar");
  }
  return parseKey(raw, "TOKEN_ENCRYPTION_KEY_NEXT");
}

/** Descifra con cualquiera de las claves configuradas y re-cifra con la destino. */
function reencrypt(blob: string, key: Buffer): string {
  return encryptTokenWithKey(decryptToken(blob), key);
}

async function rotateXAuthTokens(key: Buffer, dryRun: boolean): Promise<Stats> {
  const stats = emptyStats();
  let cursor: string | undefined;

  for (;;) {
    const rows = await withPlatformBypass((tx) =>
      tx.xAuthToken.findMany({
        take: PAGE_SIZE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { id: "asc" },
        select: { id: true, accessToken: true, refreshToken: true },
      }),
    );
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;

    for (const row of rows) {
      stats.scanned += 1;
      try {
        const accessToken = reencrypt(row.accessToken, key);
        const refreshToken = reencrypt(row.refreshToken, key);
        if (!dryRun) {
          await withPlatformBypass((tx) =>
            tx.xAuthToken.updateMany({ where: { id: row.id }, data: { accessToken, refreshToken } }),
          );
        }
        stats.rotated += 1;
      } catch (error) {
        stats.failed += 1;
        console.error(`[x_auth_tokens] ${row.id}: ${(error as Error).message}`);
      }
    }
  }

  return stats;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const key = targetKey();

  console.log(
    dryRun
      ? "🔎 --dry-run: se descifra y se re-cifra en memoria, NO se escribe nada.\n"
      : "🔐 Rotando a TOKEN_ENCRYPTION_KEY_NEXT…\n",
  );

  const x = await rotateXAuthTokens(key, dryRun);
  console.log(`x_auth_tokens : ${x.rotated}/${x.scanned} ok, ${x.failed} fallaron`);

  const failed = x.failed;
  if (failed > 0) {
    console.error(
      `\n❌ ${failed} fila(s) no se pudieron rotar. NO promuevas la clave todavía: ` +
        "revisa que TOKEN_ENCRYPTION_KEY (o _PREV) siga siendo la que cifró esas filas.",
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    dryRun
      ? "\n✅ Ensayo limpio. Vuelve a correrlo sin --dry-run para escribir."
      : "\n✅ Listo. Ahora promueve TOKEN_ENCRYPTION_KEY_NEXT a TOKEN_ENCRYPTION_KEY " +
          "(y deja la vieja en TOKEN_ENCRYPTION_KEY_PREV unos días).",
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
