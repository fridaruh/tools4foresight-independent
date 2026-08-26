/**
 * Tools de snapshots (#15-#16 del catálogo, docs/PLAN.md §2.6).
 *
 * Un SNAPSHOT es una foto completa del mapa en un momento: todos los temas,
 * su estado y (si se pide) su membresía exacta. Se crea en cada corrida del
 * grafo. Con un solo snapshot ves un instante; con dos o más comparados ves
 * la evolución — nacer, crecer, morir — que es justo lo que `get_theme_history`
 * ya arma para un tema individual sin tener que iterar snapshots a mano.
 */
import * as z from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { READ_ONLY, compact, guarded, toolResult, type ToolContext } from './context.js';
import { formatSnapshot, formatSnapshotList } from '../format/theme.js';

export function registerSnapshotTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'list_snapshots',
    {
      title: 'Listar snapshots',
      description:
        'Lista las corridas del grafo (snapshots), una por cada vez que se recalculó el mapa. Cada snapshot ' +
        'es una foto completa del estado en ese momento: temas vivos, fósiles, huérfanas, nodos, aristas. ' +
        'Con dos o más snapshots comparados se ve la evolución del mapa. Para la evolución de UN tema en ' +
        'particular usa `get_theme_history`, que ya hace ese trabajo sin iterar snapshots a mano.',
      inputSchema: {
        from: z.string().optional().describe('Desde esta fecha (YYYY-MM-DD o ISO), sobre `takenAt`.'),
        to: z.string().optional().describe('Hasta esta fecha (YYYY-MM-DD o ISO), inclusive.'),
        limit: z.number().int().optional().describe('Cuántos traer (1-100, por defecto 25).'),
        cursor: z.string().optional().describe('Cursor opaco de la página anterior. No lo construyas a mano.'),
      },
      annotations: READ_ONLY,
    },
    guarded(async (args) => {
      const response = await ctx.client.listSnapshots(compact({
        from: args.from,
        to: args.to,
        limit: args.limit,
        cursor: args.cursor,
      }));
      return toolResult(formatSnapshotList(response.data, response.meta), { data: response.data, meta: response.meta });
    }),
  );

  server.registerTool(
    'get_snapshot',
    {
      title: 'Ficha de un snapshot',
      description:
        'Una corrida concreta del grafo: el estado de todos los temas en ese momento (tamaño, vitalidad, ' +
        'estado vivo/fósil). Con `include_members:true` trae además la membresía exacta (qué señal estaba en ' +
        'qué tema), útil para auditar el linaje o reconstruir qué pasó en una fecha pasada — pero está ' +
        'topada a 5000 filas por el servidor: **si la respuesta viene truncada, dilo explícitamente**, no ' +
        'presentes una membresía parcial como si fuera completa.',
      inputSchema: {
        snapshot_id: z.string().describe('El id del snapshot.'),
        include_members: z.boolean().optional().describe('Si true, incluye la membresía fila por fila (tope de 5000).'),
      },
      annotations: READ_ONLY,
    },
    guarded(async ({ snapshot_id, include_members }) => {
      const response = await ctx.client.getSnapshot(snapshot_id, compact({ includeMembers: include_members }));
      // `formatSnapshot` ya avisa del recorte cuando `meta.truncated` es true.
      return toolResult(formatSnapshot(response.data, response.meta), { data: response.data, meta: response.meta });
    }),
  );
}
