// Job de análisis (PLAN 3.6): tldr → impacto → "por qué importa" en Ollama, y
// foresight en Claude (BYOK) si el tenant tiene key verificada.
//
// Patrón de transacciones cortas, igual que fetch/categorize/pestel: se lee el lote
// y los prompts del tenant en un `withOwner` breve, cada llamada a Ollama/Claude
// (hasta 90s) corre FUERA de cualquier transacción, y cada escritura vuelve a abrir
// su propio `withOwner` corto. Ver la nota sobre el pooler de Neon en tenant-db.ts.
import {
  ANALYSIS_TIMEOUT_MS,
  generateImpact,
  generateTldr,
  generateWhyMatters,
  type AnalysisInput,
} from "@/lib/analyze";
import { getAnalysisSystemPrompts } from "@/lib/analysis-prompts";
import { hasVerifiedAnthropicKey } from "@/lib/anthropic-client";
import { generateForesight } from "@/lib/foresight";
import { budgetExceeded, type JobFn } from "@/lib/jobs/types";
import { recordUsage, reserveQuota } from "@/lib/quota";
import { withOwner } from "@/lib/tenant-db";

/**
 * Solo se analizan los N likes mas recientes (decision de Frida: "de momento solo corre
 * los ultimos 600 tweets, de los mas recientes a los mas antiguos"). Lo de atras no se
 * toca aunque este sin analizar.
 */
export const ANALYSIS_WINDOW = 600;

/** Items en vuelo al mismo tiempo, igual que en la categorizacion. */
const CONCURRENCY = 4;

type WindowItem = AnalysisInput & {
  id: string;
  tldr: string | null;
  tldrSource: string;
  impact: string | null;
  impactSource: string;
  whyMatters: string | null;
  whyMattersSource: string;
  foresight: string | null;
  foresightSource: string;
};

function needsWork(item: WindowItem): boolean {
  return (
    (item.tldr === null && item.tldrSource !== "manual") ||
    (item.impact === null && item.impactSource !== "manual") ||
    (item.whyMatters === null && item.whyMattersSource !== "manual") ||
    (item.foresight === null && item.foresightSource !== "manual")
  );
}

/**
 * Genera tldr/impacto/"por que importa"/foresight de los likes mas recientes que aun
 * no los tienen.
 *
 * Es incremental a proposito: 600 items son varios cientos de llamadas al modelo y no
 * caben en una sola corrida, asi que cada una avanza lo que puede (budget de tiempo,
 * `analyzeItemsPerDay` de cuota) y devuelve `remaining`.
 */
export const runAnalyze: JobFn = async (ctx) => {
  // Lectura corta: prompts del tenant (una vez por corrida, no por item) + la
  // ventana de los 600 mas recientes.
  const { prompts, window } = await withOwner(ctx.ownerId, async (tx) => {
    const prompts = await getAnalysisSystemPrompts(tx, ctx.ownerId);
    // Lo descartado en la pantalla de enriquecimiento no entra: son items que el
    // usuario ya decidio no trabajar, y cada uno cuesta varias llamadas al modelo.
    const window = await tx.likedItem.findMany({
      where: { ownerId: ctx.ownerId, enrichDiscarded: false },
      orderBy: [{ likedAt: "desc" }, { tweetId: "desc" }],
      take: ANALYSIS_WINDOW,
      select: {
        id: true,
        tweetText: true,
        contentTitle: true,
        contentDescription: true,
        tldr: true,
        tldrSource: true,
        impact: true,
        impactSource: true,
        whyMatters: true,
        whyMattersSource: true,
        foresight: true,
        foresightSource: true,
      },
    });
    return { prompts, window };
  });

  const pending = window.filter(needsWork);

  if (pending.length === 0) {
    return {
      ok: true,
      processed: 0,
      remaining: 0,
      stoppedOnBudget: false,
      details: { windowSize: window.length },
    };
  }

  // Se resuelve una sola vez por corrida: cada item vuelve a chequear esta bandera
  // en vez de llamar hasVerifiedAnthropicKey por item.
  const canForesight = await hasVerifiedAnthropicKey(ctx.ownerId);
  let foresightSkipped = false;

  let tldrs = 0;
  let impacts = 0;
  let whyMattersCount = 0;
  let foresightsCount = 0;
  let attempted = 0;
  let stoppedOnBudget = false;
  let stoppedOnQuota = false;
  const errors: string[] = [];

  async function runItem(item: WindowItem) {
    if (stoppedOnQuota) return;
    if (budgetExceeded(ctx, ANALYSIS_TIMEOUT_MS)) {
      stoppedOnBudget = true;
      return;
    }

    // Reserva ANTES de gastar la llamada, atomica, en su propia tx corta.
    const reserved = await withOwner(ctx.ownerId, (tx) => reserveQuota(tx, ctx.ownerId, "analyze_items", 1));
    if (!reserved) {
      stoppedOnQuota = true;
      return;
    }

    attempted += 1;
    const source: AnalysisInput = {
      tweetText: item.tweetText,
      contentTitle: item.contentTitle,
      contentDescription: item.contentDescription,
    };

    try {
      // Cada etapa se escribe en cuanto termina. Si una llamada posterior falla o la
      // corrida se corta, lo ya generado quedo guardado y la proxima corrida solo
      // genera lo que falta en vez de pagar todas las llamadas otra vez.
      let tldr = item.tldr;

      if (tldr === null && item.tldrSource !== "manual") {
        tldr = await generateTldr(source, prompts.tldr);
        await recordOllamaCall(ctx.ownerId);
        const written = await withOwner(ctx.ownerId, (tx) =>
          tx.likedItem.updateMany({
            where: { id: item.id, ownerId: ctx.ownerId, tldr: null, tldrSource: { not: "manual" } },
            data: { tldr, tldrSource: "auto", tldrGeneratedAt: new Date() },
          }),
        );
        if (written.count > 0) tldrs += 1;
      }

      let impact = item.impact;

      if (impact === null && item.impactSource !== "manual") {
        impact = await generateImpact(source, prompts.impact);
        await recordOllamaCall(ctx.ownerId);
        // El `AND impact IS NULL` cubre la carrera con una edicion manual hecha
        // mientras corria el job: gana lo que escribio el usuario.
        const written = await withOwner(ctx.ownerId, (tx) =>
          tx.likedItem.updateMany({
            where: { id: item.id, ownerId: ctx.ownerId, impact: null, impactSource: { not: "manual" } },
            data: { impact, impactSource: "auto", impactGeneratedAt: new Date() },
          }),
        );
        if (written.count === 0) return; // lo edito a mano mientras corriamos
        impacts += 1;
      }

      let whyMatters = item.whyMatters;

      if (whyMatters === null && item.whyMattersSource !== "manual" && impact !== null) {
        whyMatters = await generateWhyMatters(source, impact, prompts.whyMatters);
        await recordOllamaCall(ctx.ownerId);
        const written = await withOwner(ctx.ownerId, (tx) =>
          tx.likedItem.updateMany({
            where: {
              id: item.id,
              ownerId: ctx.ownerId,
              whyMatters: null,
              whyMattersSource: { not: "manual" },
            },
            data: {
              whyMatters,
              whyMattersSource: "auto",
              whyMattersGeneratedAt: new Date(),
            },
          }),
        );
        if (written.count > 0) whyMattersCount += 1;
      }

      // Foresight cierra la cadena: parte del tldr y del "por que importa" (recien
      // generados o ya guardados). Corre en Claude, solo si hay key BYOK verificada.
      if (item.foresight === null && item.foresightSource !== "manual") {
        if (!canForesight) {
          foresightSkipped = true;
        } else if (tldr !== null && whyMatters !== null) {
          const foresight = await generateForesight(ctx.ownerId, { tldr, whyMatters }, prompts.foresight);
          // null = sin key valida (revocada a medio job), refusal, o key sin
          // verificar: el item queda pendiente para la proxima corrida o para
          // reintento manual, sin contar como error.
          if (foresight !== null) {
            const written = await withOwner(ctx.ownerId, (tx) =>
              tx.likedItem.updateMany({
                where: {
                  id: item.id,
                  ownerId: ctx.ownerId,
                  foresight: null,
                  foresightSource: { not: "manual" },
                },
                data: {
                  foresight,
                  foresightSource: "auto",
                  foresightGeneratedAt: new Date(),
                },
              }),
            );
            if (written.count > 0) foresightsCount += 1;
          }
        }
      }
    } catch (error) {
      // Un item que falla no debe tumbar la corrida: se queda pendiente y entra en la
      // siguiente.
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  for (let i = 0; i < pending.length; i += CONCURRENCY) {
    if (stoppedOnQuota || budgetExceeded(ctx, ANALYSIS_TIMEOUT_MS)) {
      stoppedOnBudget = budgetExceeded(ctx, ANALYSIS_TIMEOUT_MS);
      break;
    }
    await Promise.all(pending.slice(i, i + CONCURRENCY).map(runItem));
  }

  // Sin countPending duplicado: se reutiliza el conjunto ya leido (`pending`) en vez
  // de volver a pegarle a la DB. `attempted` son los que alcanzaron a reservar cupo y
  // arrancar; el resto de `pending` queda para la proxima corrida.
  const remaining = Math.max(0, pending.length - attempted);

  return {
    // Falla la corrida solo si no se logro escribir nada: si algo paso, la corrida
    // sirvio y el resto se reintenta en la siguiente.
    ok: tldrs + impacts + whyMattersCount + foresightsCount > 0 || errors.length === 0,
    processed: attempted,
    remaining,
    stoppedOnBudget,
    stoppedOnQuota,
    details: {
      windowSize: window.length,
      tldrs,
      impacts,
      whyMatters: whyMattersCount,
      foresights: foresightsCount,
      foresightSkipped,
      ...(errors.length > 0 ? { errors: errors.slice(0, 5) } : {}),
    },
  };
};

async function recordOllamaCall(ownerId: string): Promise<void> {
  await withOwner(ownerId, (tx) => recordUsage(tx, ownerId, "ollama_call", 1));
}
