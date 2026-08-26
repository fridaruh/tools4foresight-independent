/**
 * Resources MCP — src/resources/index.ts (docs/PLAN.md §2.7).
 *
 * A diferencia de las tools (que un agente llama solo), un resource es para que
 * una PERSONA lo adjunte a mano como contexto en Claude Desktop/Cursor. Por eso
 * el contenido es markdown legible y reusa `src/format/` en vez de inventar un
 * formato nuevo aquí: la misma regla de "~fecha estimada" o "fósil, no borrado"
 * debe leerse igual la pida una tool o la adjunte una persona.
 */
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import type { ToolContext } from "../tools/context.js";
import type { HorizonKey, MetaDTO } from "../client/types.js";
import { formatSignalCounts } from "../format/meta.js";
import { renderGlossaryMarkdown } from "../domain/glossary.js";
import { formatDateTime, formatEstimatedDate } from "../format/shared.js";
import { formatSignalDetail, formatSignalList } from "../format/signal.js";
import { formatHorizon, formatHorizonsOverview, formatMacroTheme, formatThemeDetail } from "../format/theme.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Traduce un fallo de red al mismo mensaje accionable que usan las tools
 * (`T4FApiError.messageForModel()` si el error viene del cliente HTTP). Un
 * resource no tiene el canal `isError` de las tools: la única forma de no
 * reventar la lectura es devolver el mensaje como el propio contenido.
 */
function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "messageForModel" in error) {
    return String((error as { messageForModel: () => string }).messageForModel());
  }
  return error instanceof Error ? error.message : "Error desconocido al consultar tools4foresight.";
}

/** Envuelve la lectura de un resource: nunca deja escapar una excepción de red. */
async function guardedRead(uri: URL, build: () => Promise<string>): Promise<ReadResourceResult> {
  try {
    const text = await build();
    return { contents: [{ uri: uri.href, mimeType: "text/markdown", text }] };
  } catch (error) {
    return { contents: [{ uri: uri.href, mimeType: "text/plain", text: errorMessage(error) }] };
  }
}

type ListedResource = { uri: string; name: string; title: string; mimeType: string };

/**
 * Envuelve el `list` de un `ResourceTemplate`: a diferencia de una lectura, un
 * listado no tiene un canal de texto donde devolver un mensaje de error (el
 * handler del SDK concatena `resources/list` de TODOS los templates en una
 * sola respuesta — si uno solo lanza, se cae la lista entera para el cliente).
 * Un fallo de red aquí se degrada a "sin candidatos" en vez de tumbar el
 * listado completo; el error queda igual visible en stderr para diagnóstico.
 */
async function guardedList(build: () => Promise<ListedResource[]>): Promise<{ resources: ListedResource[] }> {
  try {
    return { resources: await build() };
  } catch (error) {
    console.error(`[foresight resources] no se pudo listar candidatos: ${errorMessage(error)}`);
    return { resources: [] };
  }
}

/** Una variable de plantilla puede llegar como `string[]` (regla del SDK); aquí siempre es un solo segmento de id. */
function firstValue(value: string | string[]): string {
  return Array.isArray(value) ? (value[0] ?? "") : value;
}

const HORIZON_KEYS: readonly HorizonKey[] = ["H1", "H2", "H3"];

/**
 * Esta forma del resumen (encabezado `#`, vivos y fósiles en una línea) solo la
 * usa este resource, así que se compone aquí. Lo que NO se compone aquí son los
 * dos conteos de señales: vienen de `format/meta.ts`, compartidos con
 * `get_corpus_overview`, porque es justo la pieza que se rompió en las dos
 * vistas a la vez cuando estaba duplicada. Las fechas salen de
 * `format/shared.ts` para no reinventar `~18 ago 2026`.
 */
function renderOverview(meta: MetaDTO): string {
  const { counts, domain } = meta;
  const range =
    meta.dateRange.earliestLikedAt && meta.dateRange.latestLikedAt
      ? `${formatEstimatedDate(meta.dateRange.earliestLikedAt)} — ${formatEstimatedDate(meta.dateRange.latestLikedAt)}`
      : "sin señales todavía";
  const lastRun = meta.lastGraphRunAt ? formatDateTime(meta.lastGraphRunAt) : "sin corridas todavía";

  return [
    "# Resumen de tu banco de señales",
    "",
    ...formatSignalCounts(counts),
    `- **Temas vivos**: ${counts.themesAlive} · **Fósiles**: ${counts.themesDead}`,
    `- **Macro-temas**: ${counts.macroThemes}`,
    `- **Aristas del grafo**: ${counts.links}`,
    `- **Categorías**: ${counts.categories}`,
    `- **Snapshots**: ${counts.snapshots}`,
    `- **Última corrida del grafo**: ${lastRun}`,
    `- **Rango de señales**: ${range}`,
    "",
    "**Constantes del modelo**",
    `- Media vida: ${domain.halfLifeDays} días (huérfanas: ${domain.orphanHalfLifeDays} días)`,
    `- Umbral de muerte de un tema (vitalidad): ${domain.deadThreshold}`,
    `- Umbral de enlace del grafo (coseno): ${domain.linkThreshold}`,
    `- Tamaño mínimo de un tema: ${domain.minThemeSize} señales`,
    `- Máximo de macro-temas por horizonte: ${domain.maxMacroPerHorizon}`,
    "",
    `_generado ${formatDateTime(meta.generatedAt)}_`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Registro
// ---------------------------------------------------------------------------

export function registerResources(server: McpServer, ctx: ToolContext): void {
  // -- Estáticos --------------------------------------------------------

  server.registerResource(
    "foresight-overview",
    "foresight://overview",
    {
      title: "Resumen de tu banco",
      description: "Conteos, rango de fechas y constantes del modelo (`/meta`). La puerta de entrada al mapa.",
      mimeType: "text/markdown",
    },
    async (uri) => guardedRead(uri, async () => renderOverview((await ctx.client.getMeta()).data)),
  );

  server.registerResource(
    "foresight-glossary",
    "foresight://glossary",
    {
      title: "Glosario del dominio",
      description: "Vocabulario del método (señal, tema, vitalidad, fósil, horizonte...). Sin red: siempre disponible.",
      mimeType: "text/markdown",
    },
    // Sin red (docs/PLAN.md §2.7): `renderGlossaryMarkdown()` es puro, no hace falta `guardedRead`.
    (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: renderGlossaryMarkdown() }] }),
  );

  server.registerResource(
    "foresight-horizons",
    "foresight://horizons",
    {
      title: "Panorama de los tres horizontes",
      description: "H1 (ya está pasando), H2 (en transición) y H3 (señal débil), con sus macro-temas.",
      mimeType: "text/markdown",
    },
    async (uri) =>
      guardedRead(uri, async () => {
        const response = await ctx.client.getHorizons();
        return formatHorizonsOverview(response.data, response.meta);
      }),
  );

  // -- Plantillas ---------------------------------------------------------

  server.registerResource(
    "foresight-signal",
    new ResourceTemplate("foresight://signal/{id}", {
      // Sin listado: el corpus de señales es demasiado grande para un selector
      // (docs/PLAN.md §2.7 dice explícitamente `list: undefined` para esta).
      list: undefined,
    }),
    {
      title: "Ficha de una señal",
      description: "TL;DR, por qué importa, impacto, categoría, PESTEL, vitalidad y tema de una señal de tu banco.",
      mimeType: "text/markdown",
    },
    async (uri, variables) =>
      guardedRead(uri, async () => {
        const response = await ctx.client.getSignal(firstValue(variables.id ?? ""));
        return formatSignalDetail(response.data);
      }),
  );

  server.registerResource(
    "foresight-theme",
    new ResourceTemplate("foresight://theme/{id}", {
      // Solo temas VIVOS: listar también los fósiles saturaría el selector con
      // linajes apagados que rara vez alguien quiere adjuntar a mano.
      list: () =>
        guardedList(async () => {
          const response = await ctx.client.listThemes({ status: "alive", sort: "vitality", limit: 100 });
          return response.data.map((theme) => ({
            uri: `foresight://theme/${theme.id}`,
            name: theme.id,
            title: theme.name,
            mimeType: "text/markdown",
          }));
        }),
    }),
    {
      title: "Ficha de un tema",
      description: "Linaje, indicadores (velocidad/densidad/conectividad/novedad) y señales miembro de un tema.",
      mimeType: "text/markdown",
    },
    async (uri, variables) =>
      guardedRead(uri, async () => {
        const themeId = firstValue(variables.id ?? "");
        const [detail, signals] = await Promise.all([
          ctx.client.getTheme(themeId),
          ctx.client.listThemeSignals(themeId, { sort: "vitality", limit: 25 }),
        ]);
        const signalsBlock =
          signals.data.length > 0
            ? ["", "## Señales", "", formatSignalList(signals.data, signals.meta)].join("\n")
            : "";
        return `${formatThemeDetail(detail.data)}${signalsBlock}`;
      }),
  );

  server.registerResource(
    "foresight-horizon",
    new ResourceTemplate("foresight://horizon/{key}", {
      // Son solo 3, pero se listan desde `/horizons` (no a mano) para mostrar
      // la etiqueta real del servidor (`labelShort`, ej. "H2 · en transición")
      // en vez de reinventarla aquí. `complete` sí es local: los tres horizontes
      // son un catálogo fijo, no hace falta red para autocompletar la clave.
      list: () =>
        guardedList(async () => {
          const response = await ctx.client.getHorizons();
          return response.data.map((horizon) => ({
            uri: `foresight://horizon/${horizon.key}`,
            name: horizon.key,
            title: horizon.labelShort,
            mimeType: "text/markdown",
          }));
        }),
      complete: { key: () => [...HORIZON_KEYS] },
    }),
    {
      title: "Horizonte completo",
      description: "Un horizonte (H1/H2/H3) con todos sus temas vivos y macro-temas.",
      mimeType: "text/markdown",
    },
    async (uri, variables) =>
      guardedRead(uri, async () => {
        const key = firstValue(variables.key ?? "") as HorizonKey;
        const response = await ctx.client.getHorizon(key);
        return formatHorizon(response.data);
      }),
  );

  server.registerResource(
    "foresight-macro-theme",
    new ResourceTemplate("foresight://macro-theme/{id}", {
      // Hasta 5 macro-temas por horizonte × 3 horizontes = ≤15 en total
      // (docs/DOMAIN.md): cabe entero en un solo listado, sin paginar.
      list: () =>
        guardedList(async () => {
          const response = await ctx.client.listMacroThemes();
          return response.data.map((macro) => ({
            uri: `foresight://macro-theme/${macro.id}`,
            name: macro.id,
            title: macro.name,
            mimeType: "text/markdown",
          }));
        }),
    }),
    {
      title: "Ficha de un macro-tema",
      description: "Un macro-tema con sus temas miembro. OJO: su id no es estable entre corridas.",
      mimeType: "text/markdown",
    },
    async (uri, variables) =>
      guardedRead(uri, async () => {
        const macroId = firstValue(variables.id ?? "");
        // No existe un endpoint `/macro-themes/{id}`: se listan todos (≤15, ver
        // arriba) y se busca el id en memoria — barato dado el tope del dominio.
        const response = await ctx.client.listMacroThemes();
        const macro = response.data.find((m) => m.id === macroId);
        if (!macro) {
          return (
            `No se encontró el macro-tema \`${macroId}\` entre los macro-temas vigentes. ` +
            "Los ids de macro-tema no son estables entre corridas del grafo: pide `foresight://macro-theme` " +
            "sin id (o la tool `list_macro_themes`) para ver los actuales."
          );
        }
        return formatMacroTheme(macro);
      }),
  );
}
