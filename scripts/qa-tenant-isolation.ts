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
import { withOwner, withPlatformBypass, TENANT_MODEL_FIELD } from "../src/lib/tenant-db";
import { seedTenant } from "../src/lib/seed-tenant";

/**
 * Las tablas que NO llevan política de RLS, y que por lo tanto tienen que estar
 * declaradas aquí a mano. Es la misma lista del comentario de cabecera de
 * src/lib/tenant-db.ts, y el check 9 la compara contra la base: una tabla nueva
 * sin política que nadie declaró hace fallar el QA en vez de pasar desapercibida.
 *
 *   - users/sessions/accounts/verifications: better-auth. `getSession()` corre
 *     ANTES de que exista un `app.owner_id` que fijar.
 *   - api_keys: mismo argumento con `Bearer` en vez de cookie. `resolveApiKey()`
 *     es el query que DESCUBRE al tenant (src/lib/api-keys.ts); con RLS encima
 *     devolvería cero filas y nadie podría autenticarse. Se compensa en la
 *     aplicación: todo acceso lleva `user_id` en el `where`.
 *   - rate_limits/platform_flags: son de la plataforma, no de nadie.
 *   - _prisma_migrations: metadata de Prisma.
 */
const NON_TENANT_TABLES = new Set([
  "users",
  "sessions",
  "accounts",
  "verifications",
  "api_keys",
  "rate_limits",
  "platform_flags",
  "_prisma_migrations",
]);

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

/**
 * Compara el estado real de la base contra las dos listas del código.
 *
 * No hace falta traducir modelo -> nombre de tabla (`likedItem` -> `liked_items`
 * no es derivable): basta con partir las tablas de `public` en dos por su
 * `rowsecurity` y comprobar que las que NO tienen política son exactamente
 * `NON_TENANT_TABLES`, y que las que sí son tantas como entradas hay en
 * `TENANT_MODEL_FIELD`. Cualquier tabla nueva cae en un lado o en el otro, y las
 * dos direcciones fallan si no se declaró.
 */
async function checkRlsCoverage(): Promise<void> {
  const tablas = await prisma.$queryRaw<Array<{ tablename: string; rowsecurity: boolean }>>`
    SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public'
  `;

  const sinRls = tablas.filter((t) => !t.rowsecurity).map((t) => t.tablename).sort();
  const conRls = tablas.filter((t) => t.rowsecurity).map((t) => t.tablename).sort();

  const noDeclaradas = sinRls.filter((t) => !NON_TENANT_TABLES.has(t));
  check(
    "toda tabla sin RLS está declarada como excepción en NON_TENANT_TABLES",
    noDeclaradas.length === 0,
    `sin política y sin declarar: ${noDeclaradas.join(", ")}`,
  );

  const declaradasQueSiTienen = [...NON_TENANT_TABLES].filter((t) => conRls.includes(t));
  check(
    "ninguna excepción declarada tiene política de RLS (la lista no está obsoleta)",
    declaradasQueSiTienen.length === 0,
    `declaradas como excepción pero con política: ${declaradasQueSiTienen.join(", ")}`,
  );

  check(
    "api_keys existe y está en la excepción documentada (resolveApiKey descubre al tenant)",
    sinRls.includes("api_keys"),
    tablas.some((t) => t.tablename === "api_keys")
      ? "api_keys tiene RLS: resolveApiKey devolvería cero filas y nadie podría autenticarse"
      : "la tabla api_keys no existe; ¿falta correr la migración?",
  );

  const esperadas = Object.keys(TENANT_MODEL_FIELD).length;
  check(
    "hay tantas tablas con RLS como modelos en TENANT_MODEL_FIELD",
    conRls.length === esperadas,
    `la base tiene ${conRls.length} con política y TENANT_MODEL_FIELD lista ${esperadas}: ${conRls.join(", ")}`,
  );
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
    // Se cuenta acotando a los dos usuarios de prueba, no la tabla entera: una
    // base de desarrollo tiene señales reales y un `count()` sin filtro haría
    // fallar el check por dato, no por una fuga — que es justo lo que este
    // script existe para detectar. Lo que se afirma es que el bypass ve a LOS
    // DOS tenants, y para eso los dos ids son la muestra exacta.
    const total = await withPlatformBypass((tx) =>
      tx.likedItem.count({ where: { ownerId: { in: [userA, userB] } } }),
    );
    check("withPlatformBypass ve las señales de ambos tenants", total === 2, `contó ${total}`);

    // 9. Cobertura: la lista de tablas con RLS en la base contra las dos listas
    // que mantiene el código (TENANT_MODEL_FIELD y NON_TENANT_TABLES). Es lo que
    // convierte las excepciones —`api_keys` la más reciente— en algo declarado y
    // verificado, no en un hueco que nadie nota hasta que filtra.
    await checkRlsCoverage();
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
