/**
 * Pone `role = platform_admin` a un usuario EXISTENTE, por email (PLAN Fase 5.1).
 *
 *   npx tsx scripts/make-platform-admin.ts <email>
 *
 * No crea usuarios: si el email no existe en la DB, no toca nada y sale con
 * error. Corre con `withPlatformBypass` porque cambiar el rol de un tenant
 * ajeno es, por definición, cross-tenant — ver src/lib/tenant-db.ts.
 */
import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { withPlatformBypass } from "../src/lib/tenant-db";

async function main() {
  const email = process.argv[2]?.trim().toLowerCase();
  if (!email) {
    console.error("Uso: npx tsx scripts/make-platform-admin.ts <email>");
    process.exitCode = 1;
    return;
  }

  const updated = await withPlatformBypass(async (tx) => {
    const user = await tx.user.findUnique({ where: { email } });
    if (!user) return null;
    if (user.role === "platform_admin") return user;
    return tx.user.update({ where: { id: user.id }, data: { role: "platform_admin" } });
  });

  if (!updated) {
    console.error(`[skip] no existe ningún usuario con email ${email} — no se creó nada.`);
    process.exitCode = 1;
    return;
  }

  console.log(`[ok] ${updated.email} (${updated.id}) es platform_admin`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
