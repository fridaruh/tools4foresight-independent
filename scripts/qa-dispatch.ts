/**
 * QA del dispatcher y del runner (Fase 3, tareas 3.1b y 3.11).
 *
 *   npm run qa:dispatch
 *
 * Qué se puede probar sin `next dev` arriba: la parte pura. El fan-out de
 * `dispatch()` hace HTTP contra `/api/jobs/<job>/run`, así que no entra aquí;
 * lo que sí entra es todo lo que decide A QUIÉN se despacha, que es donde un
 * error cruza datos entre tenants.
 *
 * Se crean dos tenants:
 *   A — con XAuthToken (falso, pero cifrado de verdad con token-crypto) y cursor.
 *   B — sin conectar X.
 *
 * Y se comprueba:
 *   1. `listEligibleTenants("ingest")` trae a A y no a B.
 *   2. `listEligibleTenants("graph")` no trae a A hasta que se le pone
 *      `graphDirtyAt` — el debounce de PLAN 3.10.
 *   3. `retryAfter` en el futuro saca a A de `ingest` (429 de X) pero NO de las
 *      otras etapas.
 *   4. `pipelineEnabled = false` lo saca de todas.
 *   5. `runJob("fetch", A)` deja un `job_run` con status ok y processed 0
 *      (el tenant no tiene items).
 *   6. `claimCooldown` deja pasar una vez y bloquea la segunda.
 *
 * Al final borra los dos usuarios.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/prisma";
import { withOwner, withPlatformBypass } from "../src/lib/tenant-db";
import { seedTenant } from "../src/lib/seed-tenant";
import { encryptToken } from "../src/lib/token-crypto";
import { listEligibleTenants } from "../src/lib/jobs/dispatcher";
import { claimCooldown, runJob } from "../src/lib/jobs/runner";

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
        email: `qa-dispatch-${label}-${id}@tools4foresight.test`,
        role: "user",
      },
    }),
  );
  await seedTenant(id);
  return id;
}

/** Un XAuthToken plausible: los tokens van cifrados igual que los de verdad. */
async function connectX(userId: string) {
  await withOwner(userId, (tx) =>
    tx.xAuthToken.create({
      data: {
        userId,
        xUserId: `qa-${userId.slice(0, 8)}`,
        accessToken: encryptToken(`qa-access-${userId}`),
        refreshToken: encryptToken(`qa-refresh-${userId}`),
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    }),
  );
  await withOwner(userId, (tx) =>
    tx.ingestionCursor.create({ data: { userId, lastStatus: "idle" } }),
  );
}

async function main() {
  const a = await makeUser("a");
  const b = await makeUser("b");

  try {
    await connectX(a);

    // --- 1. ingest: solo el que tiene X conectado ---
    const ingest = await listEligibleTenants("ingest");
    check("ingest incluye al tenant con X conectado", ingest.includes(a));
    check("ingest excluye al tenant sin XAuthToken", !ingest.includes(b));

    // --- 2. graph: solo los marcados como sucios ---
    const graphBefore = await listEligibleTenants("graph");
    check(
      "graph no incluye a nadie mientras graphDirtyAt sea null",
      !graphBefore.includes(a) && !graphBefore.includes(b),
      `trajo ${graphBefore.length} tenant(s)`,
    );

    await withOwner(a, (tx) =>
      tx.userQuota.updateMany({ where: { userId: a }, data: { graphDirtyAt: new Date() } }),
    );

    const graphAfter = await listEligibleTenants("graph");
    check("graph incluye al tenant tras marcar graphDirtyAt", graphAfter.includes(a));
    check("graph sigue sin incluir al tenant sin X", !graphAfter.includes(b));

    // --- 3. retryAfter (429 de X) saca de ingest, no del resto ---
    await withOwner(a, (tx) =>
      tx.ingestionCursor.updateMany({
        where: { userId: a },
        data: { retryAfter: new Date(Date.now() + 3_600_000) },
      }),
    );

    check(
      "ingest excluye al tenant con retryAfter en el futuro",
      !(await listEligibleTenants("ingest")).includes(a),
    );
    check(
      "analyze NO se ve afectado por retryAfter (es límite de X, no del pipeline)",
      (await listEligibleTenants("analyze")).includes(a),
    );

    await withOwner(a, (tx) =>
      tx.ingestionCursor.updateMany({ where: { userId: a }, data: { retryAfter: null } }),
    );

    // --- 4. pipelineEnabled = false lo saca de todo ---
    await withOwner(a, (tx) =>
      tx.userQuota.updateMany({ where: { userId: a }, data: { pipelineEnabled: false } }),
    );
    const disabled = await Promise.all([
      listEligibleTenants("ingest"),
      listEligibleTenants("analyze"),
      listEligibleTenants("graph"),
    ]);
    check(
      "pipelineEnabled=false saca al tenant de ingest, analyze y graph",
      disabled.every((list) => !list.includes(a)),
    );
    await withOwner(a, (tx) =>
      tx.userQuota.updateMany({ where: { userId: a }, data: { pipelineEnabled: true } }),
    );

    // --- 5. runJob deja la corrida registrada ---
    const run = await runJob("fetch", a, { trigger: "manual", budgetMs: 20_000 });
    check("runJob('fetch') devuelve ok", run.ok === true, run.error ?? "");
    check("runJob('fetch') sin items procesa 0", run.processed === 0, `procesó ${run.processed}`);

    const jobRun = await withOwner(a, (tx) =>
      tx.jobRun.findFirst({ where: { ownerId: a, id: run.runId } }),
    );
    check("quedó la fila en job_runs", jobRun !== null);
    check("job_runs.status = ok", jobRun?.status === "ok", `es ${jobRun?.status}`);
    check("job_runs.job = fetch", jobRun?.job === "fetch", `es ${jobRun?.job}`);
    check("job_runs.finishedAt quedó puesto", jobRun?.finishedAt !== null);

    const foreign = await withOwner(b, (tx) => tx.jobRun.findMany({ where: { ownerId: b } }));
    check("el JobRun de A no aparece en el tenant B", foreign.length === 0, `B ve ${foreign.length}`);

    // --- 6. cooldown de las acciones manuales ---
    const first = await claimCooldown(a, "lastManualSyncAt", 30 * 60 * 1000);
    const second = await claimCooldown(a, "lastManualSyncAt", 30 * 60 * 1000);
    check("el primer claim del cooldown pasa", first.ok === true);
    check("el segundo claim del cooldown se bloquea", second.ok === false);
  } finally {
    await withPlatformBypass((tx) => tx.user.deleteMany({ where: { id: { in: [a, b] } } }));
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
