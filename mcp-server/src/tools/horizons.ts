/**
 * Tools de horizontes (#10-#11 del catálogo, docs/PLAN.md §2.6).
 *
 * Un HORIZONTE es una de las tres franjas temporales del mapa de foresight:
 * H1 (ya está pasando), H2 (en transición) y H3 (señal débil). Estas dos tools
 * son la puerta de entrada habitual cuando alguien pregunta "¿cómo va el mapa?"
 * antes de bajar a temas o señales individuales.
 */
import * as z from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { READ_ONLY, guarded, toolResult, type ToolContext } from "./context.js";
import { formatHorizon, formatHorizonsOverview } from "../format/theme.js";

const HORIZON = z.enum(["H1", "H2", "H3"]);

export function registerHorizonTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "get_horizons_overview",
    {
      title: "Panorama de los tres horizontes",
      description:
        "EMPIEZA POR AQUÍ cuando te pidan 'el estado del mapa' o un resumen general de hacia dónde va todo. " +
        "Devuelve los tres horizontes de foresight con su etiqueta real (no la inventes, viene del glosario): " +
        "H1 · ya está pasando (tendencia consolidada, grande y cerca del centro del mapa), " +
        "H2 · en transición (crece y conecta pero todavía no domina) y " +
        "H3 · señal débil (chico o lejano; hipótesis a vigilar, alto riesgo de desaparecer). " +
        "En este listado los macro-temas vienen sin su lista de temas completa; para eso usa `get_horizon`.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    guarded(async () => {
      const response = await ctx.client.getHorizons();
      return toolResult(formatHorizonsOverview(response.data, response.meta), {
        data: response.data,
        meta: response.meta,
      });
    }),
  );

  server.registerTool(
    "get_horizon",
    {
      title: "Detalle de un horizonte",
      description:
        "Un horizonte (H1/H2/H3) con TODOS sus temas vivos y sus macro-temas. Úsala después de " +
        "`get_horizons_overview` cuando quieras bajar del panorama general a la lista completa de temas de " +
        "una sola franja temporal.",
      inputSchema: {
        horizon: HORIZON.describe("La clave del horizonte: H1 (ya está pasando), H2 (en transición) o H3 (señal débil)."),
      },
      annotations: READ_ONLY,
    },
    guarded(async ({ horizon }) => {
      const response = await ctx.client.getHorizon(horizon);
      return toolResult(formatHorizon(response.data), { data: response.data, meta: response.meta });
    }),
  );
}
