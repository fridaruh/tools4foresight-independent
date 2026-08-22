/**
 * QA de aislamiento por tenant (criterio de aceptación de la Fase 1).
 *
 *   npx tsx scripts/qa-tenant-isolation.ts
 *
 * Crea dos usuarios de prueba, les mete una señal a cada uno y comprueba que
 * ninguno puede ver ni tocar la del otro — incluyendo por SQL crudo, que es el
 * camino que la extensión de Prisma NO puede proteger. Al final los borra.
 *
 * El check más importante es el último: sin `app.owner_id` (o sea, un query fuera
 * de `withOwner`) la base devuelve CERO filas. Si ese falla, es que DATABASE_URL
 * está apuntando a un rol con BYPASSRLS (en Neon, `neondb_owner`) y la barrera de
 * Postgres no existe. Ver scripts/setup-app-role.ts.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/prisma";
import { withOwner, withPlatformBypass } from "../src/lib/tenant-db";
import { seedTenant } from "../src/lib/seed-tenant";

let failures = 0;

function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function rawCount(rows: Array<{ count: bigint | number }>): number {
  return Number(rows[0]?.count ?? -1);
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
  return id;
}

async function makeItem(ownerId: string, label: string): Promise<string> {
  return withOwner(ownerId, async (tx) => {
    const item = await tx.likedItem.create({
      data: {
        ownerId,
        tweetId: `qa:${label}:${randomUUID()}`,
        authorHandle: `qa_${label}`,
        tweetText: `señal de prueba de ${label}`,
        tweetUrl: `https://example.test/${label}`,
        likedAt: new Date(),
      },
      select: { id: true },
    });
    return item.id;
  });
}

async function main() {
  const userA = await makeUser("a");
  const userB = await makeUser("b");

  try {
    const itemA = await makeItem(userA, "a");
    const itemB = await makeItem(userB, "b");
    check("cada tenant pudo crear su señal dentro de withOwner", Boolean(itemA && itemB));

    // 1. Prisma dentro de withOwner(A): solo la señal de A.
    const seenByA = await withOwner(userA, (tx) => tx.likedItem.findMany({ select: { id: true } }));
    check(
      "withOwner(A).findMany devuelve exactamente 1 señal (la de A)",
      seenByA.length === 1 && seenByA[0]?.id === itemA,
      `devolvió ${seenByA.length}`,
    );

    // 2. SQL crudo dentro de withOwner(A): la política manda, no el ORM.
    const rawA = await withOwner(userA, (tx) =>
      tx.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) AS count FROM liked_items`,
    );
    check(
      "withOwner(A) $queryRaw count(*) sobre liked_items devuelve 1",
      rawCount(rawA) === 1,
      `devolvió ${rawCount(rawA)}`,
    );

    // 3. Lectura cruzada explícita: pedir el id del otro tampoco lo trae.
    const crossRead = await withOwner(userA, (tx) =>
      tx.likedItem.findFirst({ where: { id: itemB }, select: { id: true } }),
    );
    check("withOwner(A) no puede leer la señal de B ni pidiéndola por id", crossRead === null);

    // 4. Escritura cruzada: el UPDATE no toca ninguna fila (no falla, no escribe).
    const crossUpdate = await withOwner(userA, (tx) =>
      tx.likedItem.updateMany({ where: { id: itemB }, data: { tldr: "intruso" } }),
    );
    check(
      "withOwner(A) update de la señal de B afecta 0 filas",
      crossUpdate.count === 0,
      `afectó ${crossUpdate.count}`,
    );

    // 5. Escritura con dueño ajeno: WITH CHECK la rechaza aunque el código lo pida.
    let insertRejected = false;
    try {
      await withOwner(userA, (tx) =>
        tx.likedItem.create({
          data: {
            ownerId: userB,
            tweetId: `qa:intruso:${randomUUID()}`,
            authorHandle: "qa_intruso",
            tweetText: "señal plantada",
            tweetUrl: "https://example.test/intruso",
            likedAt: new Date(),
          },
        }),
      );
    } catch {
      insertRejected = true;
    }
    check("withOwner(A) no puede insertar una fila con owner_id de B (WITH CHECK)", insertRejected);

    // 6. La prueba de fuego: sin contexto de tenant, la tabla está vacía.
    const rawNoContext = await prisma.$queryRaw<
      Array<{ count: bigint }>
    >`SELECT count(*) AS count FROM liked_items`;
    check(
      "sin set_config (prisma directo) count(*) sobre liked_items devuelve 0 — RLS activo",
      rawCount(rawNoContext) === 0,
      `devolvió ${rawCount(rawNoContext)}; ¿DATABASE_URL apunta a un rol con BYPASSRLS?`,
    );

    // 7. El seed del tenant vive detrás de la misma barrera.
    await seedTenant(userA);
    const catsA = await withOwner(userA, (tx) => tx.category.count());
    const catsB = await withOwner(userB, (tx) => tx.category.count());
    check("seedTenant(A) sembró el catálogo de A", catsA === 10, `A tiene ${catsA}`);
    check("el catálogo de A no se ve desde B", catsB === 0, `B ve ${catsB}`);

    // 8. El bypass de plataforma sí ve los dos tenants (es lo que usa el seed).
    const total = await withPlatformBypass((tx) => tx.likedItem.count());
    check("withPlatformBypass ve las señales de ambos tenants", total === 2, `contó ${total}`);
  } finally {
    await withPlatformBypass(async (tx) => {
      // Cascade: se lleva señales, categorías, cuota y todo lo del tenant.
      await tx.user.deleteMany({ where: { id: { in: [userA, userB] } } });
    });
    console.log("\n[cleanup] usuarios de prueba borrados");
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
