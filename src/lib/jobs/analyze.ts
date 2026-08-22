import { prisma } from "@/lib/prisma";
import {
  ANALYSIS_TIMEOUT_MS,
  generateImpact,
  generateTldr,
  generateWhyMatters,
  type AnalysisInput,
} from "@/lib/analyze";
import { generateForesight } from "@/lib/foresight";

/**
 * Solo se analizan los N likes mas recientes (decision de Frida: "de momento solo corre
 * los ultimos 600 tweets, de los mas recientes a los mas antiguos"). Lo de atras no se
 * toca aunque este sin analizar.
 */
export const ANALYSIS_WINDOW = 600;

/** Items en vuelo al mismo tiempo, igual que en la categorizacion. */
const CONCURRENCY = 4;

/**
 * La funcion tiene maxDuration 300s y el corte se evalua entre oleadas. El margen es de
 * una sola llamada, no de las tres que puede gastar una oleada completa: cada etapa se
 * escribe en cuanto termina, asi que si Vercel mata la funcion a los 300s solo se
 * pierden las llamadas en vuelo y el item queda pendiente para la siguiente corrida.
 * El margen de 3 llamadas dejaba el presupuesto en 30s y una corrida diaria avanzaba
 * ~8 items: el backlog de TL;DR (columna nueva sobre items ya analizados) no bajaba.
 */
const TIME_BUDGET_MS = 300_000 - ANALYSIS_TIMEOUT_MS;

type PendingItem = AnalysisInput & {
  id: string;
  tldr: string | null;
  impact: string | null;
  whyMatters: string | null;
  foresight: string | null;
};

/**
 * Genera impacto y "por que importa" de los likes mas recientes que aun no los tienen.
 *
 * Es incremental a proposito: 600 items son ~1200 llamadas al modelo y no caben en una
 * funcion de 300s, asi que cada corrida avanza lo que puede, escribe lo que logro y
 * devuelve `remaining`. El cron y el boton manual la van vaciando.
 *
 * @param budgetMs Cuanto tiempo puede consumir esta corrida. `/api/sync` pasa menos
 *   porque antes ya corrio la ingesta, el fetch de contenido y la categorizacion.
 */
export async function analyzePending(budgetMs: number = TIME_BUDGET_MS) {
  const startedAt = Date.now();

  // La ventana se resuelve por id y no con un `take` sobre el filtro: hay que mirar los
  // 600 mas recientes y, de esos, quedarse con los que falten, no quedarse con los
  // primeros 600 que esten pendientes (eso arrastraria items viejos cuando los nuevos
  // ya estan listos).
  const window = await prisma.likedItem.findMany({
    // Lo descartado en la pantalla de enriquecimiento no entra: son items que Frida
    // ya decidio no trabajar, y cada uno cuesta dos llamadas al modelo. Ademas asi la
    // ventana avanza hacia items que si va a leer.
    where: { enrichDiscarded: false },
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

  // Se salta lo editado a mano: si Frida corrigio el texto, el job no lo pisa.
  const pending: PendingItem[] = window
    .filter(
      (item) =>
        (item.tldr === null && item.tldrSource !== "manual") ||
        (item.impact === null && item.impactSource !== "manual") ||
        (item.whyMatters === null && item.whyMattersSource !== "manual") ||
        (item.foresight === null && item.foresightSource !== "manual"),
    )
    .map((item) => ({
      id: item.id,
      tweetText: item.tweetText,
      contentTitle: item.contentTitle,
      contentDescription: item.contentDescription,
      tldr: item.tldr,
      impact: item.impact,
      whyMatters: item.whyMatters,
      foresight: item.foresight,
    }));

  if (pending.length === 0) {
    return {
      ok: true as const,
      windowSize: window.length,
      processed: 0,
      tldrs: 0,
      impacts: 0,
      whyMatters: 0,
      foresights: 0,
      remaining: 0,
    };
  }

  let tldrs = 0;
  let impacts = 0;
  let whyMattersCount = 0;
  let foresightsCount = 0;
  let attempted = 0;
  let stoppedOnBudget = false;
  const errors: string[] = [];

  async function runItem(item: PendingItem) {
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

      if (tldr === null) {
        tldr = await generateTldr(source);
        const written = await prisma.likedItem.updateMany({
          where: { id: item.id, tldr: null, tldrSource: { not: "manual" } },
          data: { tldr, tldrSource: "auto", tldrGeneratedAt: new Date() },
        });
        if (written.count > 0) tldrs += 1;
      }

      let impact = item.impact;

      if (impact === null) {
        impact = await generateImpact(source);
        // El `AND impact IS NULL` cubre la carrera con una edicion manual hecha
        // mientras corria el job: gana lo que escribio Frida.
        const written = await prisma.likedItem.updateMany({
          where: { id: item.id, impact: null, impactSource: { not: "manual" } },
          data: { impact, impactSource: "auto", impactGeneratedAt: new Date() },
        });
        if (written.count === 0) return; // lo edito a mano mientras corriamos
        impacts += 1;
      }

      let whyMatters = item.whyMatters;

      if (whyMatters === null) {
        whyMatters = await generateWhyMatters(source, impact);
        const written = await prisma.likedItem.updateMany({
          where: { id: item.id, whyMatters: null, whyMattersSource: { not: "manual" } },
          data: {
            whyMatters,
            whyMattersSource: "auto",
            whyMattersGeneratedAt: new Date(),
          },
        });
        if (written.count > 0) whyMattersCount += 1;
      }

      // Foresight cierra la cadena: parte del TL;DR y del "por que importa" (recien
      // generados o ya guardados). Es la unica etapa que corre en Claude.
      if (item.foresight === null) {
        const foresight = await generateForesight({ tldr, whyMatters });
        const written = await prisma.likedItem.updateMany({
          where: { id: item.id, foresight: null, foresightSource: { not: "manual" } },
          data: {
            foresight,
            foresightSource: "auto",
            foresightGeneratedAt: new Date(),
          },
        });
        if (written.count > 0) foresightsCount += 1;
      }
    } catch (error) {
      // Un item que falla no debe tumbar la corrida: se queda pendiente y entra en la
      // siguiente.
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  for (let i = 0; i < pending.length; i += CONCURRENCY) {
    if (Date.now() - startedAt > budgetMs) {
      stoppedOnBudget = true;
      break;
    }
    await Promise.all(pending.slice(i, i + CONCURRENCY).map(runItem));
  }

  const remaining = await countPending();

  return {
    // Falla la corrida solo si no se logro escribir nada: si algo paso, la corrida
    // sirvio y el resto se reintenta en la siguiente.
    ok: tldrs + impacts + whyMattersCount + foresightsCount > 0 || errors.length === 0,
    windowSize: window.length,
    processed: attempted,
    tldrs,
    impacts,
    whyMatters: whyMattersCount,
    foresights: foresightsCount,
    remaining,
    stoppedOnBudget,
    elapsedMs: Date.now() - startedAt,
    ...(errors.length > 0 ? { errors: errors.slice(0, 5) } : {}),
  };
}

/** Cuantos de los items de la ventana siguen sin impacto o sin "por que importa". */
async function countPending(): Promise<number> {
  const window = await prisma.likedItem.findMany({
    where: { enrichDiscarded: false },
    orderBy: [{ likedAt: "desc" }, { tweetId: "desc" }],
    take: ANALYSIS_WINDOW,
    select: {
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

  return window.filter(
    (item) =>
      (item.tldr === null && item.tldrSource !== "manual") ||
      (item.impact === null && item.impactSource !== "manual") ||
      (item.whyMatters === null && item.whyMattersSource !== "manual") ||
      (item.foresight === null && item.foresightSource !== "manual"),
  ).length;
}
