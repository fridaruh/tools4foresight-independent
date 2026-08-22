/**
 * QA del panel de plataforma y de las alertas (PLAN Fase 5, tareas 5.1/5.2).
 *
 *   npm run qa:admin
 *
 * Crea un `platform_admin` y dos tenants (A, B) con `UsageEvent` de distintos
 * `kind`, un `LikedItem` publicado y uno sin publicar, y un `JobRun`. Comprueba:
 *
 *   1. `getAdminOverview` (src/lib/admin-service.ts) trae las filas de A y B con
 *      items/publicados y el desglose de uso 30d correctos — sin pasar por HTTP.
 *   2. `updateTenantQuota` cambia `xPagesPerDay` de verdad en la DB.
 *   3. `sendAdminAlert` (src/lib/alerts.ts) con `RESEND_API_KEY` vacío no lanza,
 *      devuelve `{ skipped: false, sent: false }` y deja el flag de dedupe
 *      (`platform_flags` con key `alert:<kind>:lastSentAt`).
 *   4. Una segunda llamada con el mismo `kind` dentro de las 24 h devuelve
 *      `{ skipped: true }`.
 *
 * Al final borra los usuarios y el flag de dedupe de prueba.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/prisma";
import { withOwner, withPlatformBypass } from "../src/lib/tenant-db";
import { seedTenant } from "../src/lib/seed-tenant";
import { getAdminOverview, updateTenantQuota } from "../src/lib/admin-service";
import { sendAdminAlert } from "../src/lib/alerts";

let failures = 0;

function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function makeUser(label: string, role: "user" | "platform_admin" = "user"): Promise<string> {
  const id = randomUUID();
  await withPlatformBypass((tx) =>
    tx.user.create({
      data: {
        id,
        name: `QA ${label}`,
        email: `qa-admin-${label}-${id}@tools4foresight.test`,
        role,
      },
    }),
  );
  await seedTenant(id);
  return id;
}

async function main() {
  const admin = await makeUser("admin", "platform_admin");
  const userA = await makeUser("a");
  const userB = await makeUser("b");
  const testAlertKind = `qa_admin_${randomUUID()}`;

  try {
    // --- Fixtures de A: items + uso + JobRun ---
    await withOwner(userA, async (tx) => {
      await tx.likedItem.create({
        data: {
          ownerId: userA,
          tweetId: `qa-admin:a:pub:${randomUUID()}`,
          authorHandle: "qa_a",
          tweetText: "Señal publicada de A",
          tweetUrl: "https://example.test/a/1",
          likedAt: new Date(),
          publishStatus: "published",
        },
      });
      await tx.likedItem.create({
        data: {
          ownerId: userA,
          tweetId: `qa-admin:a:pending:${randomUUID()}`,
          authorHandle: "qa_a",
          tweetText: "Señal pendiente de A",
          tweetUrl: "https://example.test/a/2",
          likedAt: new Date(),
          publishStatus: "pending",
        },
      });
      await tx.usageEvent.create({ data: { userId: userA, kind: "x_page", units: 1 } });
      await tx.usageEvent.create({ data: { userId: userA, kind: "x_page", units: 1 } });
      await tx.usageEvent.create({ data: { userId: userA, kind: "ollama_call", units: 1 } });
      await tx.usageEvent.create({
        data: { userId: userA, kind: "anthropic_call", units: 1, tokensIn: 100, tokensOut: 40 },
      });
      await tx.usageEvent.create({
        data: { userId: userA, kind: "openai_embed", units: 1, tokensIn: 250, tokensOut: 0 },
      });
      await tx.jobRun.create({
        data: {
          ownerId: userA,
          job: "categorize",
          status: "ok",
          startedAt: new Date(),
          finishedAt: new Date(),
          processed: 2,
        },
      });
    });

    // --- Fixtures de B: un item sin publicar, sin uso ---
    await withOwner(userB, (tx) =>
      tx.likedItem.create({
        data: {
          ownerId: userB,
          tweetId: `qa-admin:b:${randomUUID()}`,
          authorHandle: "qa_b",
          tweetText: "Señal de B",
          tweetUrl: "https://example.test/b/1",
          likedAt: new Date(),
        },
      }),
    );

    // --- 1. getAdminOverview ---
    const overview = await withPlatformBypass((tx) => getAdminOverview(tx));
    const rows = overview.tenants.filter((t) => t.userId === userA || t.userId === userB);
    check("getAdminOverview trae 2 filas (A y B)", rows.length === 2, `trajo ${rows.length}`);

    const rowA = overview.tenants.find((t) => t.userId === userA);
    const rowB = overview.tenants.find((t) => t.userId === userB);

    check("A tiene 2 items totales", rowA?.itemsTotal === 2, `es ${rowA?.itemsTotal}`);
    check("A tiene 1 item publicado", rowA?.itemsPublished === 1, `es ${rowA?.itemsPublished}`);
    check("B tiene 1 item total, 0 publicados", rowB?.itemsTotal === 1 && rowB?.itemsPublished === 0);
    check(
      "el uso 30d de A: 2 x_page, 1 ollama_call",
      rowA?.usage30d.xPageCalls === 2 && rowA?.usage30d.ollamaCalls === 1,
      JSON.stringify(rowA?.usage30d),
    );
    check(
      "el uso 30d de A: anthropic 100 in / 40 out",
      rowA?.usage30d.anthropic.tokensIn === 100 && rowA?.usage30d.anthropic.tokensOut === 40,
      JSON.stringify(rowA?.usage30d.anthropic),
    );
    check(
      "el uso 30d de A: openai_embed 250 in",
      rowA?.usage30d.openaiEmbed.tokensIn === 250,
      JSON.stringify(rowA?.usage30d.openaiEmbed),
    );
    check(
      "el uso 30d de B está en cero (sin UsageEvent)",
      rowB?.usage30d.xPageCalls === 0 && rowB?.usage30d.ollamaCalls === 0,
      JSON.stringify(rowB?.usage30d),
    );
    check(
      "el último JobRun de A es categorize/ok",
      rowA?.lastJobRun?.job === "categorize" && rowA?.lastJobRun?.status === "ok",
      JSON.stringify(rowA?.lastJobRun),
    );
    check("B no tiene JobRun", rowB?.lastJobRun === null, JSON.stringify(rowB?.lastJobRun));
    check(
      "los totales cuentan a A y B como tenants",
      overview.totals.tenants >= 3, // admin + A + B, al menos
      `tenants=${overview.totals.tenants}`,
    );
    check(
      "active7d incluye a A (JobRun ok reciente)",
      overview.totals.active7d >= 1,
      `active7d=${overview.totals.active7d}`,
    );

    // --- 2. updateTenantQuota ---
    const before = await withPlatformBypass((tx) => tx.userQuota.findUnique({ where: { userId: userA } }));
    check("A arranca con xPagesPerDay default (2)", before?.xPagesPerDay === 2, `es ${before?.xPagesPerDay}`);

    const patched = await withPlatformBypass((tx) => updateTenantQuota(tx, userA, { xPagesPerDay: 9 }));
    check("updateTenantQuota devuelve xPagesPerDay=9", patched.xPagesPerDay === 9, `es ${patched.xPagesPerDay}`);

    const after = await withPlatformBypass((tx) => tx.userQuota.findUnique({ where: { userId: userA } }));
    check(
      "la cuota de A quedó en 9 en la DB",
      after?.xPagesPerDay === 9,
      `es ${after?.xPagesPerDay}`,
    );

    // --- 3 y 4. sendAdminAlert sin RESEND_API_KEY ---
    const savedResendKey = process.env.RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;

    try {
      const first = await sendAdminAlert(testAlertKind, "QA alerta", "cuerpo de prueba");
      check(
        "sendAdminAlert sin RESEND_API_KEY no lanza y no manda de verdad",
        first.skipped === false && first.sent === false,
        JSON.stringify(first),
      );

      const flag = await withPlatformBypass((tx) =>
        tx.platformFlag.findUnique({ where: { key: `alert:${testAlertKind}:lastSentAt` } }),
      );
      check("dejó el flag de dedupe en platform_flags", flag !== null, JSON.stringify(flag));

      const second = await sendAdminAlert(testAlertKind, "QA alerta", "cuerpo de prueba 2");
      check(
        "la segunda llamada (<24h, mismo kind) devuelve { skipped: true }",
        second.skipped === true,
        JSON.stringify(second),
      );
    } finally {
      if (savedResendKey !== undefined) process.env.RESEND_API_KEY = savedResendKey;
    }
  } finally {
    await withPlatformBypass((tx) => tx.user.deleteMany({ where: { id: { in: [admin, userA, userB] } } }));
    await withPlatformBypass((tx) =>
      tx.platformFlag.deleteMany({ where: { key: `alert:${testAlertKind}:lastSentAt` } }),
    );
    console.log("\n[cleanup] usuarios y flag de prueba borrados");
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
