/**
 * QA de cuotas (criterio de aceptación de la Fase 2, tarea 2.4).
 *
 *   npm run qa:quota
 *
 * Crea un usuario de prueba, le fija xPagesPerDay=2 y comprueba que
 * `reserveQuota` es atómica y respeta el límite: dos reservas pasan, la
 * tercera no. Después fuerza `windowResetAt` al pasado y confirma que el
 * reset diario deja cupo de nuevo. Por último comprueba que `recordUsage`
 * escribe el `UsageEvent`. Al final borra el usuario de prueba.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/prisma";
import { withOwner, withPlatformBypass } from "../src/lib/tenant-db";
import { seedTenant } from "../src/lib/seed-tenant";
import { reserveQuota, recordUsage } from "../src/lib/quota";

let failures = 0;

function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function makeUser(label: string): Promise<string> {
  const id = randomUUID();
  await withPlatformBypass((tx) =>
    tx.user.create({
      data: {
        id,
        name: `QA ${label}`,
        email: `qa-${label}-${id}@tools4foresight.test`,
        role: "user",
      },
    }),
  );
  // seedTenant crea el UserQuota default (xPagesPerDay=2 de fábrica, pero lo
  // fijamos explícito abajo para que el test no dependa de ese default).
  await seedTenant(id);
  return id;
}

async function main() {
  const userId = await makeUser("quota");

  try {
    await withPlatformBypass((tx) =>
      tx.userQuota.update({ where: { userId }, data: { xPagesPerDay: 2 } }),
    );

    const r1 = await withOwner(userId, (tx) => reserveQuota(tx, userId, "x_pages", 1));
    const r2 = await withOwner(userId, (tx) => reserveQuota(tx, userId, "x_pages", 1));
    const r3 = await withOwner(userId, (tx) => reserveQuota(tx, userId, "x_pages", 1));

    check("reserva 1/2 devuelve true", r1 === true, `devolvió ${r1}`);
    check("reserva 2/2 devuelve true", r2 === true, `devolvió ${r2}`);
    check("reserva 3 (sin cupo) devuelve false", r3 === false, `devolvió ${r3}`);

    const usedBeforeReset = await withOwner(userId, (tx) =>
      tx.userQuota.findUnique({ where: { userId }, select: { xPagesUsedToday: true } }),
    );
    check(
      "el contador quedó en 2 tras las dos reservas exitosas",
      usedBeforeReset?.xPagesUsedToday === 2,
      `es ${usedBeforeReset?.xPagesUsedToday}`,
    );

    // Forzamos la ventana al pasado: la siguiente reserva debe resetear los
    // contadores y volver a tener cupo, en vez de seguir acumulando sobre el 2.
    await withPlatformBypass((tx) =>
      tx.userQuota.update({
        where: { userId },
        data: { windowResetAt: new Date(Date.now() - 1000) },
      }),
    );

    const r4 = await withOwner(userId, (tx) => reserveQuota(tx, userId, "x_pages", 1));
    check("tras vencer la ventana, la 4ª reserva devuelve true", r4 === true, `devolvió ${r4}`);

    const quotaAfterReset = await withOwner(userId, (tx) =>
      tx.userQuota.findUnique({ where: { userId } }),
    );
    check(
      "el reset dejó x_pages_used_today en 1 (solo la reserva que se acaba de hacer)",
      quotaAfterReset?.xPagesUsedToday === 1,
      `es ${quotaAfterReset?.xPagesUsedToday}`,
    );
    check(
      "windowResetAt quedó en el futuro tras el reset",
      (quotaAfterReset?.windowResetAt.getTime() ?? 0) > Date.now(),
    );

    await withOwner(userId, (tx) => recordUsage(tx, userId, "x_page", 1));
    const events = await withOwner(userId, (tx) => tx.usageEvent.findMany({ where: { userId } }));
    check("recordUsage insertó un UsageEvent", events.length === 1, `hay ${events.length}`);
    check("el UsageEvent quedó con kind=x_page y units=1", events[0]?.kind === "x_page" && events[0]?.units === 1);
  } finally {
    await withPlatformBypass((tx) => tx.user.deleteMany({ where: { id: userId } }));
    console.log("\n[cleanup] usuario de prueba borrado");
    await prisma.$disconnect();
  }

  if (failures > 0) {
    console.log(`\n${failures} check(s) fallaron.`);
    process.exit(1);
  }
  console.log("\nTodos los checks pasaron.");
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
