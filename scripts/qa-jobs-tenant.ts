/**
 * QA del pipeline por tenant (criterio de aceptación de la Fase 3, tareas 3.3-3.7).
 *
 *   npm run qa:jobs
 *
 * Crea dos tenants (A y B) con seedTenant, les mete 3 liked_items a cada uno
 * (fetchStatus not_applicable, sin categoría) y levanta un servidor HTTP local que
 * imita /api/chat de Ollama: responde con una clasificación válida ("Otros"/"AI
 * News", que sí existen en el catálogo sembrado) cuando la llamada trae `format`
 * (categorización) y con un texto fijo cuando es prosa (tldr/impacto/por qué
 * importa).
 *
 * Corre `runCategorize` solo para A (budget 60s) y comprueba que A quedó
 * categorizado y B no se tocó — el aislamiento por tenant es el punto de la prueba,
 * no solo que el job funcione. Después corre `runAnalyze` solo para A y comprueba
 * tldr/impacto/por qué importa llenos, y que se registraron los UsageEvent de
 * `ollama_call`.
 *
 * Al final borra los dos usuarios de prueba y apaga el servidor mock.
 */
import "dotenv/config";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/prisma";
import { withOwner, withPlatformBypass } from "../src/lib/tenant-db";
import { seedTenant } from "../src/lib/seed-tenant";
import { runCategorize } from "../src/lib/jobs/categorize";
import { runAnalyze } from "../src/lib/jobs/analyze";
import type { JobContext } from "../src/lib/jobs/types";

let failures = 0;

function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// --- Mock de Ollama -----------------------------------------------------------

type OllamaChatBody = {
  format?: unknown;
  messages?: Array<{ role: string; content: string }>;
};

/**
 * Imita lo mínimo de /api/chat que usan categorize.ts y analyze.ts: cuando la
 * llamada trae `format` (categorización, JSON schema) devuelve un arreglo con una
 * categoría por índice pedido; si no, es una llamada de prosa (tldr/impacto/por qué
 * importa) y devuelve un texto fijo.
 */
function startMockOllama(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        try {
          const raw = Buffer.concat(chunks).toString("utf8");
          const body = (raw ? JSON.parse(raw) : {}) as OllamaChatBody;
          const userMessage = body.messages?.find((m) => m.role === "user")?.content ?? "";

          let content: string;
          if (body.format) {
            const indices = [...userMessage.matchAll(/index:\s*(\d+)/g)].map((m) => Number(m[1]));
            const categoryNames = ["Otros", "AI News"];
            const results = indices.map((index, i) => ({
              index,
              category: categoryNames[i % categoryNames.length],
              confidence: 0.9,
              reasoning: "qa mock",
              isNewCategory: false,
            }));
            content = JSON.stringify(results);
          } else {
            content = "Texto de prueba generado por el mock de Ollama para QA.";
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message: { content } }));
        } catch (error) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        }
      });
    });

    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        port,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

// --- Fixtures -------------------------------------------------------------------

async function makeUser(label: string): Promise<string> {
  const id = randomUUID();
  await withPlatformBypass((tx) =>
    tx.user.create({
      data: {
        id,
        name: `QA ${label}`,
        email: `qa-jobs-${label}-${id}@tools4foresight.test`,
        role: "user",
      },
    }),
  );
  await seedTenant(id);
  return id;
}

async function makeLikedItems(ownerId: string, label: string, count: number): Promise<void> {
  await withOwner(ownerId, async (tx) => {
    for (let i = 0; i < count; i++) {
      await tx.likedItem.create({
        data: {
          ownerId,
          tweetId: `qa-jobs:${label}:${i}:${randomUUID()}`,
          authorHandle: `qa_${label}`,
          tweetText: `Señal de prueba ${i} de ${label}: anuncian un modelo nuevo de IA con benchmarks mejores.`,
          tweetUrl: `https://example.test/${label}/${i}`,
          likedAt: new Date(),
          fetchStatus: "not_applicable",
        },
      });
    }
  });
}

function makeCtx(ownerId: string, budgetMs: number): JobContext {
  return {
    ownerId,
    budgetMs,
    startedAt: Date.now(),
    runId: randomUUID(),
    trigger: "manual",
  };
}

// --- Main -------------------------------------------------------------------

async function main() {
  const mock = await startMockOllama();
  process.env.OLLAMA_API_KEY = "qa-mock-key";
  process.env.OLLAMA_HOST = `http://127.0.0.1:${mock.port}`;

  const userA = await makeUser("a");
  const userB = await makeUser("b");

  try {
    await makeLikedItems(userA, "a", 3);
    await makeLikedItems(userB, "b", 3);

    // --- runCategorize solo para A ---
    const categorizeResult = await runCategorize(makeCtx(userA, 60_000));
    check("runCategorize(A) devuelve ok", categorizeResult.ok === true, JSON.stringify(categorizeResult));
    check(
      "runCategorize(A) no se detuvo por presupuesto",
      categorizeResult.stoppedOnBudget === false,
      JSON.stringify(categorizeResult),
    );

    const categorizedA = await withOwner(userA, (tx) =>
      tx.likedItem.count({ where: { ownerId: userA, category: { not: null } } }),
    );
    check("los 3 items de A quedaron categorizados", categorizedA === 3, `quedaron ${categorizedA}`);

    const categorizedB = await withOwner(userB, (tx) =>
      tx.likedItem.count({ where: { ownerId: userB, category: { not: null } } }),
    );
    check(
      "runCategorize(A) no tocó a B: sus 3 items siguen sin categoría",
      categorizedB === 0,
      `B quedó con ${categorizedB} categorizados`,
    );

    // --- runAnalyze solo para A ---
    // Budget cómodamente por encima del margen interno (ANALYSIS_TIMEOUT_MS =
    // 90_000 en src/lib/analyze.ts): con menos, budgetExceeded() corta antes de
    // arrancar el primer item.
    const analyzeResult = await runAnalyze(makeCtx(userA, 120_000));
    check("runAnalyze(A) devuelve ok", analyzeResult.ok === true, JSON.stringify(analyzeResult));
    check(
      "runAnalyze(A) no se detuvo por presupuesto ni por cuota",
      analyzeResult.stoppedOnBudget === false && analyzeResult.stoppedOnQuota !== true,
      JSON.stringify(analyzeResult),
    );

    const analyzedA = await withOwner(userA, (tx) =>
      tx.likedItem.findMany({
        where: { ownerId: userA },
        select: { tldr: true, impact: true, whyMatters: true },
      }),
    );
    check(
      "los 3 items de A tienen tldr/impact/whyMatters llenos",
      analyzedA.length === 3 && analyzedA.every((i) => i.tldr && i.impact && i.whyMatters),
      JSON.stringify(analyzedA),
    );

    const analyzedB = await withOwner(userB, (tx) =>
      tx.likedItem.findMany({
        where: { ownerId: userB },
        select: { tldr: true, impact: true, whyMatters: true },
      }),
    );
    check(
      "runAnalyze(A) no tocó a B: sus 3 items siguen sin análisis",
      analyzedB.length === 3 && analyzedB.every((i) => !i.tldr && !i.impact && !i.whyMatters),
      JSON.stringify(analyzedB),
    );

    const ollamaEvents = await withOwner(userA, (tx) =>
      tx.usageEvent.findMany({ where: { userId: userA, kind: "ollama_call" } }),
    );
    check(
      "se registraron al menos 3 UsageEvent de kind=ollama_call para A",
      ollamaEvents.length >= 3,
      `hay ${ollamaEvents.length}`,
    );
  } finally {
    await withPlatformBypass((tx) => tx.user.deleteMany({ where: { id: { in: [userA, userB] } } }));
    console.log("\n[cleanup] usuarios de prueba borrados");
    await mock.close();
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
