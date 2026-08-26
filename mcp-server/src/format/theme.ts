// Capa de formato — temas, horizontes, macro-temas, grafo y snapshots
// (docs/PLAN.md §2.6). Funciones puras: DTO -> markdown en español.
import {
  externalBlock,
  externalInline,
  formatDate,
  formatDateTime,
  formatEstimatedDate,
  formatHorizonLabel,
  formatThemeStatus,
  formatThemeVitality,
  paginationFooter,
} from './shared.js';
import type {
  ApiMeta,
  GraphDTO,
  HorizonDTO,
  HorizonDetailDTO,
  MacroThemeDTO,
  SnapshotDetailDTO,
  SnapshotSummaryDTO,
  ThemeDetailDTO,
  ThemeHistoryDTO,
  ThemeSummaryDTO,
} from '../client/types.js';

// ---------------------------------------------------------------------------
// Tema
// ---------------------------------------------------------------------------

/** Ficha corta de un tema: para listados y para las referencias dentro de un macro-tema/horizonte. */
export function formatThemeSummary(theme: ThemeSummaryDTO): string {
  const lines: string[] = [];
  // El nombre y el resumen de un tema los redacta un modelo a partir del texto
  // de las señales que lo forman: son, indirectamente, contenido de terceros
  // (ver shared.ts). Se tratan igual que el texto original.
  lines.push(`### ${externalInline(theme.name)}`);
  lines.push('');
  lines.push(`- **id**: \`${theme.id}\``);
  lines.push(`- **Estado**: ${formatThemeStatus(theme.status)}`);
  lines.push(`- **Horizonte**: ${formatHorizonLabel(theme.horizon)}`);
  lines.push(`- **Tamaño**: ${theme.size} señales`);
  lines.push(`- **Vitalidad**: ${formatThemeVitality(theme.vitality, theme.status)}`);
  if (theme.macroTheme) lines.push(`- **Macro-tema**: ${externalInline(theme.macroTheme.name)}`);
  // ESTIMADA: es el `likedAt` de la señal más reciente del tema.
  if (theme.lastSignalAt) lines.push(`- **Última señal**: ${formatEstimatedDate(theme.lastSignalAt)}`);
  lines.push('');
  lines.push(externalBlock(theme.summary));
  return lines.join('\n');
}

/** Ficha completa: linaje (nacimiento/muerte/resurrecciones), los cuatro indicadores y la membresía. */
export function formatThemeDetail(theme: ThemeDetailDTO): string {
  const lines = [formatThemeSummary(theme), ''];

  lines.push(`- **Nació**: ${formatDate(theme.firstSeenAt)}`);
  if (theme.diedAt) lines.push(`- **Murió**: ${formatDate(theme.diedAt)}`);
  if (theme.revivedCount > 0) {
    lines.push(`- **Resucitado**: ${theme.revivedCount} ${theme.revivedCount === 1 ? 'vez' : 'veces'}`);
  }

  const { indicators } = theme;
  const deltaSign = indicators.velocityDelta >= 0 ? '+' : '';
  lines.push('');
  lines.push('**Indicadores**');
  lines.push(
    `- Velocidad: ${indicators.velocity30d} señales nuevas en 30d (30d previos: ${indicators.velocityPrev30d}, delta: ${deltaSign}${indicators.velocityDelta})`,
  );
  lines.push(`- Densidad: ${indicators.density !== null ? indicators.density.toFixed(2) : 'sin calcular'}`);
  lines.push(
    `- Conectividad: ${indicators.connectivity !== null ? indicators.connectivity.toFixed(2) : 'sin calcular'}`,
  );
  lines.push(`- Novedad: ${indicators.novelty !== null ? indicators.novelty.toFixed(2) : 'sin calcular'}`);
  lines.push(`- Temas puente: ${indicators.bridgeThemes}`);

  lines.push('');
  // `memberIds` es lo único que tienen los temas fósiles (lastMemberIds, ver
  // docs/API.md §8): se muestra igual en vivos y fósiles.
  lines.push(`**Miembros** (${theme.memberIds.length}): ${theme.memberIds.map((id) => `\`${id}\``).join(', ')}`);

  return lines.join('\n');
}

/** Listado paginado de temas. */
export function formatThemeList(data: readonly ThemeSummaryDTO[], meta: ApiMeta): string {
  if (data.length === 0) return 'No hay temas que coincidan con esos filtros.';
  const items = data.map((theme) => formatThemeSummary(theme));
  const footer = paginationFooter(meta);
  return [...items, ...(footer ? [footer] : [])].join('\n\n');
}

/** Estado histórico de un tema en una corrida (`SnapshotThemeRowDTO.status` es `string`: histórico, no el enum vivo). */
function formatHistoricalStatus(status: string): string {
  if (status === 'dead') return 'fósil';
  if (status === 'alive') return 'vivo';
  return status;
}

/**
 * `SnapshotThemeRowDTO.status` viaja como `string` suelto (es un valor
 * histórico, no el enum vivo), pero `formatThemeVitality` necesita saber si esa
 * fila era un fósil. Cualquier cosa que no sea `'dead'` se trata como viva: si
 * llegara un estado nuevo, la etiqueta cualitativa normal es la lectura menos
 * arriesgada, y el estado crudo se muestra igual al lado.
 */
function historicalVitality(vitality: number, status: string): string {
  return formatThemeVitality(vitality, status === 'dead' ? 'dead' : 'alive');
}

/**
 * Serie temporal de un tema. SIEMPRE en el mismo orden en que llega el DTO
 * (ascendente por `takenAt`, garantizado por el servidor — docs/API.md §4.9):
 * este formateador no reordena nada, para no invertir por accidente una serie
 * que ya viene lista para graficar.
 *
 * EL NOMBRE DE CADA PUNTO ES EL DE AQUELLA CORRIDA, NO EL ACTUAL, y eso se dice
 * con todas las letras. El job de grafo rebautiza un tema (con el modelo) cada
 * vez que cambia su membresía, y `graph_snapshot_clusters` congela el nombre que
 * tenía en esa foto. Resultado verificado en producción: `get_theme` devuelve
 * "Portales gubernamentales mexicanos caídos" y el histórico del MISMO id dice
 * "Enlaces rotos de fuentes oficiales". Sin la nota, la conclusión razonable de
 * un modelo es que se equivocó de id — y es la conclusión equivocada.
 *
 * `currentName` es opcional a propósito: lo pasa la tool cuando pudo resolver el
 * nombre vigente, y si no pudo (o si nadie lo pasa) el encabezado cae al id, que
 * es lo único estable de un tema. Nunca se titula con el nombre del primer punto
 * como se hacía antes: ese es el nombre MÁS VIEJO de todos, el peor candidato a
 * pasar por "el nombre del tema".
 */
export function formatThemeHistory(history: ThemeHistoryDTO, currentName?: string): string {
  if (history.points.length === 0) return 'Sin puntos históricos para este tema en el rango pedido.';
  const title = currentName ? externalInline(currentName) : history.themeId;
  const rows = history.points.map((point) => {
    const status = formatHistoricalStatus(point.status);
    const name = externalInline(point.name);
    return `- ${formatDateTime(point.takenAt)} (${point.trigger}) — se llamaba «${name}»: tamaño ${point.size}, ${status}, ${historicalVitality(point.vitality, point.status)}, velocidad ${point.velocity30d}, ${formatHorizonLabel(point.horizon)}`;
  });
  const header = [
    `## Historia de ${currentName ? `"${title}" (nombre actual)` : `\`${title}\``}`,
    '',
    `- **id**: \`${history.themeId}\` — es lo único estable de un tema: persiste aunque cambie de nombre, muera y resucite.`,
    '',
    '_El nombre que aparece en cada punto es el que el tema tenía EN ESA CORRIDA. Se regenera cada vez que ' +
      'cambia su membresía, así que ver nombres distintos a lo largo de la serie es lo normal y NO significa ' +
      'que sean temas distintos ni que te hayas equivocado de id._',
    '',
  ];
  return [...header, ...rows].join('\n');
}

// ---------------------------------------------------------------------------
// Horizonte y macro-tema
// ---------------------------------------------------------------------------

function formatHorizonMacroThemesBlock(macroThemes: readonly MacroThemeDTO[]): string[] {
  if (macroThemes.length === 0) return [];
  const lines = ['', '**Macro-temas**'];
  for (const macro of macroThemes) lines.push(`- ${externalInline(macro.name)}`);
  return lines;
}

/**
 * Un horizonte con todos sus temas vivos (`/horizons/{key}`). `labelShort` y
 * `labelLong` se toman TAL CUAL del DTO (el servidor ya las resolvió desde
 * `HORIZON_LABELS`): no se recalculan aquí para no arriesgar una segunda
 * fuente de verdad que se desincronice de la real.
 */
export function formatHorizon(horizon: HorizonDetailDTO): string {
  const lines = [
    `## ${horizon.labelShort}`,
    '',
    horizon.labelLong,
    '',
    `- **Temas vivos**: ${horizon.themeCount}`,
    `- **Señales**: ${horizon.signalCount}`,
    `- **Vitalidad total**: ${horizon.vitalitySum.toFixed(2)}`,
    ...formatHorizonMacroThemesBlock(horizon.macroThemes),
  ];
  if (horizon.themes.length > 0) {
    lines.push('', '**Temas**');
    for (const theme of horizon.themes) lines.push(`- ${externalInline(theme.name)} — ${formatThemeVitality(theme.vitality, theme.status)}`);
  }
  return lines.join('\n');
}

/**
 * Panorama de los tres horizontes (`/horizons`). Nota de forma (docs/API.md
 * §4.11): en este listado, `macroThemes[].themes` viene vacío a propósito —
 * los temas completos se piden con `formatHorizon` (detalle) o
 * `formatMacroTheme`.
 */
export function formatHorizonsOverview(data: readonly HorizonDTO[], meta: ApiMeta): string {
  if (data.length === 0) return 'Sin datos de horizontes.';
  const sections = data.map((horizon) =>
    [
      `## ${horizon.labelShort}`,
      '',
      horizon.labelLong,
      '',
      `- **Temas vivos**: ${horizon.themeCount}`,
      `- **Señales**: ${horizon.signalCount}`,
      `- **Vitalidad total**: ${horizon.vitalitySum.toFixed(2)}`,
      ...formatHorizonMacroThemesBlock(horizon.macroThemes),
    ].join('\n'),
  );
  const footer = paginationFooter(meta);
  return [...sections, ...(footer ? [footer] : [])].join('\n\n');
}

/**
 * Un macro-tema con sus temas miembro. El id se marca explícitamente como NO
 * estable (docs/API.md §4.10: se borra y recrea entero en cada corrida) para
 * que un agente no lo guarde entre sesiones ni lo use como referencia
 * duradera — a diferencia del id de un tema, que sí persiste.
 */
export function formatMacroTheme(macro: MacroThemeDTO): string {
  const lines = [
    `### ${externalInline(macro.name)}`,
    '',
    `- **id**: \`${macro.id}\` _(no estable entre corridas — no lo guardes)_`,
    `- **Horizonte**: ${formatHorizonLabel(macro.horizon)}`,
    '',
    externalBlock(macro.summary),
  ];
  if (macro.themes.length > 0) {
    lines.push('', '**Temas**');
    for (const theme of macro.themes) lines.push(`- ${externalInline(theme.name)} — ${formatThemeVitality(theme.vitality, theme.status)}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Grafo
// ---------------------------------------------------------------------------

/**
 * Estadísticas del grafo semántico completo (`/graph`). Deliberadamente NO
 * vuelca `nodes`/`edges` fila por fila en el markdown (podrían ser miles): el
 * detalle completo viaja en `structuredContent` (lo arma la tool), esto es
 * solo el resumen legible para una persona.
 */
export function formatGraphStats(graph: GraphDTO, meta?: ApiMeta): string {
  const lines = [
    '## Grafo semántico',
    '',
    `- **Nodos**: ${graph.stats.nodes}`,
    `- **Aristas**: ${graph.stats.edges}`,
    `- **Temas vivos**: ${graph.stats.themesAlive}`,
    `- **Temas fósiles**: ${graph.stats.themesDead}`,
    `- **Huérfanas**: ${graph.stats.orphans}`,
  ];
  if (meta?.truncated) {
    lines.push('', '_Nota: el resultado se recortó al límite de nodos pedido; hay más señales en el mapa de las que se muestran aquí._');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

/** Una corrida del grafo, con el estado de todos sus temas (y, si se pidió, la membresía). */
export function formatSnapshot(snapshot: SnapshotDetailDTO, meta?: ApiMeta): string {
  const lines = [
    `## Snapshot del ${formatDateTime(snapshot.takenAt)}`,
    '',
    `- **id**: \`${snapshot.id}\``,
    `- **Disparado por**: ${snapshot.trigger}`,
    `- **Nodos**: ${snapshot.nodes}`,
    `- **Aristas**: ${snapshot.links}`,
    `- **Temas vivos**: ${snapshot.themesAlive}`,
    `- **Temas fósiles**: ${snapshot.themesDead}`,
    `- **Huérfanas**: ${snapshot.orphans}`,
  ];

  if (snapshot.themes.length > 0) {
    // Mismo cuidado que en `formatThemeHistory`: estos nombres son los que cada
    // tema tenía EN ESTA CORRIDA (`graph_snapshot_clusters` los congela), no los
    // de hoy. Sin la nota, comparar un snapshot con `list_themes` parece un
    // desajuste de datos y es solo el paso del tiempo.
    lines.push('', '**Temas en esta corrida** _(con el nombre que tenían entonces, no el actual)_');
    for (const theme of snapshot.themes) {
      lines.push(`- ${externalInline(theme.name)}: ${formatHistoricalStatus(theme.status)}, ${historicalVitality(theme.vitality, theme.status)}`);
    }
  }

  if (snapshot.members) {
    const truncatedNote = meta?.truncated ? ' _(truncado al tope de 5000 filas)_' : '';
    lines.push('', `**Membresía**: ${snapshot.members.length} filas${truncatedNote}`);
  }

  return lines.join('\n');
}

/** Listado paginado de snapshots (una línea por corrida). */
export function formatSnapshotList(data: readonly SnapshotSummaryDTO[], meta: ApiMeta): string {
  if (data.length === 0) return 'No hay snapshots en ese rango.';
  const items = data.map(
    (snapshot) =>
      `- ${formatDateTime(snapshot.takenAt)} (\`${snapshot.id}\`, ${snapshot.trigger}): ${snapshot.nodes} nodos, ${snapshot.links} aristas, ${snapshot.themesAlive} vivos / ${snapshot.themesDead} fósiles, ${snapshot.orphans} huérfanas`,
  );
  const footer = paginationFooter(meta);
  return ['## Snapshots', '', ...items, ...(footer ? ['', footer] : [])].join('\n');
}
