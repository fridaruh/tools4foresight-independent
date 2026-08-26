// Capa de formato — señales y vecinos semánticos (docs/PLAN.md §2.6).
// Funciones puras: DTO -> markdown en español. El `structuredContent` (el DTO
// crudo) lo arma la tool que llama a estas funciones, no este archivo.
import {
  externalBlock,
  externalInline,
  formatDate,
  formatEstimatedDate,
  formatHorizonLabel,
  formatThemeStatus,
  formatVitality,
  paginationFooter,
} from './shared.js';
import type { ApiMeta, NeighborDTO, NeighborStrength, SignalDetailDTO, SignalSummaryDTO } from '../client/types.js';

function formatThemeLine(theme: SignalSummaryDTO['theme']): string {
  if (theme === null) return 'huérfana (sin tema asignado)';
  return `${theme.name} (${formatThemeStatus(theme.status)}, ${formatHorizonLabel(theme.horizon)})`;
}

/** Ficha corta de una señal: para listados y para el lado "señal" de un vecino. */
export function formatSignalSummary(signal: SignalSummaryDTO): string {
  const lines: string[] = [];
  // Título, autor y TL;DR son texto de un tercero (ver shared.ts): el título va
  // aplanado —está dentro de un encabezado— y el TL;DR, delimitado.
  lines.push(`### ${externalInline(signal.title)}`);
  lines.push('');
  lines.push(`- **id**: \`${signal.id}\``);
  lines.push(
    `- **Autor**: ${
      signal.authorName
        ? `${externalInline(signal.authorName)} (@${externalInline(signal.authorHandle)})`
        : `@${externalInline(signal.authorHandle)}`
    }`,
  );
  // ESTIMADA: siempre con virgulilla (§3.3 del contrato, glossary.ts:likedAt).
  lines.push(`- **Guardado**: ${formatEstimatedDate(signal.likedAt)}`);
  lines.push(`- **Categoría**: ${signal.category ?? 'sin clasificar'}`);
  if (signal.pestel.length > 0) lines.push(`- **PESTEL**: ${signal.pestel.join(', ')}`);
  lines.push(`- **Vitalidad**: ${formatVitality(signal.vitality)}`);
  lines.push(`- **Tema**: ${formatThemeLine(signal.theme)}`);
  // `publishStatus` como DATO de curaduría, no como filtro: en este servidor la
  // persona ve todo su banco, y lo que aporta el campo es saber qué ya revisó.
  // Se omite la línea si la API no lo manda (campo pendiente de confirmar).
  if (signal.publishStatus) {
    lines.push(
      `- **Curaduría**: ${signal.publishStatus === 'published' ? 'revisada' : 'todavía sin revisar'}`,
    );
  }
  if (signal.tldr) {
    lines.push('');
    lines.push(externalBlock(signal.tldr));
  }
  lines.push('');
  lines.push(signal.url);
  return lines.join('\n');
}

/** Ficha completa: TL;DR + por qué importa + impacto + procedencia exacta del tweet. */
export function formatSignalDetail(signal: SignalDetailDTO): string {
  const lines = [formatSignalSummary(signal), ''];

  if (signal.whyMatters) {
    lines.push('**Por qué importa**');
    lines.push('');
    lines.push(externalBlock(signal.whyMatters));
    lines.push('');
  }
  if (signal.impact) {
    lines.push('**Impacto en el desarrollo de la IA y la interacción humana**');
    lines.push('');
    lines.push(externalBlock(signal.impact));
    lines.push('');
  }

  lines.push(`- **Fuente**: ${signal.source === 'x_like' ? 'like en X' : 'agregada a mano'}`);
  // `tweetCreatedAt` es EXACTA (derivada del snowflake id): sin virgulilla, a
  // diferencia de `likedAt`. `null` en señales `manual` (no hay tweet detrás).
  if (signal.tweetCreatedAt) {
    lines.push(`- **Tweet publicado**: ${formatDate(signal.tweetCreatedAt)}`);
    lines.push(`- **Tweet**: ${signal.tweetUrl}`);
  }
  lines.push(`- **Vecinos semánticos**: ${signal.neighborCount}`);
  // `publishedAt` es exacta (cuándo la persona dio la señal por revisada), no
  // una estimación de like: sin virgulilla, igual que `tweetCreatedAt`.
  if (signal.publishedAt) lines.push(`- **Revisada**: ${formatDate(signal.publishedAt)}`);

  return lines.join('\n');
}

/** Listado paginado de señales, cada una con `formatSignalSummary`. */
export function formatSignalList(data: readonly SignalSummaryDTO[], meta: ApiMeta): string {
  if (data.length === 0) return 'No hay señales que coincidan con esos filtros.';
  const items = data.map((signal) => formatSignalSummary(signal));
  const footer = paginationFooter(meta);
  return [...items, ...(footer ? [footer] : [])].join('\n\n');
}

// Etiqueta en español de `strength`. El DTO usa `"debil"` en ASCII a propósito
// (docs/API.md §7: para que la comparación de strings no dependa de
// normalización Unicode); aquí, para MOSTRAR a una persona, sí se acentúa.
const STRENGTH_LABELS_ES: Record<NeighborStrength, string> = {
  fuerte: 'fuerte',
  media: 'media',
  debil: 'débil',
};

/**
 * Vecinos semánticos de una señal. REGLA DURA (docs/API.md §7): este markdown
 * NUNCA muestra el `%` de similitud ni el `score` numérico — solo `strength`.
 * El `score` crudo viaja en `structuredContent` (lo arma la tool, no esta
 * función) para el razonamiento del agente, nunca para redactar hacia una
 * persona. Hay un test (`tests/format.test.ts`) que verifica la ausencia de
 * `%` y de cifras de similitud en esta salida.
 */
export function formatNeighbors(data: readonly NeighborDTO[], meta: ApiMeta): string {
  if (data.length === 0) return 'No hay vecinos semánticos por encima del umbral pedido.';
  const items = data.map((neighbor) => {
    const lines = [
      `### ${externalInline(neighbor.signal.title)}`,
      '',
      `- **id**: \`${neighbor.signal.id}\``,
      `- **Cercanía**: ${STRENGTH_LABELS_ES[neighbor.strength]}`,
      `- **Tema**: ${formatThemeLine(neighbor.signal.theme)}`,
      `- **Guardado**: ${formatEstimatedDate(neighbor.signal.likedAt)}`,
    ];
    return lines.join('\n');
  });
  const footer = paginationFooter(meta);
  return [...items, ...(footer ? [footer] : [])].join('\n\n');
}
