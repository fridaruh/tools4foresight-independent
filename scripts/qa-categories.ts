/**
 * QA del CRUD de categorías por tenant (PLAN 4.3).
 *
 *   npm run qa:cats
 *
 * Crea un tenant con `seedTenant` (catálogo de plantilla: AI News, ..., Movies,
 * Otros con `isFallback`), le mete 4 `liked_items` (2 "AI News" + 1 "Otros",
 * las tres `category_source = 'auto'`, más 1 "AI News" `category_source =
 * 'manual'`) y ejercita las funciones puras de `src/lib/category-service.ts`
 * directamente sobre `withOwner` — sin pasar por HTTP, que es el punto de
 * haberlas extraído de las routes.
 *
 * Casos:
 *   1. renombrar "AI News" -> "Noticias IA": los 3 items (2 auto + 1 manual)
 *      quedan con el nombre nuevo.
 *   2. borrar "Movies" (no la usa nadie): ok.
 *   3. borrar la categoría fallback ("Otros"): falla con 409.
 *   4. recategorizeAuto: los 3 items `auto` quedan sin categoría; el manual
 *      conserva la suya.
 *   5. setFallback en otra categoría: solo esa queda `isFallback`.
 *
 * Al final borra el usuario de prueba (cascade se lleva categories/liked_items)
 * y cierra la conexión.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/prisma";
import { withOwner, withPlatformBypass } from "../src/lib/tenant-db";
import { seedTenant } from "../src/lib/seed-tenant";
import {
  CategoryServiceError,
  deleteCategory,
  getCategoriesOverview,
  recategorizeAuto,
  updateCategory,
} from "../src/lib/category-service";

let failures = 0;

function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function makeUser(): Promise<string> {
  const id = randomUUID();
  await withPlatformBypass((tx) =>
    tx.user.create({
      data: {
        id,
        name: "QA categories",
        email: `qa-categories-${id}@tools4foresight.test`,
        role: "user",
      },
    }),
  );
  await seedTenant(id);
  return id;
}

async function main() {
  const ownerId = await makeUser();

  try {
    // --- Fixtures: 4 liked_items -------------------------------------------
    await withOwner(ownerId, async (tx) => {
      await tx.likedItem.create({
        data: {
          ownerId,
          tweetId: `qa-cats:1:${randomUUID()}`,
          authorHandle: "qa_cats",
          tweetText: "Un laboratorio anuncia su nuevo modelo insignia.",
          tweetUrl: "https://example.test/1",
          likedAt: new Date(),
          fetchStatus: "not_applicable",
          category: "AI News",
          categorySource: "auto",
        },
      });
      await tx.likedItem.create({
        data: {
          ownerId,
          tweetId: `qa-cats:2:${randomUUID()}`,
          authorHandle: "qa_cats",
          tweetText: "Otra noticia de un lanzamiento de IA.",
          tweetUrl: "https://example.test/2",
          likedAt: new Date(),
          fetchStatus: "not_applicable",
          category: "AI News",
          categorySource: "auto",
        },
      });
      await tx.likedItem.create({
        data: {
          ownerId,
          tweetId: `qa-cats:3:${randomUUID()}`,
          authorHandle: "qa_cats",
          tweetText: "Recordatorio de que hoy es martes.",
          tweetUrl: "https://example.test/3",
          likedAt: new Date(),
          fetchStatus: "not_applicable",
          category: "Otros",
          categorySource: "auto",
        },
      });
      await tx.likedItem.create({
        data: {
          ownerId,
          tweetId: `qa-cats:4:${randomUUID()}`,
          authorHandle: "qa_cats",
          tweetText: "Este lo corregí a mano y lo dejé en AI News.",
          tweetUrl: "https://example.test/4",
          likedAt: new Date(),
          fetchStatus: "not_applicable",
          category: "AI News",
          categorySource: "manual",
        },
      });
    });

    // --- 1. Renombrar "AI News" -> "Noticias IA" ----------------------------
    const aiNews = await withOwner(ownerId, async (tx) => {
      const overview = await getCategoriesOverview(tx, ownerId);
      return overview.categories.find((c) => c.name === "AI News");
    });
    check("el catálogo sembrado trae 'AI News'", !!aiNews);

    if (aiNews) {
      await withOwner(ownerId, (tx) =>
        updateCategory(tx, ownerId, aiNews.id, { name: "Noticias IA" }),
      );

      const renamed = await withOwner(ownerId, (tx) =>
        tx.likedItem.count({ where: { ownerId, category: "Noticias IA" } }),
      );
      check("renombrar 'AI News' -> 'Noticias IA' actualiza los 3 items", renamed === 3, `quedaron ${renamed}`);

      const staleName = await withOwner(ownerId, (tx) =>
        tx.likedItem.count({ where: { ownerId, category: "AI News" } }),
      );
      check("ya no queda ningún item con el nombre viejo", staleName === 0, `quedaron ${staleName}`);
    }

    // --- 2. Borrar "Movies" (nadie la usa) ----------------------------------
    const movies = await withOwner(ownerId, async (tx) => {
      const overview = await getCategoriesOverview(tx, ownerId);
      return overview.categories.find((c) => c.name === "Movies");
    });
    check("el catálogo sembrado trae 'Movies'", !!movies);

    if (movies) {
      let deletedMovies = false;
      try {
        await withOwner(ownerId, (tx) => deleteCategory(tx, ownerId, movies.id));
        deletedMovies = true;
      } catch (error) {
        check("borrar 'Movies' no debería fallar", false, String(error));
      }
      check("borrar 'Movies' funciona", deletedMovies);

      const stillThere = await withOwner(ownerId, async (tx) => {
        const overview = await getCategoriesOverview(tx, ownerId);
        return overview.categories.some((c) => c.id === movies.id);
      });
      check("'Movies' ya no está en el catálogo", !stillThere);
    }

    // --- 3. Borrar la fallback falla ----------------------------------------
    const fallback = await withOwner(ownerId, async (tx) => {
      const overview = await getCategoriesOverview(tx, ownerId);
      return overview.categories.find((c) => c.isFallback);
    });
    check("hay una categoría fallback", !!fallback);

    if (fallback) {
      let failedAsExpected = false;
      let status = 0;
      try {
        await withOwner(ownerId, (tx) => deleteCategory(tx, ownerId, fallback.id));
      } catch (error) {
        failedAsExpected = error instanceof CategoryServiceError;
        status = error instanceof CategoryServiceError ? error.status : 0;
      }
      check("borrar la fallback lanza CategoryServiceError", failedAsExpected);
      check("el error de borrar la fallback es 409", status === 409, `status ${status}`);
    }

    // --- 4. recategorizeAuto -------------------------------------------------
    const recatCount = await withOwner(ownerId, (tx) => recategorizeAuto(tx, ownerId));
    check("recategorizeAuto reporta 3 items tocados", recatCount === 3, `reportó ${recatCount}`);

    const nullAfterRecat = await withOwner(ownerId, (tx) =>
      tx.likedItem.count({ where: { ownerId, category: null, categorySource: "auto" } }),
    );
    check("los 3 items 'auto' quedaron sin categoría", nullAfterRecat === 3, `quedaron ${nullAfterRecat}`);

    const manualSurvives = await withOwner(ownerId, (tx) =>
      tx.likedItem.count({ where: { ownerId, categorySource: "manual", category: { not: null } } }),
    );
    check("el item 'manual' conserva su categoría", manualSurvives === 1, `quedaron ${manualSurvives}`);

    // --- 5. setFallback en otra categoría -----------------------------------
    const startup = await withOwner(ownerId, async (tx) => {
      const overview = await getCategoriesOverview(tx, ownerId);
      return overview.categories.find((c) => c.name === "Startup & Business");
    });
    check("el catálogo sembrado trae 'Startup & Business'", !!startup);

    if (startup) {
      await withOwner(ownerId, (tx) => updateCategory(tx, ownerId, startup.id, { isFallback: true }));

      const fallbacks = await withOwner(ownerId, async (tx) => {
        const overview = await getCategoriesOverview(tx, ownerId);
        return overview.categories.filter((c) => c.isFallback);
      });
      check("solo una categoría queda marcada como fallback", fallbacks.length === 1, `hay ${fallbacks.length}`);
      check(
        "la fallback nueva es 'Startup & Business'",
        fallbacks[0]?.name === "Startup & Business",
        fallbacks[0]?.name,
      );
    }
  } finally {
    await withPlatformBypass((tx) => tx.user.deleteMany({ where: { id: ownerId } }));
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
