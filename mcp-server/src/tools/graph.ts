/**
 * Tool del grafo semántico (#14 del catálogo, docs/PLAN.md §2.6).
 *
 * El grafo cubre TODAS las señales de tu banco que ya tienen embedding: nodos
 * y aristas (similitud coseno >= 0.55). Es la representación cruda de la que salen los
 * temas, pero para lectura normal es mejor entrar por `list_themes` /
 * `get_horizon*`: el grafo es para análisis estructural (contar aristas,
 * ver huérfanas, auditar densidad de conexión), no para leer contenido.
 */
import * as z from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { READ_ONLY, compact, guarded, toolResult, type ToolContext } from './context.js';
import { formatGraphStats } from '../format/theme.js';

const HORIZON = z.enum(['H1', 'H2', 'H3']);

export function registerGraphTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'get_graph',
    {
      title: 'Grafo semántico',
      description:
        'El grafo semántico completo (nodos + aristas) de las señales de tu banco: es la estructura de la ' +
        'que se derivan los temas. Para lectura normal ("qué está pasando", "qué temas hay") es mejor usar ' +
        'temas y horizontes — esta tool es para análisis ESTRUCTURAL del mapa (densidad de conexión, ' +
        'huérfanas, tamaño real del grafo). El servidor puede recortar el resultado con `limit`: **si la ' +
        'respuesta viene marcada como truncada, dilo explícitamente al usuario** — un agente que recibe, ' +
        'por ejemplo, 500 nodos de un grafo de 3000 sin saberlo saca conclusiones falsas sobre la estructura ' +
        'completa del mapa.',
      inputSchema: {
        horizon: HORIZON.optional().describe('Acota el grafo a un horizonte.'),
        min_vitality: z.number().optional().describe('Solo nodos con esta vitalidad mínima.'),
        min_score: z.number().optional().describe('Solo aristas con este score coseno mínimo (el grafo ya filtra por debajo de 0.55).'),
        limit: z.number().int().optional().describe('Tope de nodos a devolver. Si el grafo real tiene más, la respuesta viene truncada (avísalo).'),
      },
      annotations: READ_ONLY,
    },
    guarded(async (args) => {
      const response = await ctx.client.getGraph(compact({
        horizon: args.horizon,
        minVitality: args.min_vitality,
        minScore: args.min_score,
        limit: args.limit,
      }));
      // `formatGraphStats` ya añade la nota de truncamiento cuando `meta.truncated`
      // es true (docs/DOMAIN.md: nunca presentar un recorte como el mapa completo).
      return toolResult(formatGraphStats(response.data, response.meta), { data: response.data, meta: response.meta });
    }),
  );
}
