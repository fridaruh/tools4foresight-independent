/**
 * Tools de taxonomía y estado del banco de señales (#12, #13 y #17 del catálogo,
 * docs/PLAN.md §2.6).
 *
 * `list_categories` y `list_pestel_dimensions` exponen los catálogos casi
 * estáticos con los que se clasifica cada señal. `get_corpus_overview` es la
 * tool de orientación: cuánto hay, de cuándo a cuándo y con qué constantes
 * corre el modelo — para no arrancar a ciegas sobre el tamaño o la actualidad
 * del corpus.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { READ_ONLY, guarded, toolResult, type ToolContext } from "./context.js";
import { formatCategories, formatDateTime, formatEstimatedDate, formatPestel } from "../format/shared.js";
import { formatSignalCounts } from "../format/meta.js";
import type { MetaDTO } from "../client/types.js";

/**
 * `get_corpus_overview` NO reutiliza `formatMeta` de `src/format/shared.ts`:
 * ese `formatMeta` ya existe y formatea el ENVELOPE `ApiMeta` (el pie de
 * "N resultados · generado <fecha>" que cierra un listado paginado), no el
 * `MetaDTO` de `/meta` (conteos, rango de fechas, última corrida, constantes
 * del modelo) que necesita esta tool — son dos tipos distintos con el mismo
 * nombre de función por coincidencia.
 *
 * La forma concreta del markdown se compone aquí, porque solo la usa esta tool.
 * Los DOS CONTEOS DE SEÑALES, en cambio, salen de `format/meta.ts`: son la pieza
 * que este resumen comparte con el resource `foresight://overview` y la que ya
 * se rompió una vez en los dos sitios a la vez (rotulaban `publishedSignals`
 * como "Señales" y se comían el total del banco).
 */
function renderCorpusOverview(meta: MetaDTO): string {
  const { counts, domain, dateRange } = meta;
  const lines = [
    "## Resumen de tu banco de señales",
    "",
    ...formatSignalCounts(counts),
    `- **Temas vivos**: ${counts.themesAlive}`,
    `- **Temas fósiles**: ${counts.themesDead}`,
    `- **Macro-temas**: ${counts.macroThemes}`,
    `- **Aristas del grafo**: ${counts.links}`,
    `- **Categorías**: ${counts.categories}`,
    `- **Snapshots**: ${counts.snapshots}`,
    "",
    // `earliestLikedAt`/`latestLikedAt` salen de `likedAt`, que es ESTIMADO
    // (ver glossary.ts:likedAt): se muestran con `~`, igual que en cualquier
    // otra tool del servidor.
    `- **Rango de fechas** (\`likedAt\`, estimado): ${
      dateRange.earliestLikedAt && dateRange.latestLikedAt
        ? `${formatEstimatedDate(dateRange.earliestLikedAt)} — ${formatEstimatedDate(dateRange.latestLikedAt)}`
        : "todavía no hay señales guardadas"
    }`,
    `- **Última corrida del grafo**: ${
      meta.lastGraphRunAt ? formatDateTime(meta.lastGraphRunAt) : "todavía no ha corrido ninguna"
    }`,
    "",
    "**Constantes del modelo**",
    `- Vida media de la vitalidad: ${domain.halfLifeDays} días`,
    `- Vida media de señales huérfanas: ${domain.orphanHalfLifeDays} días`,
    // No es la única vía a fósil: un tema también muere si su linaje no empareja
    // en una corrida, con la vitalidad que sea (ver glossary.ts:fosil).
    `- Umbral de muerte de un tema (vitalidad suma): < ${domain.deadThreshold} — pero un tema también pasa a fósil si su linaje no empareja en una corrida, tenga la vitalidad que tenga (\`explain_foresight_term\` con \`fosil\`)`,
    `- Umbral de arista del grafo (coseno): > ${domain.linkThreshold}`,
    `- Tamaño mínimo para ser tema: ${domain.minThemeSize} señales`,
    `- Máximo de macro-temas por horizonte: ${domain.maxMacroPerHorizon}`,
    "",
    `_generado ${formatDateTime(meta.generatedAt)}_`,
  ];
  return lines.join("\n");
}

export function registerTaxonomyTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "list_categories",
    {
      title: "Catálogo de categorías",
      description:
        "El catálogo de categorías con las que se clasifica cada señal, curadas y propuestas. " +
        "`inCatalog: false` marca una categoría que PROPUSO el modelo de análisis y todavía no está en el " +
        "catálogo curado — es una FEATURE (así se descubren categorías nuevas antes de curarlas a mano), " +
        "no un error ni una categoría rota.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    guarded(async () => {
      const response = await ctx.client.listCategories();
      return toolResult(formatCategories(response.data, response.meta), {
        data: response.data,
        meta: response.meta,
      });
    }),
  );

  server.registerTool(
    "list_pestel_dimensions",
    {
      title: "Dimensiones PESTEL",
      description:
        "Las seis dimensiones PESTEL (Political, Economic, Social, Technological, Environmental, Legal) con " +
        "su conteo de señales. OJO: cada señal lleva como máximo 2 dimensiones, así que la suma de los " +
        "conteos puede superar el total de señales — eso es esperado, no una inconsistencia.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    guarded(async () => {
      const response = await ctx.client.listPestel();
      return toolResult(formatPestel(response.data, response.meta), {
        data: response.data,
        meta: response.meta,
      });
    }),
  );

  server.registerTool(
    "get_corpus_overview",
    {
      title: "Resumen de tu banco",
      description:
        "LLAMA A ESTA TOOL PRIMERO si no sabes el tamaño ni la actualidad del corpus. Devuelve DOS conteos " +
        "de señales que no significan lo mismo: `signals` es el banco completo (el tamaño real del corpus) y " +
        "`publishedSignals` es el subconjunto ya curado, que es el ÚNICO que entra al grafo, a los temas y a " +
        "los horizontes. Usa `signals` para hablar de cuánto hay y `publishedSignals` como denominador de " +
        "cualquier cifra del mapa. Además: temas vivos/fósiles, macro-temas, aristas, categorías, snapshots, el rango de fechas " +
        "cubierto, cuándo corrió el grafo por última vez y las constantes reales del modelo (vida media de " +
        "30 días, umbral de muerte 1.0, umbral de arista 0.55, entre otras) — así no las inventas ni las das " +
        "por hecho.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    guarded(async () => {
      const response = await ctx.client.getMeta();
      return toolResult(renderCorpusOverview(response.data), { data: response.data, meta: response.meta });
    }),
  );
}
