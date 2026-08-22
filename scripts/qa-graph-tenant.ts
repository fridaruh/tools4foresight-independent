/**
 * QA del grafo por tenant y del job de embeddings (PLAN §3.8 y §3.9).
 *
 *   npm run qa:graph
 *
 * Qué comprueba, y por qué importa:
 *
 *   1. `runGraph` de A construye SOLO el grafo de A: aristas, temas y snapshot
 *      con `ownerId = A`, y CERO filas para B aunque B tenga señales publicadas
 *      con embeddings casi idénticos.
 *   2. Correr `runGraph` para B no mueve nada de A — ni el conteo de aristas ni
 *      el `membersHash` de sus temas. Ese es el bug que la tarea 3.9 arregla:
 *      antes `recomputeLinks()` hacía `DELETE FROM semantic_links` sin `WHERE`.
 *   3. `runEmbed` sin `OPENAI_API_KEY` devuelve `ok:false` con un mensaje
 *      accionable y NO toca la base (ni un `usage_event`).
 *
 * Datos sintéticos: 6 señales publicadas por tenant con embeddings de 1536
 * dimensiones fabricados a mano — tres apuntando a la primera mitad del espacio
 * y tres a la segunda. Coseno ~1 dentro de cada trío y 0 entre tríos, así que el
 * detector tiene que encontrar exactamente 2 comunidades por tenant.
 *
 * Ollama: NO se llama a ollama.com. Un servidor HTTP local hace de `/api/chat` y
 * responde el `{ message: { content: "{\"name\":…}" } }` que `nameCluster`
 * espera. OpenAI tampoco se toca: los embeddings se insertan a mano.
 */
import "dotenv/config";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

// Estos parámetros se leen en el `import` de los módulos del grafo (son `const`
// de nivel de módulo), así que hay que fijarlos ANTES de importarlos — de ahí
// que graph.ts y embed.ts entren por `await import()` más abajo y no arriba.
process.env.SEMANTIC_LINK_THRESHOLD = "0.55";
process.env.SEMANTIC_LINK_TOP_K = "8";
process.env.SEMANTIC_CLUSTER_MIN_SIZE = "3";
process.env.GRAPH_HALF_LIFE_DAYS = "30";

import { prisma } from "../src/lib/prisma";
import { withOwner, withPlatformBypass } from "../src/lib/tenant-db";
import { seedTenant } from "../src/lib/seed-tenant";
import type { JobContext } from "../src/lib/jobs/types";

const EMBED_DIMS = 1536;

let failures = 0;

function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// Mock de Ollama
// ---------------------------------------------------------------------------

/**
 * `/api/chat` falso. `nameCluster` lee `body.message.content` y le hace
 * JSON.parse esperando `{name, summary}` (ver parseName en clusters.ts), así que
 * el contenido va como string JSON dentro del sobre de Ollama.
 */
async function startOllamaMock(): Promise<{ server: Server; calls: () => number }> {
  let calls = 0;
  const server = createServer((req, res) => {
    calls += 1;
    const n = calls;
    // Consumir el body: si no, el socket puede quedar a medias.
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          message: {
            content: JSON.stringify({
              name: `Tema ${n}`,
              summary: `Resumen sintético del tema ${n} para el QA del grafo.`,
            }),
          },
        }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  process.env.OLLAMA_HOST = `http://127.0.0.1:${port}`;
  process.env.OLLAMA_API_KEY = "qa-fake-key"; // ollamaConfig() lanza si falta
  return { server, calls: () => calls };
}

// ---------------------------------------------------------------------------
// Siembra
// ---------------------------------------------------------------------------

async function makeUser(label: string): Promise<string> {
  const id = randomUUID();
  await withPlatformBypass((tx) =>
    tx.user.create({
      data: {
        id,
        name: `QA ${label}`,
        email: `qa-graph-${label}-${id}@tools4foresight.test`,
        role: "user",
      },
    }),
  );
  await seedTenant(id);
  return id;
}

/**
 * Vector de 1536 dims: el grupo 0 llena la primera mitad, el grupo 1 la segunda.
 * Coseno dentro del grupo ≈ 1 (arriba del umbral 0.55) y exactamente 0 entre
 * grupos (los soportes son disjuntos), con una perturbación por miembro para que
 * no sean idénticos.
 */
function synthVector(group: 0 | 1, k: number): number[] {
  const v = new Array<number>(EMBED_DIMS).fill(0);
  const start = group === 0 ? 0 : EMBED_DIMS / 2;
  for (let i = start; i < start + EMBED_DIMS / 2; i += 1) v[i] = 1;
  v[start + k] += 0.05;
  return v;
}

/** 6 señales publicadas con embedding: 3 del grupo 0 y 3 del grupo 1. */
async function seedPublishedItems(ownerId: string, label: string): Promise<string[]> {
  const ids: string[] = [];
  const now = new Date();

  for (let i = 0; i < 6; i += 1) {
    const group = (i < 3 ? 0 : 1) as 0 | 1;
    const id = await withOwner(ownerId, async (tx) => {
      const item = await tx.likedItem.create({
        data: {
          ownerId,
          tweetId: `qa-graph:${label}:${i}:${randomUUID()}`,
          authorHandle: `qa_${label}`,
          tweetText: `señal ${i} del grupo ${group} de ${label}`,
          tweetUrl: `https://example.test/${label}/${i}`,
          contentTitle: `Señal ${i} (${label})`,
          tldr: `TL;DR sintético de la señal ${i} del grupo ${group}.`,
          whyMatters: `Importa porque es la señal ${i} del grupo ${group}.`,
          likedAt: now,
          publishStatus: "published",
          publishedAt: now,
        },
        select: { id: true },
      });

      const literal = `[${synthVector(group, i % 3).join(",")}]`;
      await tx.$executeRaw`
        UPDATE liked_items
        SET embedding = ${literal}::vector,
            embedding_hash = ${`qa-hash-${label}-${i}`},
            embedded_at = now()
        WHERE id = ${item.id} AND owner_id = ${ownerId}`;

      return item.id;
    });
    ids.push(id);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Lecturas de verificación
// ---------------------------------------------------------------------------

type TenantSnapshot = {
  links: number;
  clusters: number;
  clustersMineOnly: boolean;
  snapshots: number;
  membersHashes: string[];
  graphDirtyAt: Date | null;
};

async function readTenant(ownerId: string): Promise<TenantSnapshot> {
  return withOwner(ownerId, async (tx) => {
    const links = await tx.semanticLink.count({ where: { ownerId } });
    const clusters = await tx.semanticCluster.findMany({
      where: { ownerId },
      select: { ownerId: true, membersHash: true },
      orderBy: { membersHash: "asc" },
    });
    const snapshots = await tx.graphSnapshot.count({ where: { ownerId } });
    const quota = await tx.userQuota.findFirst({
      where: { userId: ownerId },
      select: { graphDirtyAt: true },
    });
    return {
      links,
      clusters: clusters.length,
      clustersMineOnly: clusters.every((c) => c.ownerId === ownerId),
      snapshots,
      membersHashes: clusters.map((c) => c.membersHash),
      graphDirtyAt: quota?.graphDirtyAt ?? null,
    };
  });
}

function ctxFor(ownerId: string): JobContext {
  return {
    ownerId,
    budgetMs: 240_000,
    startedAt: Date.now(),
    runId: `qa-${randomUUID()}`,
    trigger: "manual",
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const mock = await startOllamaMock();

  // Import diferido: los módulos del grafo congelan sus umbrales al cargarse.
  const { runGraph } = await import("../src/lib/jobs/graph");
  const { runEmbed } = await import("../src/lib/jobs/embed");

  const userA = await makeUser("a");
  const userB = await makeUser("b");

  try {
    await seedPublishedItems(userA, "a");
    await seedPublishedItems(userB, "b");

    // Marcamos los dos tenants como sucios: runGraph tiene que limpiar SOLO el suyo.
    await withPlatformBypass((tx) =>
      tx.userQuota.updateMany({
        where: { userId: { in: [userA, userB] } },
        data: { graphDirtyAt: new Date() },
      }),
    );

    // ── 1. runGraph para A ───────────────────────────────────────────────────
    const resultA = await runGraph(ctxFor(userA));
    check("runGraph(A) devolvió ok", resultA.ok === true, resultA.error ?? "");
    check(
      "runGraph(A) reporta 6 nodos y 2 temas",
      resultA.processed === 6 && (resultA.details?.clusters as number) === 2,
      `processed=${resultA.processed} clusters=${resultA.details?.clusters}`,
    );

    const a1 = await readTenant(userA);
    const b1 = await readTenant(userB);

    check("A tiene semantic_links > 0", a1.links > 0, `tiene ${a1.links}`);
    check("A tiene exactamente 2 temas", a1.clusters === 2, `tiene ${a1.clusters}`);
    check("los temas de A llevan ownerId = A", a1.clustersMineOnly);
    check("A tiene exactamente 1 snapshot", a1.snapshots === 1, `tiene ${a1.snapshots}`);
    check("A quedó con graphDirtyAt = null", a1.graphDirtyAt === null, `es ${a1.graphDirtyAt}`);

    check("B sigue con 0 semantic_links", b1.links === 0, `tiene ${b1.links}`);
    check("B sigue con 0 temas", b1.clusters === 0, `tiene ${b1.clusters}`);
    check("B sigue con 0 snapshots", b1.snapshots === 0, `tiene ${b1.snapshots}`);
    check(
      "B conserva su graphDirtyAt (runGraph(A) no lo limpió)",
      b1.graphDirtyAt !== null,
      `es ${b1.graphDirtyAt}`,
    );

    // ── 2. runGraph para B no toca A ─────────────────────────────────────────
    const resultB = await runGraph(ctxFor(userB));
    check("runGraph(B) devolvió ok", resultB.ok === true, resultB.error ?? "");

    const a2 = await readTenant(userA);
    const b2 = await readTenant(userB);

    check("B tiene semantic_links > 0 tras su corrida", b2.links > 0, `tiene ${b2.links}`);
    check("B tiene exactamente 2 temas", b2.clusters === 2, `tiene ${b2.clusters}`);
    check("B tiene exactamente 1 snapshot", b2.snapshots === 1, `tiene ${b2.snapshots}`);

    check(
      "el conteo de semantic_links de A no cambió",
      a2.links === a1.links,
      `antes ${a1.links}, ahora ${a2.links}`,
    );
    check(
      "el conteo de temas de A no cambió",
      a2.clusters === a1.clusters,
      `antes ${a1.clusters}, ahora ${a2.clusters}`,
    );
    check(
      "los membersHash de los temas de A no cambiaron",
      JSON.stringify(a2.membersHashes) === JSON.stringify(a1.membersHashes),
      `antes ${JSON.stringify(a1.membersHashes)}, ahora ${JSON.stringify(a2.membersHashes)}`,
    );
    check(
      "A sigue con 1 snapshot (la corrida de B no le creó otro)",
      a2.snapshots === 1,
      `tiene ${a2.snapshots}`,
    );

    check("el mock de Ollama recibió los 4 bautizos (2 por tenant)", mock.calls() === 4, `recibió ${mock.calls()}`);

    // ── 3. runEmbed sin OPENAI_API_KEY ───────────────────────────────────────
    const savedKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    const usageBefore = await withOwner(userA, (tx) => tx.usageEvent.count({ where: { userId: userA } }));
    const embedResult = await runEmbed(ctxFor(userA));
    const usageAfter = await withOwner(userA, (tx) => tx.usageEvent.count({ where: { userId: userA } }));

    if (savedKey !== undefined) process.env.OPENAI_API_KEY = savedKey;

    check("runEmbed sin key devuelve ok:false", embedResult.ok === false);
    check(
      "runEmbed sin key explica que falta OPENAI_API_KEY",
      (embedResult.error ?? "").includes("OPENAI_API_KEY"),
      `error: ${embedResult.error}`,
    );
    check("runEmbed sin key no procesó nada", embedResult.processed === 0, `procesó ${embedResult.processed}`);
    check(
      "runEmbed sin key no escribió usage_events",
      usageAfter === usageBefore,
      `antes ${usageBefore}, ahora ${usageAfter}`,
    );
  } finally {
    await withPlatformBypass((tx) => tx.user.deleteMany({ where: { id: { in: [userA, userB] } } }));
    console.log("\n[cleanup] usuarios de prueba borrados");
    await new Promise<void>((resolve) => mock.server.close(() => resolve()));
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
