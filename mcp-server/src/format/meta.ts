// Capa de formato — el resumen del banco (`MetaDTO`, el DTO de `/meta`).
//
// OJO con el nombre: `formatMeta` de `shared.ts` formatea `ApiMeta`, el SOBRE de
// paginación ("N resultados · generado <fecha>"). Este archivo formatea
// `MetaDTO`, que es otra cosa entera: conteos del banco, rango de fechas, última
// corrida y constantes del modelo. Dos tipos distintos que se llaman parecido
// por coincidencia histórica.
//
// Por qué vive aquí y no dentro de su consumidor: hay DOS renderizadores del
// resumen —la tool `get_corpus_overview` y el resource `foresight://overview`—
// con formas distintas (encabezado, agrupación de líneas) pero con la misma
// pieza crítica dentro: los dos conteos de señales. Cuando esa pieza estaba
// duplicada, se rompió en los dos sitios a la vez y en silencio: ambos rotulaban
// `publishedSignals` como "Señales" a secas y se comían el total del banco. Un
// solo sitio para la regla es lo que evita la próxima repetición.
import type { MetaDTO } from '../client/types.js';

/**
 * Las dos líneas de conteo de señales, SIEMPRE las dos.
 *
 * `counts.signals` es el banco entero y `counts.publishedSignals` el subconjunto
 * ya curado. La diferencia no es cosmética: el grafo, los temas, las aristas y
 * los horizontes se calculan solo sobre lo publicado, así que `publishedSignals`
 * es el denominador de todas las demás cifras del resumen mientras que `signals`
 * y `dateRange` describen el banco completo.
 *
 * Enseñar solo uno —lo que hacían las dos vistas -- le da un tamaño de corpus
 * falso a un modelo al que las `instructions` del servidor mandan empezar
 * justamente por aquí, y que después se topa con señales que creía inexistentes.
 * Por eso el texto explica también POR QUÉ difieren: que no haya que abrir el
 * `structuredContent` para entenderlo.
 */
export function formatSignalCounts(counts: MetaDTO['counts']): string[] {
  const pending = counts.signals - counts.publishedSignals;
  const published =
    pending > 0
      ? `${counts.publishedSignals} — las que ya curaste. Son las únicas que entran al grafo, a los temas y a ` +
        `los horizontes, así que todo lo que sigue se calcula sobre estas ${counts.publishedSignals}, no sobre ` +
        `las ${counts.signals}. Las otras ${pending} están \`pending\`: siguen siendo tuyas y \`list_signals\` ` +
        `las devuelve, solo que todavía no forman parte del mapa.`
      : `${counts.publishedSignals} — todo tu banco está curado, así que el mapa cubre el 100% de tus señales.`;

  return [
    `- **Señales en tu banco (total)**: ${counts.signals} — todo lo que has guardado, lo hayas revisado o no.`,
    `- **Señales publicadas**: ${published}`,
  ];
}
