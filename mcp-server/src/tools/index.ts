/**
 * Registro central de las 18 tools.
 *
 * Está en un solo sitio a propósito: es la lista auditable de todo lo que este
 * servidor expone. Si alguna vez aparece aquí un `register…` que escriba algo,
 * es un bug — este servidor es de solo lectura (ver SECURITY.md).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import { registerSignalTools } from "./signals.js";
import { registerThemeTools } from "./themes.js";
import { registerHorizonTools } from "./horizons.js";
import { registerTaxonomyTools } from "./taxonomy.js";
import { registerGraphTools } from "./graph.js";
import { registerSnapshotTools } from "./snapshots.js";
import { registerDomainTools } from "./domain.js";

export function registerAllTools(server: McpServer, ctx: ToolContext): void {
  registerSignalTools(server, ctx); //  4 — señales y búsqueda
  registerThemeTools(server, ctx); //   5 — temas, historia y macro-temas
  registerHorizonTools(server, ctx); // 2 — panorama y detalle de horizonte
  registerTaxonomyTools(server, ctx); //3 — categorías, PESTEL y resumen del banco
  registerGraphTools(server, ctx); //   1 — el grafo completo
  registerSnapshotTools(server, ctx); //2 — corridas del grafo
  registerDomainTools(server, ctx); //  1 — glosario, sin red
}

/** Los nombres esperados, para el test que verifica que no falte ni sobre ninguna. */
export const EXPECTED_TOOL_NAMES = [
  "list_signals",
  "search_signals",
  "get_signal",
  "get_signal_neighbors",
  "list_themes",
  "get_theme",
  "list_theme_signals",
  "get_theme_history",
  "list_macro_themes",
  "get_horizons_overview",
  "get_horizon",
  "list_categories",
  "list_pestel_dimensions",
  "get_corpus_overview",
  "get_graph",
  "list_snapshots",
  "get_snapshot",
  "explain_foresight_term",
] as const;
