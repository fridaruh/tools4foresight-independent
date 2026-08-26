/**
 * Regresiones de la prueba de aceptación contra producción.
 *
 * Cada `describe` de aquí cubre un fallo REAL, observado contra el despliegue en
 * vivo, no una hipótesis. Están juntos a propósito: son los sitios donde una
 * regla del método se puede volver a romper EN SILENCIO —el servidor responde
 * 200, el markdown se ve bien y lo que dice es falso—, que es exactamente lo que
 * no detecta ningún test de transporte ni de tipos.
 */
import { describe, expect, it } from 'vitest';
import { formatSignalCounts } from '../src/format/meta.js';
import { formatThemeVitality, formatVitality } from '../src/format/shared.js';
import { formatSnapshot, formatThemeHistory, formatThemeSummary } from '../src/format/theme.js';
import { T4FApiError, toolParamName } from '../src/client/errors.js';
import { GLOSSARY } from '../src/domain/glossary.js';
import type {
  MetaDTO,
  SnapshotDetailDTO,
  ThemeHistoryDTO,
  ThemeSummaryDTO,
} from '../src/client/types.js';

// ---------------------------------------------------------------------------
// Fallo 1 — `get_corpus_overview` mentía sobre el tamaño del banco
// ---------------------------------------------------------------------------

// Las cifras son las medidas en producción: el JSON decía
// `{signals: 43, publishedSignals: 18}` y el markdown decía "Señales: 18".
const COUNTS: MetaDTO['counts'] = {
  signals: 43,
  publishedSignals: 18,
  themesAlive: 4,
  themesDead: 2,
  macroThemes: 3,
  links: 91,
  categories: 11,
  snapshots: 7,
};

describe('fallo 1: los dos conteos de señales viajan siempre juntos', () => {
  it('muestra el total del banco y lo publicado, cada uno con su etiqueta', () => {
    const lines = formatSignalCounts(COUNTS).join('\n');
    expect(lines).toContain('43');
    expect(lines).toContain('18');
    // La regresión concreta: rotular las publicadas como "Señales" a secas.
    // El total tiene que estar etiquetado como total, no ser el que falta.
    expect(lines).toMatch(/total.*43|43.*total/is);
  });

  it('dice POR QUÉ difieren, sin obligar a abrir el structuredContent', () => {
    const lines = formatSignalCounts(COUNTS).join('\n');
    // Solo lo publicado entra al grafo/temas/horizontes: es la explicación que
    // convierte dos números sueltos en información utilizable.
    expect(lines).toMatch(/grafo/i);
    expect(lines).toMatch(/25/); // las 43 - 18 que todavía están `pending`
  });

  it('cuando no hay pendientes no inventa una diferencia', () => {
    const lines = formatSignalCounts({ ...COUNTS, signals: 18 }).join('\n');
    expect(lines).toMatch(/100%/);
    expect(lines).not.toMatch(/pending/);
  });
});

// ---------------------------------------------------------------------------
// Fallo 3 — los fósiles salían etiquetados "(viva)"
// ---------------------------------------------------------------------------

function makeTheme(overrides: Partial<ThemeSummaryDTO> = {}): ThemeSummaryDTO {
  return {
    id: '3f0f04e7-1a2b-4c3d-8e9f-0a1b2c3d4e5f',
    name: 'Transformación Digital del Gobierno Mexicano',
    summary: 'Señales sobre digitalización pública.',
    status: 'alive',
    size: 9,
    vitality: 4.2,
    horizon: 'H2',
    horizonSuggested: 'H2',
    horizonSource: 'auto',
    macroTheme: null,
    lastSignalAt: null,
    ...overrides,
  };
}

describe('fallo 3: un tema fósil nunca se anuncia "viva"', () => {
  // Los dos casos exactos vistos en producción.
  it.each([47.42, 2.9])('vitalidad %s en un fósil no lleva la etiqueta "viva"', (vitality) => {
    // La función de señales sí la pone, y no está mal para su escala: lo que
    // faltaba era leer el estado del tema junto al número.
    expect(formatVitality(vitality)).toContain('viva');

    const label = formatThemeVitality(vitality, 'dead');
    expect(label).not.toContain('(viva)');
    expect(label).toContain('fósil');
    expect(label).toContain(vitality.toFixed(2));
  });

  it('explica que un fósil con vitalidad alta murió por linaje, no por apagarse', () => {
    const label = formatThemeVitality(47.42, 'dead');
    expect(label).toMatch(/linaje/i);
    expect(label).toMatch(/Jaccard/i);
  });

  it('un fósil que sí cayó bajo el umbral lo dice como lo que es', () => {
    const label = formatThemeVitality(0.4, 'dead');
    expect(label).toMatch(/umbral/i);
    expect(label).not.toMatch(/Jaccard/i);
  });

  it('un tema vivo conserva la etiqueta cualitativa de siempre', () => {
    expect(formatThemeVitality(4.12, 'alive')).toBe('4.12 (viva)');
    expect(formatThemeVitality(1.2, 'alive')).toBe('1.20 (estable)');
    expect(formatThemeVitality(null, 'dead')).toMatch(/sin vitalidad calculada/);
  });

  it('la contradicción no reaparece en la ficha completa de un tema', () => {
    const md = formatThemeSummary(makeTheme({ status: 'dead', vitality: 47.42, horizon: null }));
    expect(md).toContain('**Estado**: fósil');
    expect(md).not.toContain('(viva)');
  });

  it('tampoco en las filas de un snapshot', () => {
    const snapshot: SnapshotDetailDTO = {
      id: 'snap-1',
      takenAt: '2026-08-25T06:00:11.402Z',
      trigger: 'cron',
      nodes: 40,
      links: 91,
      themesAlive: 4,
      themesDead: 2,
      orphans: 5,
      themes: [
        {
          themeId: 'theme-1',
          name: 'Transformación Digital del Gobierno Mexicano',
          size: 0,
          status: 'dead',
          vitality: 47.42,
          velocity30d: 0,
          density: null,
          connectivity: null,
          novelty: null,
          horizon: null,
        },
      ],
    };
    expect(formatSnapshot(snapshot)).not.toContain('(viva)');
  });

  it('el glosario documenta las DOS vías de muerte, no solo la vitalidad', () => {
    const fosil = GLOSSARY.fosil?.long ?? '';
    expect(fosil).toMatch(/linaje/i);
    expect(fosil).toMatch(/Jaccard/i);
    // Y la entrada de vitalidad advierte de que el número solo no basta.
    expect(GLOSSARY.vitalidad?.long ?? '').toMatch(/status/i);
  });
});

// ---------------------------------------------------------------------------
// Fallo 4 — `get_theme` y `get_theme_history` daban nombres distintos
// ---------------------------------------------------------------------------

const HISTORY: ThemeHistoryDTO = {
  themeId: '3f0f04e7-1a2b-4c3d-8e9f-0a1b2c3d4e5f',
  points: [
    {
      themeId: '3f0f04e7-1a2b-4c3d-8e9f-0a1b2c3d4e5f',
      name: 'Enlaces rotos de fuentes oficiales',
      size: 6,
      status: 'alive',
      vitality: 2.1,
      velocity30d: 2,
      density: 0.6,
      connectivity: 0.2,
      novelty: 0.5,
      horizon: 'H3',
      takenAt: '2026-07-21T06:00:08.114Z',
      trigger: 'cron',
    },
    {
      themeId: '3f0f04e7-1a2b-4c3d-8e9f-0a1b2c3d4e5f',
      name: 'Portales gubernamentales mexicanos caídos',
      size: 9,
      status: 'alive',
      vitality: 4.2,
      velocity30d: 5,
      density: 0.7,
      connectivity: 0.3,
      novelty: 0.45,
      horizon: 'H2',
      takenAt: '2026-08-25T06:00:11.402Z',
      trigger: 'cron',
    },
  ],
};

describe('fallo 4: el histórico dice que sus nombres son los de cada corrida', () => {
  it('titula con el nombre ACTUAL cuando la tool lo pudo resolver', () => {
    const md = formatThemeHistory(HISTORY, 'Portales gubernamentales mexicanos caídos');
    expect(md).toContain('Portales gubernamentales mexicanos caídos');
    expect(md).toContain('nombre actual');
    // Nunca más el nombre del PRIMER punto —el más viejo— haciendo de título.
    expect(md.indexOf('Enlaces rotos')).toBeGreaterThan(md.indexOf('nombre actual'));
  });

  it('muestra en cada punto el nombre que el tema tenía entonces', () => {
    const md = formatThemeHistory(HISTORY, 'Portales gubernamentales mexicanos caídos');
    expect(md).toContain('se llamaba «Enlaces rotos de fuentes oficiales»');
    expect(md).toMatch(/EN ESA CORRIDA/);
    // Y deja claro que el id es lo estable, que es lo que corta en seco la
    // conclusión errónea ("me equivoqué de id").
    expect(md).toContain(HISTORY.themeId);
  });

  it('sin nombre actual cae al id, nunca a un nombre histórico disfrazado de actual', () => {
    const md = formatThemeHistory(HISTORY);
    expect(md).toContain(`## Historia de \`${HISTORY.themeId}\``);
  });

  it('sin puntos sigue sin reventar', () => {
    expect(formatThemeHistory({ themeId: 'theme-1', points: [] })).toMatch(/Sin puntos/);
  });
});

// ---------------------------------------------------------------------------
// Fallo 5 — el error hablaba el vocabulario del HTTP, no el de la tool
// ---------------------------------------------------------------------------

describe('fallo 5: los errores 400 hablan el vocabulario de las tools', () => {
  it('traduce el nombre del parámetro y también el que va dentro del mensaje', () => {
    // El 400 literal de producción.
    const error = new T4FApiError({
      status: 400,
      code: 'invalid_parameter',
      message: 'El parámetro "minScore" debe ser un número entre 0 y 1.',
      param: 'minScore',
    });
    const message = error.messageForModel();
    expect(message).toContain('min_score');
    expect(message).not.toContain('minScore');
  });

  it('cubre el resto de parámetros que cambian de nombre en la frontera', () => {
    expect(toolParamName('minVitality')).toBe('min_vitality');
    expect(toolParamName('theme')).toBe('theme_id');
    expect(toolParamName('macroTheme')).toBe('macro_theme_id');
    expect(toolParamName('orphans')).toBe('orphans_only');
    expect(toolParamName('includeMembers')).toBe('include_members');
  });

  it('deja intactos los que se llaman igual en los dos lados', () => {
    for (const param of ['limit', 'cursor', 'from', 'to', 'horizon', 'sort', 'q', 'category', 'pestel', 'status']) {
      expect(toolParamName(param)).toBe(param);
    }
  });
});

// ---------------------------------------------------------------------------
// Fallo 2 — el glosario nombraba a una persona y filtraba rutas del código
// ---------------------------------------------------------------------------

describe('fallo 2: el glosario no nombra a nadie ni enseña las tripas del repo', () => {
  // Se recorre TODO lo que se le sirve al usuario (short, long, formula y las
  // constantes), no una lista de líneas: una entrada nueva queda cubierta sola.
  const servedText = Object.values(GLOSSARY)
    .flatMap((entry) => [
      entry.short,
      entry.long,
      entry.formula ?? '',
      ...(entry.constants ?? []).flatMap((c) => [c.name, c.value, c.source]),
    ])
    .join('\n');

  it('no menciona a ninguna persona por su nombre propio', () => {
    // Este servidor es multi-tenant: quien pregunta es la dueña de SU banco, y
    // quien lo curó es esa misma persona. Un nombre propio ahí es de otro banco.
    expect(servedText).not.toMatch(/Frida/i);
  });

  it('no expone rutas de archivo ni nombres de variables de entorno', () => {
    expect(servedText).not.toMatch(/src\//);
    expect(servedText).not.toMatch(/\.ts\b/);
    expect(servedText).not.toMatch(/GRAPH_HALF_LIFE_DAYS/);
  });

  it('conserva el valor y el nombre de las constantes, que sí son informativos', () => {
    const sources = Object.values(GLOSSARY).flatMap((e) => (e.constants ?? []).map((c) => c.source));
    expect(sources.some((s) => s.includes('DEAD_THRESHOLD'))).toBe(true);
    expect(sources.some((s) => s.includes('LINEAGE_JACCARD'))).toBe(true);
    expect(sources.every((s) => s.length > 0)).toBe(true);
  });
});
