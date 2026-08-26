/**
 * Tools de temas (#5-#9 del catálogo, docs/PLAN.md §2.6).
 *
 * Un TEMA es un LINAJE: un cluster semántico que persiste entre corridas del
 * grafo, acumula historia (snapshots, indicadores) y puede morir (fósil,
 * `status:'dead'`) y resucitar si llegan señales nuevas suficientes. Nada se
 * borra nunca: un fósil sigue teniendo id, nombre y miembros consultables
 * (docs/DOMAIN.md "Tema (cluster semántico)" y "Fósil (tema muerto)"). Las
 * descripciones de las tools cargan ese vocabulario porque son lo único que
 * el modelo lee para decidir cuándo usar cada una.
 */
import * as z from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { READ_ONLY, compact, guarded, toolResult, type ToolContext } from './context.js';
import { formatSignalList } from '../format/signal.js';
import { formatMacroTheme, formatThemeDetail, formatThemeHistory, formatThemeList } from '../format/theme.js';

const HORIZON = z.enum(['H1', 'H2', 'H3']);

export function registerThemeTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'list_themes',
    {
      title: 'Listar temas',
      description:
        'Lista los *temas* (clusters semánticos) con filtros. Un tema es un LINAJE que persiste entre ' +
        "corridas del grafo, acumula historia y puede **morir** (fósil, `status:'dead'`) y **resucitar** " +
        'si llegan señales nuevas con vitalidad suficiente. Nada se borra: un fósil sigue siendo consultable ' +
        'íntegro (nombre, historia, últimos miembros). Por defecto solo trae temas vivos; pide `status:"any"` ' +
        'o `status:"dead"` para incluir fósiles. Devuelve una página; si `hasMore` es true, vuelve a llamar ' +
        'con el `cursor` que te dio.',
      inputSchema: {
        status: z.enum(['alive', 'dead', 'any']).optional().describe('Filtra por estado. Por defecto solo temas vivos.'),
        horizon: HORIZON.optional().describe('Solo temas de este horizonte (H1 ya está pasando, H2 en transición, H3 señal débil).'),
        macro_theme_id: z.string().optional().describe('Solo temas de este macro-tema.'),
        q: z.string().optional().describe('Búsqueda de texto sobre el nombre y el resumen del tema.'),
        min_vitality: z.number().optional().describe('Vitalidad mínima. Un tema muere (fósil) cuando la suma de vitalidad de sus miembros cae bajo 1.0.'),
        sort: z.enum(['vitality', 'size', 'velocity', 'lastSignal']).optional().describe('Orden. Por defecto vitalidad descendente.'),
        limit: z.number().int().optional().describe('Cuántos traer (1-100, por defecto 25). Fuera de rango es un error, no se recorta.'),
        cursor: z.string().optional().describe('Cursor opaco de la página anterior. No lo construyas a mano.'),
      },
      annotations: READ_ONLY,
    },
    guarded(async (args) => {
      const response = await ctx.client.listThemes(compact({
        status: args.status,
        horizon: args.horizon,
        macroTheme: args.macro_theme_id,
        q: args.q,
        minVitality: args.min_vitality,
        sort: args.sort,
        limit: args.limit,
        cursor: args.cursor,
      }));
      return toolResult(formatThemeList(response.data, response.meta), { data: response.data, meta: response.meta });
    }),
  );

  server.registerTool(
    'get_theme',
    {
      title: 'Ficha de un tema',
      description:
        'Ficha completa de un tema: su linaje (cuándo nació, si murió y resucitó, cuántas veces) y sus ' +
        'cuatro indicadores — **velocidad** (señales nuevas en los últimos 30 días vs. los 30 previos: ' +
        'positivo es que acelera, negativo que se apaga), **densidad** (cohesión: similitud media de los ' +
        'miembros al centroide del tema), **conectividad** (proporción de aristas que salen hacia otros ' +
        'temas; alta = tema puente) y **novedad** (distancia del centroide del tema al centroide global del ' +
        'mapa: baja = radicalmente nuevo, alta = mainstream). Incluye la lista de ids de los miembros ' +
        '(`lastMemberIds` si el tema es fósil).',
      inputSchema: { theme_id: z.string().describe('El id del tema. Es estable: persiste aunque el tema muera y resucite.') },
      annotations: READ_ONLY,
    },
    guarded(async ({ theme_id }) => {
      const response = await ctx.client.getTheme(theme_id);
      return toolResult(formatThemeDetail(response.data), { data: response.data });
    }),
  );

  server.registerTool(
    'list_theme_signals',
    {
      title: 'Señales de un tema',
      description:
        'Las señales que componen un tema (su membresía actual), ordenadas por vitalidad o por fecha de ' +
        'like. Úsala para leer el contenido concreto detrás de un tema, no solo sus indicadores agregados. ' +
        'La fecha `likedAt` de cada señal es una ESTIMACIÓN: preséntala siempre con `~`.',
      inputSchema: {
        theme_id: z.string().describe('El id del tema.'),
        sort: z.enum(['vitality', 'likedAt']).optional().describe('Orden. Por defecto vitalidad descendente.'),
        limit: z.number().int().optional().describe('Cuántas traer (1-100, por defecto 25).'),
        cursor: z.string().optional().describe('Cursor opaco de la página anterior. No lo construyas a mano.'),
      },
      annotations: READ_ONLY,
    },
    guarded(async ({ theme_id, sort, limit, cursor }) => {
      const response = await ctx.client.listThemeSignals(theme_id, compact({ sort, limit, cursor }));
      return toolResult(formatSignalList(response.data, response.meta), { data: response.data, meta: response.meta });
    }),
  );

  server.registerTool(
    'get_theme_history',
    {
      title: 'Historia de un tema',
      description:
        'La serie temporal de un tema a través de las corridas del grafo: cómo cambiaron su tamaño, ' +
        'vitalidad, velocidad y horizonte con el tiempo. **Es la tool para responder "¿esto está creciendo ' +
        'o apagándose?"** — no lo infieras de un solo `get_theme`, pide la historia. Los puntos vienen en ' +
        'orden ascendente por fecha, tal como los da el servidor: no los reordenes.',
      inputSchema: {
        theme_id: z.string().describe('El id del tema.'),
        from: z.string().optional().describe('Desde esta fecha (YYYY-MM-DD o ISO), sobre la fecha de la corrida.'),
        to: z.string().optional().describe('Hasta esta fecha (YYYY-MM-DD o ISO), inclusive.'),
        limit: z.number().int().optional().describe('Cuántos puntos traer como máximo.'),
      },
      annotations: READ_ONLY,
    },
    guarded(async ({ theme_id, from, to, limit }) => {
      const response = await ctx.client.getThemeHistory(theme_id, compact({ from, to, limit }));
      return toolResult(formatThemeHistory(response.data), { data: response.data });
    }),
  );

  server.registerTool(
    'list_macro_themes',
    {
      title: 'Listar macro-temas',
      description:
        'Macro-temas: una agrupación de segundo nivel de hasta 5 temas vivos por horizonte, para simplificar ' +
        'la lectura del mapa (por ejemplo, para un resumen ejecutivo tipo "3 macro-temas en H1, 7 en H2"). ' +
        '**Sus ids NO son estables entre corridas**: se borran y se recrean enteros cada vez que corre el ' +
        'grafo, así que NO los guardes ni los uses como referencia duradera — para eso usa los ids de los ' +
        'temas individuales, que sí persisten. Para análisis profundo de un macro-tema, entra a sus temas ' +
        'miembro con `get_theme`.',
      inputSchema: {
        horizon: HORIZON.optional().describe('Acota a un horizonte. Sin filtro trae los de los tres.'),
      },
      annotations: READ_ONLY,
    },
    guarded(async ({ horizon }) => {
      const response = await ctx.client.listMacroThemes(compact({ horizon }));
      const text =
        response.data.length === 0
          ? 'No hay macro-temas para ese horizonte.'
          : ['## Macro-temas', '', ...response.data.map((macro) => formatMacroTheme(macro))].join('\n\n');
      return toolResult(text, { data: response.data, meta: response.meta });
    }),
  );
}
