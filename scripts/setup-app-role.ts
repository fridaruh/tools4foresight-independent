/**
 * Crea (o re-sincroniza) el rol de Postgres con el que corre la app: `t4f_app`.
 *
 * Por qué hace falta un rol aparte, si la migración `_rls` ya usa FORCE ROW LEVEL
 * SECURITY: en Neon el rol `neondb_owner` viene con el atributo BYPASSRLS y el
 * control plane no deja quitarlo (`ALTER ROLE ... NOBYPASSRLS` -> "permission denied
 * to alter role"). BYPASSRLS le gana a FORCE, así que si la app se conecta como
 * `neondb_owner` las políticas no aplican nunca y el aislamiento vuelve a depender
 * solo del código. Con `t4f_app` (NOBYPASSRLS) las políticas sí muerden.
 *
 *   Migraciones -> DIRECT_URL  (neondb_owner, unpooled)
 *   Runtime     -> DATABASE_URL (t4f_app, pooled)
 *
 * Uso:
 *   npx tsx scripts/setup-app-role.ts            # crea el rol si no existe
 *   npx tsx scripts/setup-app-role.ts --rotate   # además rota la contraseña
 *
 * Imprime la DATABASE_URL que hay que dejar en .env / Vercel. No la escribe solo:
 * rotar la contraseña sin actualizar el entorno tira la app.
 */
import "dotenv/config";
import crypto from "node:crypto";
import { Client } from "pg";

const ROLE = "t4f_app";

function strongPassword(): string {
  // Neon rechaza contraseñas débiles desde el control plane, de ahí el sufijo.
  return `t4f_${crypto.randomBytes(24).toString("base64url")}_Aa9!`;
}

async function main() {
  const rotate = process.argv.includes("--rotate");
  const directUrl = process.env.DIRECT_URL;
  if (!directUrl) throw new Error("Falta DIRECT_URL (rol dueño, conexión unpooled)");

  const admin = new Client({ connectionString: directUrl });
  await admin.connect();

  const existing = await admin.query<{ rolbypassrls: boolean }>(
    "SELECT rolbypassrls FROM pg_roles WHERE rolname = $1",
    [ROLE],
  );

  let password: string | null = null;

  if (existing.rowCount === 0) {
    password = strongPassword();
    await admin.query(`CREATE ROLE ${ROLE} LOGIN NOBYPASSRLS PASSWORD '${password}'`);
    console.log(`[ok] rol ${ROLE} creado`);
  } else {
    console.log(`[ok] rol ${ROLE} ya existía (bypassrls=${existing.rows[0].rolbypassrls})`);
    if (existing.rows[0].rolbypassrls) {
      await admin.query(`ALTER ROLE ${ROLE} NOBYPASSRLS`);
      console.log(`[ok] ${ROLE} pasado a NOBYPASSRLS`);
    }
    if (rotate) {
      password = strongPassword();
      await admin.query(`ALTER ROLE ${ROLE} PASSWORD '${password}'`);
      console.log(`[ok] contraseña de ${ROLE} rotada`);
    }
  }

  // Idempotente: la migración `_rls` hace lo mismo, pero el rol puede crearse
  // después de haber migrado.
  await admin.query(`GRANT USAGE ON SCHEMA public TO ${ROLE}`);
  await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ROLE}`);
  await admin.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${ROLE}`);
  await admin.query(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${ROLE}`,
  );
  await admin.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${ROLE}`);
  console.log("[ok] privilegios otorgados (incluye default privileges para tablas futuras)");

  await admin.end();

  if (password) {
    // El host pooled sale de la DATABASE_URL actual si ya apunta a Neon; si no,
    // se deriva de DIRECT_URL agregando "-pooler" al host.
    const base = new URL(process.env.DATABASE_URL ?? directUrl);
    if (!base.hostname.includes("-pooler")) {
      base.hostname = base.hostname.replace(/^([^.]+)\./, "$1-pooler.");
    }
    base.username = ROLE;
    base.password = password;
    console.log("\nDATABASE_URL (pooled, rol de la app) — pégala en .env y en Vercel:\n");
    console.log(base.toString());
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
