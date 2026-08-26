/**
 * Glosario del dominio de foresight.
 *
 * Datos puros (sin dependencias, sin red, sin I/O).
 * Cada entrada transmite lo que un agente necesita para **no equivocarse al hablar del mapa**.
 *
 * @author Frida Rodríguez
 * @license MIT
 */

export type GlossaryEntry = {
  /** Clave estable, en español sin acentos ni espacios. Ejemplos: "vitalidad", "fosil", "H1". */
  key: string;
  /** Cómo se llama en la interfaz y en los textos. */
  term: string;
  /** 1-2 frases: qué es, en lenguaje llano. */
  short: string;
  /** Explicación completa en markdown: cómo se calcula, por qué existe, cómo leerlo. */
  long: string;
  /** Fórmula o regla exacta, si aplica. */
  formula?: string;
  /** Constantes reales con su valor y de dónde salen. */
  constants?: { name: string; value: string; source: string }[];
  /** Claves de otras entradas relacionadas. */
  related: string[];
};

export const GLOSSARY: Record<string, GlossaryEntry> = {
  senal: {
    key: "senal",
    term: "Señal",
    short:
      "Una pieza de contenido curada: un tweet, un artículo o un enlace que indica un indicio de futuro.",
    long: `Una **señal** es el acto de guardar como "me gusta" en X una publicación que importa.
Es la unidad más pequeña del mapa: contenido sobre el que alguien ha puesto atención.
Cada señal lleva:
- **Texto**: el tuit original, el título del artículo, la URL del link.
- **Fecha**: \`tweetCreatedAt\` (exacta, del snowflake), \`likedAt\` (estimada), \`detectedAt\` (exacta, del polling).
- **Análisis**: TL;DR, por qué importa, impacto en la IA y la interacción humana.
- **Clasificación**: categoría, dimensiones PESTEL.
- **Membresía**: pertenencia a un **tema** (si se detectó) o condición de huérfana.
- **Vitalidad**: número que decae con el tiempo; se reanima si vecinas recientes la empujan.

No se borran nunca. Se publican o despublican; si se despubblica, desaparece del grafo en la siguiente corrida.`,
    formula: "Un item de \`liked_items\` con \`publishStatus = 'published'\`.",
    constants: [
      {
        name: "Máximo PESTEL por señal",
        value: "2",
        source:
          "Regla de análisis (src/lib/analysis-prompts.ts): cada señal lleva máximo 2 dimensiones.",
      },
    ],
    related: ["tema", "vitalidad", "likedAt", "huerfana", "pestel"],
  },

  tema: {
    key: "tema",
    term: "Tema (cluster semántico)",
    short: "Un linaje persistente de señales relacionadas semánticamente, con historia e identidad estable.",
    long: `Un **tema** es un grupo de señales que comparten significado semántico.
Se detecta cada corrida usando propagación de etiquetas sobre el grafo de similitud (aristas de coseno > 0.55).

**Linaje**: el tema mantiene su identidad entre corridas. Si una nueva comunidad detectada tiene Jaccard ≥ 0.3 con la membresía anterior de un tema, se empareja.
Sin pareja, nace un tema nuevo. El id se conserva, así que una señal publicada hace meses puede entrar en el tema meses después.

**Historia**: cada tema preserva:
- Snapshots de su membresía a través del tiempo (para trazar cuando nació, creció, encorvó).
- Indicadores: velocidad (en últimos 30 días vs. 30 anteriores), densidad, conectividad, novedad, numero de temas puente.
- Horizonte sugerido (H1/H2/H3) o fijado manualmente.

**Muerte y resurrección**: si la vitalidad suma cae bajo 1.0, pasa a \`status: 'dead'\` (fósil).
No se borra. Si luego entran señales nuevas con vitalidad ≥ 1.0, resucita automáticamente (vuelve a \`status: 'alive'\`).`,
    constants: [
      {
        name: "Tamaño mínimo para ser tema",
        value: "3 señales",
        source: "MIN_CLUSTER_SIZE (src/lib/jobs/clusters.ts)",
      },
      {
        name: "Umbral de linaje (Jaccard)",
        value: "≥ 0.3",
        source: "LINEAGE_JACCARD (src/lib/jobs/graph.ts)",
      },
      {
        name: "Umbral de muerte",
        value: "< 1.0 de vitalidad",
        source: "DEAD_THRESHOLD (src/lib/jobs/graph.ts)",
      },
    ],
    related: ["linaje", "fosil", "resurrección", "vitalidad", "snapshot", "horizonte"],
  },

  linaje: {
    key: "linaje",
    term: "Linaje",
    short: "La identidad persistente de un tema entre corridas, emparejado por similitud de membresía.",
    long: `El **linaje** es lo que hace que un tema sea \`el mismo tema\` a lo largo del tiempo, aunque sus miembros cambien.

En cada corrida de grafo, se detectan nuevas comunidades. Cada comunidad se empareja con el tema existente cuya membresía anterior tenga mayor **Jaccard** (solapamiento).
- Si Jaccard ≥ 0.3: se emparejan. El tema nuevo preserva el \`id\` antiguo, ganando historial.
- Si Jaccard < 0.3: sin pareja, el tema viejo muere (si no resucita), nace un nuevo con \`id\` nuevo.

Así, una señal publicada hace 6 meses puede entrar en su tema original la próxima corrida porque el tema "lo espera" con su id.
Es la columna vertebral de la trazabilidad temporal.`,
    formula: "Jaccard(membros_nuevos, membros_viejos) = |intersección| / |unión|",
    constants: [
      {
        name: "Umbral de emparejamiento",
        value: "Jaccard ≥ 0.3",
        source: "LINEAGE_JACCARD (src/lib/jobs/graph.ts)",
      },
    ],
    related: ["tema", "fosil", "resurrección", "snapshot"],
  },

  fosil: {
    key: "fosil",
    term: "Fósil (tema muerto)",
    short: "Un tema cuya vitalidad suma cayó bajo 1.0 y pasó a estado 'dead', pero se preserva en la base de datos.",
    long: `Un **fósil** es un tema que murió: su vitalidad total (suma de vitalidad de sus miembros) cayó por debajo de 1.0.
Pasa a \`status: 'dead'\` y se oculta en la UI por defecto (toggle "mostrar fósiles").

**OJO**: un fósil **no es un tema borrado**. La fila sigue en la DB, con su id, sus miembros guardados en \`lastMemberIds\`, su historia en snapshots.
Es un archivo, no una desaparición.

**Resurrección**: si una nueva señal entra con vitalidad ≥ 1.0 y se empareja por linaje con el fósil, el fósil resucita automáticamente.
Se cuenta el ciclo en \`revivedCount\`.

Decide el decaimiento de vitalidad, no borrado manual ni filtrado arbitrario. Es reversible.`,
    constants: [
      {
        name: "Vitalidad para morir",
        value: "< 1.0",
        source: "DEAD_THRESHOLD (src/lib/jobs/graph.ts)",
      },
    ],
    related: ["tema", "vitalidad", "resurrección", "linaje"],
  },

  resurreccion: {
    key: "resurreccion",
    term: "Resurrección",
    short: "La vuelta a vida de un fósil cuando llega una nueva señal con vitalidad suficiente que se empareja por linaje.",
    long: `Una **resurrección** es cuando un tema fósil (dead) vuelve a \`status: 'alive'\`.
Sucede automáticamente en cada corrida de grafo:
1. Se detecta una nueva comunidad (grafo actual).
2. Se empareja con un tema existente por linaje (Jaccard).
3. Si el tema existente está dead pero la nueva comunidad suma ≥ 1.0 de vitalidad, resucita.

El contador \`revivedCount\` registra cuántas veces ha pasado. No requiere intervención manual.
Muestra que un tema que estaba dormido vuelve a ser relevante.`,
    constants: [
      {
        name: "Contador",
        value: "revivedCount (integer)",
        source: "semantic_clusters.revivedCount (schema)",
      },
    ],
    related: ["fosil", "tema", "vitalidad", "linaje"],
  },

  vitalidad: {
    key: "vitalidad",
    term: "Vitalidad",
    short:
      "Un número [0, ∞) que mide cuánta atención tiene una señal o tema. Decae exponencialmente con el tiempo; se reanima por cercanía semántica reciente.",
    long: `La **vitalidad** es lo que diferencia una señal viva de una dormida (o muerta, si está bajo 1.0).

**Para una señal**:
- Valor intrínseco: \`0.5^(días desde el like / 30)\`. Con HALF_LIFE = 30, pierde mitad de vitalidad cada 30 días.
- Valor por vecinas: la vitalidad intrínseca de sus vecinas cercanas (coseno > 0.55) la empuja hacia arriba, ponderado por el score.
- Valor final: \`max(intrínseco, max_de_vecinas * score)\`.

**Para una señal huérfana** (sin tema):
- Decae al doble: HALF_LIFE = 15 días. Si nada las acompaña, fueron ruido.

**Para un tema**:
- Suma de vitalidad de sus miembros.
- Si suma < 1.0, el tema pasa a \`dead\` (fósil).

En la UI:
- **Opacidad del nodo**: proporcional a vitalidad.
- **Tamaño del nodo**: número de conexiones (aristas).
- **Nodos bajo 0.15**: se ocultan tras toggle "mostrar fósiles".

Se recalcula en cada corrida. No es un score estático, sino una foto del "ahora mismo".`,
    formula:
      "vitalidad(i) = max(0.5^(días/30), max_j(vitalidad(j) * score(i,j))) | tema: sum(miembros)",
    constants: [
      {
        name: "HALF_LIFE_DAYS",
        value: "30",
        source: "GRAPH_HALF_LIFE_DAYS env (src/lib/jobs/graph.ts)",
      },
      {
        name: "ORPHAN_HALF_LIFE_DAYS",
        value: "15 (mitad de 30)",
        source: "HALF_LIFE_DAYS / 2 (src/lib/jobs/graph.ts)",
      },
      {
        name: "Umbral de muerte",
        value: "< 1.0",
        source: "DEAD_THRESHOLD (src/lib/jobs/graph.ts)",
      },
    ],
    related: ["senal", "tema", "fosil", "huerfana", "decaimiento"],
  },

  huerfana: {
    key: "huerfana",
    term: "Señal huérfana",
    short:
      "Una señal publicada que no pertenece a ningún tema porque está sola o la comunidad de la que forma parte es muy pequeña (< 3 miembros).",
    long: `Una **señal huérfana** es una que no tiene tema asignado (\`clusterId = null\`).
Sucede cuando:
- Ningún vecino semántico tiene coseno > 0.55.
- Sus vecinos forman un grupo < 3 señales (por debajo de MIN_CLUSTER_SIZE).

Las huérfanas **decaen al doble de velocidad** que las temas porque se supone que si nadie las acompaña, fueron ruido.
HALF_LIFE = 15 días en vez de 30.

En el grafo se renderizan en gris, sin color de tema. En la serie temporal (snapshots) se cuentan por separado (\`orphans\`).

Una huérfana puede cobrar vida si más tarde llegan señales semánticamente cercanas y la siguiente corrida detecta una comunidad.
Entonces se empareja (si Jaccard ≥ 0.3) o forma tema nuevo.`,
    constants: [
      {
        name: "ORPHAN_HALF_LIFE_DAYS",
        value: "15",
        source: "HALF_LIFE_DAYS / 2 (src/lib/jobs/graph.ts)",
      },
      {
        name: "Tamaño mínimo de comunidad",
        value: "3",
        source: "MIN_CLUSTER_SIZE (src/lib/jobs/clusters.ts)",
      },
    ],
    related: ["senal", "tema", "vitalidad", "embeddingsingularidad"],
  },

  H1: {
    key: "H1",
    term: "Horizonte 1 (H1 · ya está pasando)",
    short: "Tendencia consolidada: grande, viva y cerca del centro del mapa. Lo que dominará en los próximos meses.",
    long: `**H1** es la categoría de temas que ya están pasando: tendencias consolidadas.

**Heurística automática** (en \`suggestHorizons\`):
- H1 si: size ≥ 8 AND vitalidad ≥ 3 AND novedad ≤ mediana.

**Interpretación**:
- **Size ≥ 8**: es un tema gordo, muchas señales.
- **Vitalidad ≥ 3**: el tema está vivo y activo.
- **Novedad ≤ mediana**: no es lejano ni exótico; está en el centro del mapa. Las señales que lo componen son cercanas al centroide global.

**En la UI**: "Tendencia consolidada: grande, viva y cerca del centro del mapa."

**Administración**: Frida puede fijar un tema manualmente a H1 (\`horizonSource = 'manual'\`),
y entonces la corrida automática **no lo pisa** (respeta la decisión manual).`,
    constants: [
      {
        name: "Size mínimo",
        value: "≥ 8",
        source: "suggestHorizons (src/lib/jobs/graph.ts)",
      },
      {
        name: "Vitalidad mínima",
        value: "≥ 3",
        source: "suggestHorizons (src/lib/jobs/graph.ts)",
      },
      {
        name: "Novedad máxima",
        value: "≤ mediana",
        source: "suggestHorizons (src/lib/jobs/graph.ts)",
      },
    ],
    related: ["horizonte", "H2", "H3", "velocidad", "novedad"],
  },

  H2: {
    key: "H2",
    term: "Horizonte 2 (H2 · en transición)",
    short: "Tema que crece y conecta con otros; todavía no domina. Señales de maduración.",
    long: `**H2** es la categoría de temas en transición: señales que están ganando tracción pero no dominan todavía.

**Heurística automática** (en \`suggestHorizons\`):
- H2 si: NOT(H1 criteria) AND NOT(H3 criteria).
Es decir, el "resto": temas medianos, moderadamente vivos, con novedad media.

**Interpretación**:
- Están **creciendo**: velocidad positiva, miembros nuevos.
- **Conectan** con otros temas (bridgeClusters > 0).
- **Novedad moderada**: ni exóticas (H3) ni centrales (H1).

**En la UI**: "Tema que crece y conecta con otros; todavía no domina."

Es la zona de transición donde se observa cuál tenderá a H1 y cuál desaparecerá.`,
    related: ["horizonte", "H1", "H3", "velocidad", "conectividad"],
  },

  H3: {
    key: "H3",
    term: "Horizonte 3 (H3 · señal débil)",
    short: "Chico, lejano o con poca vitalidad. Hipótesis a vigilar; alto riesgo de desaparecer.",
    long: `**H3** es la categoría de señales débiles: hipótesis emergentes que pueden no llegar a nada.

**Heurística automática** (en \`suggestHorizons\`):
- H3 si: size < 5 OR vitalidad < 1.5 OR novedad > p75.

**Interpretación**:
- **Chico**: menos de 5 miembros, aún sin masa crítica.
- **Débil**: vitalidad bajo 1.5, poco refresco de señales.
- **Lejano**: distancia del centroide global está en percentil 75+; es exótico, no central.

**En la UI**: "Chico, lejano o con poca vitalidad: hipótesis a vigilar."

Son temas para **monitorear**, no para acción inmediata.
Si no reclutan más señales, caerán a \`dead\` (fósiles). Si reclutan, migran a H2 o H1.`,
    constants: [
      {
        name: "Size máximo",
        value: "< 5",
        source: "suggestHorizons (src/lib/jobs/graph.ts)",
      },
      {
        name: "Vitalidad máxima",
        value: "< 1.5",
        source: "suggestHorizons (src/lib/jobs/graph.ts)",
      },
      {
        name: "Novedad mínima",
        value: "> p75",
        source: "suggestHorizons (src/lib/jobs/graph.ts)",
      },
    ],
    related: ["horizonte", "H1", "H2", "vitalidad", "novedad"],
  },

  horizonte: {
    key: "horizonte",
    term: "Horizonte",
    short: "Una clasificación (H1/H2/H3) que sitúa un tema en el ciclo de maduración: consolidado, en transición, o señal débil.",
    long: `Un **horizonte** es una clasificación que responde a la pregunta: "¿dónde está este tema en su ciclo?"

Son tres:
- **H1 · ya está pasando**: tendencia consolidada (grande, viva, central).
- **H2 · en transición**: tema en crecimiento, conecta otros (mediano, moderado).
- **H3 · señal débil**: hipótesis a vigilar (chico, lejano o débil).

**Generación automática** (cada corrida, en \`suggestHorizons\`):
La corrida propone H1/H2/H3 basado en indicadores: size, vitalidad, novedad.
Frida puede fijar un tema manualmente a un horizonte (\`horizonSource = 'manual'\`),
y entonces la corrida respeta esa decisión (no lo pisa).

**En la API y la UI**:
- Cada respuesta de tema incluye \`horizon\` (null si no asignado) y \`horizonSuggested\` (la propuesta automática).
- Se muestra la etiqueta corta y larga de HORIZON_LABELS: "H2 · en transición".
- En /horizones se agrupan todos los temas vivos de cada horizonte (máximo 5 macro-temas por horizonte).

**Estadística**: los tres horizontes junto dan una foto de la madurez del acervo.
Es **la herramienta principal para responder "¿en qué etapa estamos?"**.`,
    constants: [
      {
        name: "Máximo de macro-temas por horizonte",
        value: "5",
        source: "MAX_MACRO_PER_HORIZON (src/lib/jobs/graph.ts)",
      },
    ],
    related: ["H1", "H2", "H3", "tema", "velocidad", "novedad", "macrotheme"],
  },

  velocidad: {
    key: "velocidad",
    term: "Velocidad",
    short: "Tasa de cambio del tema: cuántas señales nuevas llegan en los últimos 30 días vs. los 30 anteriores.",
    long: `La **velocidad** de un tema es su tasa de cambio: señales que entra en los últimos 30 días dividido por las de los 30 días anteriores.

**Fórmula**:
- \`velocity30d\` = número de miembros con \`likedAt\` en últimos 30 días.
- \`velocityPrev30d\` = número de miembros con \`likedAt\` entre hace 60 y hace 30 días.
- \`velocityDelta\` = velocity30d - velocityPrev30d (derivado; que no reste el agente).

**Interpretación**:
- **Delta > 0**: tema está **acelerando**, gana traction.
- **Delta ≈ 0**: tema **estable**, mismo ritmo.
- **Delta < 0**: tema está **desacelerando**, pierde atención.

**En la API**: incluido en los indicadores del tema (\`ThemeDetailDTO.indicators.velocity{30d,Prev30d,Delta}\`).

Es clave para distinguir H1 consolidada (estable) de H2 en crecimiento.`,
    related: ["tema", "horizonte", "indicador"],
  },

  densidad: {
    key: "densidad",
    term: "Densidad",
    short: "Cohesión interna del tema: similitud coseno promedio entre los miembros y el centroide del grupo.",
    long: `La **densidad** de un tema mide cuán cohesionados están sus miembros semánticamente.

**Fórmula**:
- Centroide = promedio de los embeddings de todos los miembros (en Postgres, \`avg(embedding)\`).
- Densidad = similitud coseno promedio entre cada miembro y el centroide.
- Rango: [0, 1]. 1 = todos los miembros son idénticos. 0 = dispersos.

**Interpretación**:
- **Densidad alta** (0.8-1.0): tema muy coherente; miembros muy parecidos.
- **Densidad media** (0.5-0.8): tema coherente pero con variación.
- **Densidad baja** (< 0.5): tema disperso; puede contener subtemas ocultos.

Una densidad baja puede señalar que el clustering detectó un grupo que debería estar en temas separados.
Contraste con novedad para ver si la dispersión es por amplitud (tema paraguas) o por error (temas que deberían escindirse).

**En la API**: \`ThemeDetailDTO.indicators.density\` (puede ser null si no hay embedding).`,
    constants: [
      {
        name: "Rango",
        value: "[0, 1]",
        source: "Similitud coseno normalizada",
      },
    ],
    related: ["tema", "centroide", "novedad", "embeddingsingularidad"],
  },

  conectividad: {
    key: "conectividad",
    term: "Conectividad",
    short:
      "Proporción de aristas del tema que salen hacia otros temas. También: número de temas puente distintos alcanzados.",
    long: `La **conectividad** de un tema responde a: "¿cuánto está enchufado a otros temas?"

Se calcula de dos formas (ambas en \`ThemeDetailDTO.indicators\`):
1. **Proporción de aristas salientes**: (aristas que tocan miembros de otros temas) / (todas las aristas que toca este tema).
   Rango [0, 1]. 1 = todas sus aristas van hacia afuera; 0 = completamente aislado.

2. **Número de temas puente** (\`bridgeThemes\`): cuántos temas distintos son alcanzados en un salto semántico.
   Indica su papel como **nodo de transición** en el grafo.

**Interpretación**:
- **Alta conectividad**: tema que actúa como puente; sus miembros son vecinos de muchos otros temas.
  Señal de que toca multiples frentes del mapa.
- **Baja conectividad**: tema aislado, sin relación semántica clara con otros.

**En la API**: \`connectivity\` (float, puede ser null) y \`bridgeThemes\` (integer).

Tema con alta conectividad y baja densidad = tema que hace puente entre varios subtemas.
Tema con alta conectividad y alta densidad = tema "centro" que impulsiona multiples direcciones.`,
    related: ["tema", "puente", "indicador", "horizonte"],
  },

  novedad: {
    key: "novedad",
    term: "Novedad",
    short: "Distancia del centroide del tema al centroide global del mapa. Mide qué tan lejano/exótico es el tema.",
    long: `La **novedad** de un tema mide su **distancia al centro** del mapa.

**Fórmula**:
- Centroide global = promedio de embeddings de **todas** las señales publicadas.
- Centroide del tema = promedio de embeddings de los miembros del tema.
- Novedad = similitud coseno entre el centroide del tema y el centroide global.
- Rango: [0, 1]. 1 = idéntico al centro (nada nuevo). 0 = antípoda (radicalmente nuevo).

**Interpretación**:
- **Novedad baja** (0.3-0.5): tema radicalmente nuevo, único en el mapa. Potencial futuro.
- **Novedad media** (0.5-0.7): tema moderadamente nuevo, toca un área no central.
- **Novedad alta** (0.7-1.0): tema cerca del centro, temas comunes/populares.

En la heurística de horizonte:
- **H1**: novedad ≤ mediana (central, mainstream).
- **H3**: novedad > p75 (exótico, outlier).

**En la API**: \`ThemeDetailDTO.indicators.novelty\` (puede ser null).

Contrasta con \`density\`: novedad alta + densidad baja = tema que mezcla varias cosas nuevas.
Novedad baja + densidad alta = tema muy coherente pero radical.`,
    constants: [
      {
        name: "Rango",
        value: "[0, 1]",
        source: "Similitud coseno normalizada",
      },
    ],
    related: ["tema", "centroide", "densidad", "horizonte", "H3"],
  },

  puente: {
    key: "puente",
    term: "Tema puente (bridge theme)",
    short: "Un tema que actúa de nexo entre otros temas: alta conectividad, aristas hacia múltiples direcciones.",
    long: `Un **tema puente** es un tema con alta **conectividad**: sus miembros tienen aristas semánticas hacia miembros de muchos otros temas.

Es el tema que "traduce" entre dominios. Ejemplo: un tema sobre "regulación de IA" puede ser puente entre "tecnología" y "política".

**Señales**:
- \`connectivity\` alta (muchas aristas salen del tema hacia afuera).
- \`bridgeThemes\` alto (toca muchos otros temas en un salto).
- Posiblemente \`density\` media-baja (el tema es paraguas, no monolítico).

**En la narrativa**:
- Temas puente son **críticos para entender transiciones**. Si desaparecen, el mapa se fragmenta.
- Son temas "en transición" o "de fusión".

**En la API**: se identifica por su \`connectivity\` y \`bridgeThemes\`.
Frida puede usarlos como puntos de pivote en la narración de escenarios.`,
    related: ["tema", "conectividad", "horizonte", "H2"],
  },

  macrotheme: {
    key: "macrotheme",
    term: "Macro-tema",
    short:
      "Agrupación de segundo nivel: conjuntos de hasta 5 temas vivos por horizonte, para simplificar la lectura del mapa.",
    long: `Un **macro-tema** es una agrupación de segundo nivel: varios temas (H1, H2 o H3) que se agrupan por semejanza semántica.

**Características**:
- Se crean en cada corrida (no tienen linaje, sus ids **no son estables**).
- Máximo 5 por horizonte: si hay más de 5 temas en H1, se agrupan en ≤5 macro-temas.
- Se generan automáticamente agrupando temas por proximidad en el grafo.
- Son read-only, sin historia (a diferencia de temas, que son persistentes).

**En la API**:
- Endpoint \`/macro-themes\` devuelve todos.
- Endpoint \`/horizons/{key}\` incluye los macro-temas de ese horizonte.
- Cada macro-tema lleva: \`id\`, \`name\`, \`summary\`, \`horizon\`, \`themes\` (array de temas membros).

**Advertencia importante**:
No guardes ids de macro-temas. Se recrean cada corrida. Sus ids son opacos y efímeros.
Usa en cambio los ids de temas (que sí son estables) para referencias duraderas.

**Uso**: para el resumen ejecutivo ("3 macro-temas en H1, 7 en H2").
Para análisis profundo, usa temas individuales.`,
    constants: [
      {
        name: "Máximo por horizonte",
        value: "5",
        source: "MAX_MACRO_PER_HORIZON (src/lib/jobs/graph.ts)",
      },
      {
        name: "Linaje",
        value: "Ninguno (se recrean cada corrida)",
        source: "src/lib/jobs/graph.ts: borran y recrean",
      },
    ],
    related: ["tema", "horizonte", "H1", "H2", "H3"],
  },

  snapshot: {
    key: "snapshot",
    term: "Snapshot (foto del grafo)",
    short: "Una captura temporal del estado de todos los temas en un momento. Base de la serie temporal.",
    long: `Un **snapshot** es una foto del grafo en un momento: todos los temas, sus miembros, sus indicadores.

Se crea en cada corrida, con:
- \`id\` único.
- \`takenAt\` (timestamp).
- \`trigger\`: qué causó la corrida (cron, embed, publish, manual).
- \`nodes\`, \`links\`: conteos de señales y aristas en ese momento.
- \`themesAlive\`, \`themesDead\`, \`orphans\`: desglose de estado.
- Tabla \`graph_snapshot_clusters\`: para cada tema, su \`size\`, \`vitality\`, \`velocity30d\`, indicadores.
- Tabla \`graph_snapshot_members\`: membresía de cada tema en ese momento (para linaje).

**Uso**:
- **Serie temporal**: comparar dos snapshots revela cómo creció/murió cada tema.
- **Linaje**: el snapshot anterior es la "verdad" de membresía para emparejar con la nueva comunidad.
- **Auditoría**: ver qué estaba vivo hace 3 meses.

**En la API**:
- Endpoint \`/snapshots\` lista con paginación (por \`takenAt\`).
- Endpoint \`/snapshots/{id}\` trae el desglose completo. Opción \`includeMembers\` expande la membresía (cap: 5000 filas).
- Endpoint \`/themes/{id}/history\` devuelve la serie temporal de un tema solo (más ágil que iterar snapshots).

**Caché**: snapshots por id son inmutables, caché infinita (\`max-age=86400, immutable\`).`,
    constants: [
      {
        name: "Datos preservados",
        value: "takenAt, trigger, nodos, aristas, temesAlive, themesDead, huérfanas, indicadores",
        source:
          "src/app/api/public/v1/snapshots y graph_snapshot* (schema de Prisma)",
      },
    ],
    related: ["tema", "vitalidad", "linaje", "horizonte"],
  },

  pestel: {
    key: "pestel",
    term: "PESTEL",
    short: "Marco de análisis de 6 dimensiones macroeconómicas. Cada señal lleva máximo 2.",
    long: `**PESTEL** es un acrónimo para categorizar las fuerzas que impulsan cambio:
- **P**olitical: leyes, regulaciones, gobiernos.
- **E**conomic: mercados, dinero, inflación.
- **S**ocial: cultura, demografía, valores.
- **T**echnological: tecnología, innovación, estándares.
- **E**nvironmental / Ambiental: clima, recursos, sostenibilidad.
- **L**egal: derechos, contratos, litigios.

Cada dimensión lleva una **letra** (Political=P, Economic=E, Social=S, Technological=T, Environmental=E, Legal=L).

**Clave en la DB**: las claves son inglesas lowercase sin espacios. Ejemplo: \`political\`, \`economic\`, \`social\`, \`technological\`, \`environmental\`, \`legal\`.

**En la API**:
- Endpoint \`/pestel\` devuelve el catálogo con letra, etiqueta en español, conteo.
- En cada señal: campo \`pestel\` es un array de hasta 2 claves. Ejemplo: \`["technological", "legal"]\`.

**Regla de análisis**: cada señal lleva **máximo 2 dimensiones PESTEL**.
Si toca más de 2, el analista elige las 2 más relevantes. Esto agiliza el análisis y concentra la categorización.

**En la UI**: checkboxes de 6 opciones, multiselect (pero el análisis respeta el tope de 2).`,
    constants: [
      {
        name: "Dimensiones",
        value: "Political, Economic, Social, Technological, Environmental, Legal",
        source: "PESTEL_DIMENSIONS (src/config/pestel.ts)",
      },
      {
        name: "Máximo por señal",
        value: "2",
        source: "Regla de análisis (src/lib/analysis-prompts.ts)",
      },
    ],
    related: ["senal", "categoria", "categorización"],
  },

  categoria: {
    key: "categoria",
    term: "Categoría",
    short: "Clasificación temática manual del contenido: opciones fijas curadas (IA, Biología, etc.) o propuestas del modelo.",
    long: `Una **categoría** es una etiqueta temática que clasifica el contenido de una señal.

**Origen**:
- **Catálogo curado**: categorías editables vía \`/categorias\` (admin-only). Viven en la tabla \`categories\`.
  Ejemplo: "Inteligencia Artificial", "Biología", "Política".
- **Propuestas del modelo**: el análisis automático (Claude + Ollama) propone categorías nuevas.
  Inicialmente \`inCatalog: false\`; Frida puede promoverlas al catálogo manual.

**Atributos** (en DTO \`CategoryDTO\`):
- \`name\`: nombre de la categoría.
- \`inCatalog\`: si es parte del catálogo curado (true) o una propuesta (false).
- \`signalCount\`: cuántas señales la usan.
- \`examples\`: ejemplos de señales.

**Edición**:
- En \`/categorias\`, Frida puede crear, editar, eliminar, reordenar (drag-drop).
- Endpoint \`POST /api/categories/recategorize\` (admin-only) relimpia categorías automáticas de un rango temporal,
  respetando \`*Source = 'manual'\` (no toca lo que Frida fijó a mano).

**En la API**:
- Endpoint \`/categories\` devuelve el catálogo completo (curado + propuestas).
- Cada señal lleva \`category\` (string) o \`null\` (sin asignar) + \`categoryConfidence\` (0-1).`,
    related: ["senal", "pestel", "analyze"],
  },

  embedding: {
    key: "embedding",
    term: "Embedding / Similitud semántica",
    short: "Vector denso (768 dims) que captura el significado de una señal. Usamos coseno para hallar vecinos semánticos.",
    long: `Un **embedding** es una representación numérica del significado de un texto.

**Generación** (local):
- Texto de entrada: \`contentTitle || tldr || tweetText\` (en ese orden de prioridad).
- Modelo: Ollama local, \`embeddinggemma\` (768 dimensiones).
- Se calcula un hash del modelo + texto. Si el texto o el modelo cambia, se recalcula.
- Se guarda en la DB como tipo \`vector(768)\` (pgvector).

**Similitud semántica**:
- Medida: **similitud coseno** entre dos vectores. Rango: [0, 1], donde 1 = idénticos, 0 = ortogonales.
- Umbral de arista: ≥ 0.55 (SEMANTIC_LINK_THRESHOLD).
- Aristas: para cada señal, los \`SEMANTIC_LINK_TOP_K = 8\` vecinos más cercanos (si score ≥ 0.55).

**Temas y grafo**:
- El grafo de aristas (similitud coseno) es la base para detectar comunidades.
- Centroide de tema = promedio de embeddings de sus miembros.
- Densidad = similitud coseno promedio al centroide.
- Novedad = distancia del centroide del tema al centroide global.

**Nunca se devuelve**:
- El vector crudo en la API (\`embedding\` NO está en \`select\` de ningún query).
- El % de similitud para humanos (por decisión de producto: 0.65 se lee como falsa precisión).
- El score sí se devuelve para razonamiento de agentes (\`score\` en DTO), con etiqueta \`strength\` (fuerte/media/débil).

**En la UI**:
- Espesor de la arista visual = fuerza de la similitud.
- Orden de "vecinos más cercanos" en el panel lateral (sin porcentaje mostrado).`,
    constants: [
      {
        name: "Dimensionalidad",
        value: "768",
        source: "embeddinggemma (Ollama local)",
      },
      {
        name: "Umbral de arista",
        value: "≥ 0.55 (coseno)",
        source: "SEMANTIC_LINK_THRESHOLD (src/lib/jobs/graph.ts)",
      },
      {
        name: "Top-K por señal",
        value: "8",
        source: "SEMANTIC_LINK_TOP_K (src/lib/jobs/embed.ts)",
      },
    ],
    related: ["tema", "grafo", "densidad", "novedad", "puente"],
  },

  likedAt: {
    key: "likedAt",
    term: "likedAt (fecha estimada del like)",
    short:
      "La fecha en que se hizo el like. **Siempre es una estimación**, no un dato exacto. Se muestra con `~` (virgulilla).",
    long: `La **\`likedAt\`** es la fecha estimada en que Frida puso un like a una publicación de X.

**¿Por qué estimada?**
La X API no expone cuándo se hace un like. Frida descargó el historial con una herramienta tercera,
que solo sabe cuándo detectó el like en un polling, no cuándo ocurrió realmente.

**Tres fechas distintas en cada señal** (\`liked_items\`):
1. **\`tweetCreatedAt\`**: exacta (del snowflake del tweet). Cuándo se publicó el contenido.
2. **\`detectedAt\`**: exacta (del polling). Cuándo la herramienta lo detectó.
3. **\`likedAt\`**: estimada. Acotada entre dos corridas de polling consecutivas.

En esta columna, Frida ve \`detectedAt\`. En \`likedAt\`, el valor se estima como la fecha intermedia o se guarda explícitamente (si el usuario lo fija manualmente).

**En la API y la UI**:
- \`likedAt\` siempre se **muestra con una virgulilla**: \`~ 25 ago 2026\`, **nunca sin ella**.
- El DTO declara \`likedAtEstimated: true\` (literal siempre verdadero).
- El DTO también trae \`likedAtSource\`: \`"tweet_date"\` (si se usó el snowflake) o \`"ordered"\` (si se estimó por orden de polling).

**Implicación para agentes**:
- Nunca digas "fue likado exactamente el 25 de agosto". Di "fue likado aprox. el 25 de agosto" o "alrededor del 25".
- Si necesitas precisión, usa \`tweetCreatedAt\` (exacto) o \`detectedAt\` (exacto del polling).
- En narrativas, la imprecisión es una característica, no un error: "las señales de agosto (~)" es correcto.`,
    constants: [
      {
        name: "Representación visual",
        value: "~ fecha",
        source: "Regla de formato (docs/TOOLS.md, docs/DOMAIN.md)",
      },
      {
        name: "likedAtEstimated",
        value: "true (siempre)",
        source: "SignalDTO (src/lib/public-dto.ts)",
      },
    ],
    related: ["senal", "tweetCreatedAt", "detectedAt"],
  },

  decaimiento: {
    key: "decaimiento",
    term: "Decaimiento de vitalidad",
    short: "El proceso exponencial por el cual las señales pierden vitalidad con el tiempo si no hay continuidad.",
    long: `El **decaimiento** es el mecanismo que hace que las señales antiguas pierdan relevancia.

**Fórmula**: vitalidad intrínseca = \`0.5^(días desde el like / HALF_LIFE)\`
- Con HALF_LIFE = 30 días, una señal pierde el 50% de su vitalidad cada mes.
- Tras 30 días: 0.5.
- Tras 60 días: 0.25.
- Tras 90 días: 0.125.

**Reanimación**: una señal antigua puede recuperar vitalidad si una vecina reciente la empuja (reanimación por contagio).

**Huérfanas**: decaen al doble (HALF_LIFE = 15 días). Si nada llega a acompañarlas, se apagan rápido.

**Muerte de tema**: si la suma de vitalidad de los miembros cae bajo 1.0, el tema muere (pasa a \`dead\`/fósil).

**Propósito**: es el "olvido" natural del sistema. Lo que fue novedoso hace un año pierde importancia a menos que algo nuevo lo reactive.
Sin decaimiento, el mapa acumularía ruido histórico.`,
    constants: [
      {
        name: "HALF_LIFE_DAYS",
        value: "30 días",
        source: "GRAPH_HALF_LIFE_DAYS env",
      },
      {
        name: "ORPHAN_HALF_LIFE_DAYS",
        value: "15 días",
        source: "HALF_LIFE_DAYS / 2",
      },
    ],
    related: ["vitalidad", "senal", "huerfana", "fosil"],
  },

  centroide: {
    key: "centroide",
    term: "Centroide",
    short: "El promedio de embeddings de un conjunto de señales. Define el \"centro\" semántico del tema o del mapa.",
    long: `Un **centroide** es el promedio de los vectores de embedding de un conjunto de señales.

**Usos**:
1. **Centroide del tema**: promedio de embeddings de los miembros del tema.
   - Se usa para calcular \`densidad\` (similitud de miembros al centroide).
   - Se usa para calcular \`novedad\` (distancia del centroide del tema al centroide global).

2. **Centroide global**: promedio de embeddings de **todas las señales publicadas**.
   - Es el "centro de gravedad" del mapa completo.
   - Punto de referencia para medir cuán lejano es cada tema.

**Cálculo**: en Postgres, \`avg(embedding)\` sobre un subconjunto (tema o global).

**Interpretación semántica**:
- Si todos los miembros de un tema tienen embeddings similares, el centroide está "en medio" (densidad alta).
- Si los miembros están dispersos, el centroide puede ser una región vacía del espacio semántico (densidad baja, tema disperso).

**No se expone**: el vector centroide no se devuelve en la API. Solo los indicadores (densidad, novedad) que lo usan.`,
    related: ["embedding", "densidad", "novedad", "tema"],
  },

  indicador: {
    key: "indicador",
    term: "Indicador",
    short: "Métrica cuantitativa que describe la salud o el estado de un tema: velocidad, densidad, conectividad, novedad.",
    long: `Un **indicador** es una métrica numérica que ayuda a entender el estado de un tema.

**Los cuatro indicadores principales** (en \`ThemeDetailDTO.indicators\`):
1. **Velocidad**: señales nuevas en 30d vs. 30d previos (\`velocity30d\`, \`velocityPrev30d\`, \`velocityDelta\`).
2. **Densidad**: cohesión semántica de miembros al centroide.
3. **Conectividad**: proporción de aristas que salen hacia otros temas.
4. **Novedad**: distancia del centroide del tema al centroide global.

Plus:
5. **Vitalidad**: suma de vitalidad de miembros.
6. **Tamaño**: número de miembros.
7. **Bridge themes**: número de temas distintos tocados.

**Lectura integrada**:
- Alta velocidad + baja densidad = tema que está creciendo pero absorbiendo miembros distintos.
- Alta conectividad + alta densidad = tema centro que cohesiona multiples direcciones.
- Baja velocidad + novedad baja = tema estable pero exótico (niche).
- Baja velocidad + novedad alta + densidad baja = tema en decaimiento, dispersándose.

**En la API**: siempre en formato \`float | null\` (densidad, conectividad, novedad pueden ser null si falta data).`,
    related: ["tema", "velocidad", "densidad", "conectividad", "novedad"],
  },
};

/** Claves del glosario, en orden de definición. */
export const GLOSSARY_KEYS: readonly string[] = Object.keys(GLOSSARY);

/** Busca un término por clave exacta, o por sinónimo/alias con tolerancia a acentos y mayúsculas. */
export function lookupTerm(term: string): GlossaryEntry | null {
  const normalized = term
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // quita acentos
    .replace(/\s+/g, ""); // quita espacios

  // Primero, búsqueda exacta por clave.
  if (GLOSSARY[term]) return GLOSSARY[term];

  // Luego, búsqueda tolerante en claves.
  for (const entry of Object.values(GLOSSARY)) {
    const key = entry.key
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/\s+/g, "");
    if (key === normalized) return entry;
  }

  // Búsqueda en términos (term).
  for (const entry of Object.values(GLOSSARY)) {
    const t = entry.term
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/\s+/g, "");
    if (t === normalized) return entry;
  }

  return null;
}

/** Genera el markdown del glosario a partir de las entradas. */
export function renderGlossaryMarkdown(): string {
  const lines: string[] = [];

  lines.push("# Glosario del dominio de foresight");
  lines.push("");
  lines.push(
    "Cada término es una puerta al método. Léelo para no equivocarte al hablar del mapa."
  );
  lines.push("");

  for (const entry of Object.values(GLOSSARY)) {
    lines.push(`## ${entry.term}`);
    lines.push("");
    lines.push(`> ${entry.short}`);
    lines.push("");
    lines.push(entry.long);
    lines.push("");

    if (entry.formula) {
      lines.push("**Fórmula:**");
      lines.push(`\`\`\`\n${entry.formula}\n\`\`\``);
      lines.push("");
    }

    if (entry.constants && entry.constants.length > 0) {
      lines.push("**Constantes reales:**");
      for (const c of entry.constants) {
        lines.push(`- **${c.name}**: \`${c.value}\` (${c.source})`);
      }
      lines.push("");
    }

    if (entry.related.length > 0) {
      const refs = entry.related.map((k) => {
        const target = GLOSSARY[k];
        return target ? `[${target.term}](#${slugifyMarkdown(target.term)})` : k;
      });
      lines.push(`**Relacionado:** ${refs.join(", ")}`);
      lines.push("");
    }
  }

  lines.push("---");
  lines.push(`*Generado desde \`src/domain/glossary.ts\` en \`${new Date().toISOString()}\`*`);

  return lines.join("\n");
}

/** Convierte un título de markdown en un anchor válido. */
function slugifyMarkdown(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // quita acentos
    .replace(/[^\w\s-]/g, "") // quita caracteres especiales
    .replace(/\s+/g, "-"); // espacios a guiones
}
