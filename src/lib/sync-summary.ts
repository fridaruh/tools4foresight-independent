/**
 * Formato del mensajito que dejan los botones que corren toda la cadena
 * (ingesta → contenido → categorizacion → analisis).
 *
 * Vive aparte porque lo usan dos botones distintos: el del nav, que llama a
 * `/api/sync`, y el de Conexion, que encadena los cuatro jobs uno por uno.
 */

type Stage = { ok?: boolean; error?: string };

export type IngestionResult = Stage & { liked_items_created?: number };
export type ContentResult = Stage & { success?: number; failed?: number };
export type CategorizationResult = Stage & { categorized?: number; remaining?: number };
export type AnalysisResult = Stage & {
  tldrs?: number;
  impacts?: number;
  whyMatters?: number;
  remaining?: number;
};
export type GraphResult = Stage & { clusters?: number; alive?: number; died?: number; revived?: number };

export type SyncStages = {
  ingestion?: IngestionResult;
  content?: ContentResult;
  categorization?: CategorizationResult;
  analysis?: AnalysisResult;
  graph?: GraphResult;
};

/**
 * Una sola linea, para que quepa junto al boton:
 * `+3 likes · 5 links · 12 categorizados · 8 textos de análisis · faltan 41 por analizar`.
 *
 * Las etapas que no movieron nada se omiten en vez de reportar ceros.
 */
export function formatSyncSummary(stages: SyncStages): string {
  const { ingestion, content, categorization, analysis, graph } = stages;
  const parts: string[] = [];

  if (ingestion?.liked_items_created) parts.push(`+${ingestion.liked_items_created} likes`);
  if (content?.success) parts.push(`${content.success} links`);
  if (categorization?.categorized) parts.push(`${categorization.categorized} categorizados`);

  // El analisis escribe tres textos por item (TL;DR, impacto y "por que importa"),
  // asi que se reportan juntos: lo que importa es cuanto avanzo, no el desglose.
  const analyzed = (analysis?.tldrs ?? 0) + (analysis?.impacts ?? 0) + (analysis?.whyMatters ?? 0);
  if (analyzed) parts.push(`${analyzed} textos de análisis`);

  if (graph?.ok) {
    const bits = [`${graph.alive ?? graph.clusters ?? 0} temas vivos`];
    if (graph.died) bits.push(`${graph.died} murieron`);
    if (graph.revived) bits.push(`${graph.revived} resucitaron`);
    parts.push(`grafo: ${bits.join(", ")}`);
  }

  // Lo pendiente importa tanto como lo hecho: el analisis casi nunca termina en una
  // corrida (600 items son ~1200 llamadas al modelo) y hay que volver a apretar.
  const pending: string[] = [];
  if (categorization?.remaining) pending.push(`${categorization.remaining} por categorizar`);
  if (analysis?.remaining) pending.push(`${analysis.remaining} por analizar`);
  if (pending.length > 0) parts.push(`faltan ${pending.join(" y ")}`);

  const failed = [ingestion, content, categorization, analysis, graph].find(
    (stage) => stage?.ok === false,
  );
  const error = failed?.error;

  if (parts.length === 0) return error ?? "Ya estabas al día";
  return error ? `${parts.join(" · ")} · ${error}` : parts.join(" · ");
}
