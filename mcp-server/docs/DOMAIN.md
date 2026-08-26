# Glosario del dominio de foresight

Cada término es una puerta al método. Léelo para no equivocarte al hablar del mapa.

## Señal

> Una pieza de contenido curada: un tweet, un artículo o un enlace que indica un indicio de futuro.

Una **señal** es el acto de guardar como "me gusta" en X una publicación que importa.
Es la unidad más pequeña del mapa: contenido sobre el que alguien ha puesto atención.
Cada señal lleva:
- **Texto**: el tuit original, el título del artículo, la URL del link.
- **Fecha**: `tweetCreatedAt` (exacta, del snowflake), `likedAt` (estimada), `detectedAt` (exacta, del polling).
- **Análisis**: TL;DR, por qué importa, impacto en la IA y la interacción humana.
- **Clasificación**: categoría, dimensiones PESTEL.
- **Membresía**: pertenencia a un **tema** (si se detectó) o condición de huérfana.
- **Vitalidad**: número que decae con el tiempo; se reanima si vecinas recientes la empujan.

No se borran nunca. Se publican o despublican; si se despublica, desaparece del grafo en la siguiente corrida.

**Fórmula:**
```
Señal = cualquier item guardado en tu banco. `publishStatus = 'published'` marca el subconjunto ya curado, que es el único que entra al grafo, a los temas y a los horizontes.
```

**Constantes reales:**
- **Máximo PESTEL por señal**: `2` (Regla del prompt de análisis: cada señal lleva máximo 2 dimensiones.)

**Relacionado:** [Tema (cluster semántico)](#tema-cluster-semantico), [Vitalidad](#vitalidad), [likedAt (fecha estimada del like)](#likedat-fecha-estimada-del-like), [Señal huérfana](#senal-huerfana), [PESTEL](#pestel)

## Tema (cluster semántico)

> Un linaje persistente de señales relacionadas semánticamente, con historia e identidad estable.

Un **tema** es un grupo de señales que comparten significado semántico.
Se detecta cada corrida usando propagación de etiquetas sobre el grafo de similitud (aristas de coseno > 0.55).

**Linaje**: el tema mantiene su identidad entre corridas. Si una nueva comunidad detectada tiene Jaccard ≥ 0.3 con la membresía anterior de un tema, se empareja.
Sin pareja, nace un tema nuevo. El id se conserva, así que una señal publicada hace meses puede entrar en el tema meses después.

**Historia**: cada tema preserva:
- Snapshots de su membresía a través del tiempo (para trazar cuando nació, creció, encorvó).
- Indicadores: velocidad (en últimos 30 días vs. 30 anteriores), densidad, conectividad, novedad, numero de temas puente.
- Horizonte sugerido (H1/H2/H3) o fijado manualmente.

**Muerte y resurrección**: un tema pasa a `status: 'dead'` (fósil) por **dos** caminos distintos, no solo uno:
1. **Por vitalidad**: emparejó linaje esta corrida, pero la suma de vitalidad de sus miembros cayó bajo 1.0.
2. **Por linaje**: ninguna comunidad de esta corrida alcanzó Jaccard ≥ 0.3 con su última membresía, así que el linaje no reapareció.
   Muere **con la vitalidad que tuviera** — puede ser altísima. Casi siempre significa que el tema se fragmentó o se fundió con otro,
   no que se apagara.
No se borra en ninguno de los dos casos. Si luego entran señales nuevas con vitalidad ≥ 1.0 que emparejan por linaje, resucita
automáticamente (vuelve a `status: 'alive'`).

**Constantes reales:**
- **Tamaño mínimo para ser tema**: `3 señales` (MIN_CLUSTER_SIZE, constante de la detección de comunidades)
- **Umbral de linaje (Jaccard)**: `≥ 0.3` (LINEAGE_JACCARD, umbral de emparejamiento del job de grafo)
- **Umbral de muerte**: `< 1.0 de vitalidad` (DEAD_THRESHOLD, umbral de muerte del modelo de vitalidad)

**Relacionado:** [Linaje](#linaje), [Fósil (tema muerto)](#fosil-tema-muerto), resurrección, [Vitalidad](#vitalidad), [Snapshot (foto del grafo)](#snapshot-foto-del-grafo), [Horizonte](#horizonte)

## Linaje

> La identidad persistente de un tema entre corridas, emparejado por similitud de membresía.

El **linaje** es lo que hace que un tema sea `el mismo tema` a lo largo del tiempo, aunque sus miembros cambien.

En cada corrida de grafo, se detectan nuevas comunidades. Cada comunidad se empareja con el tema existente cuya membresía anterior tenga mayor **Jaccard** (solapamiento).
- Si Jaccard ≥ 0.3: se emparejan. El tema nuevo preserva el `id` antiguo, ganando historial.
- Si Jaccard < 0.3: sin pareja. El tema viejo pasa a fósil **sin que su vitalidad tenga voz ni voto**, y la comunidad nueva
  nace como tema con `id` nuevo. Es la razón de que existan fósiles con vitalidad alta: el linaje se rompió, las señales no.

Así, una señal publicada hace 6 meses puede entrar en su tema original la próxima corrida porque el tema "lo espera" con su id.
Es la columna vertebral de la trazabilidad temporal.

**Fórmula:**
```
Jaccard(membros_nuevos, membros_viejos) = |intersección| / |unión|
```

**Constantes reales:**
- **Umbral de emparejamiento**: `Jaccard ≥ 0.3` (LINEAGE_JACCARD, umbral de emparejamiento del job de grafo)

**Relacionado:** [Tema (cluster semántico)](#tema-cluster-semantico), [Fósil (tema muerto)](#fosil-tema-muerto), resurrección, [Snapshot (foto del grafo)](#snapshot-foto-del-grafo)

## Fósil (tema muerto)

> Un tema que pasó a estado 'dead' —por apagarse o por perder su linaje— y se preserva íntegro. No es un borrado.

Un **fósil** es un tema que murió y se conserva. Se llega ahí por **dos** caminos, y confundirlos lleva a leer mal el mapa:

1. **Muerte por vitalidad**: la vitalidad total del tema (suma de la de sus miembros) cayó bajo 1.0. Es el tema que se apagó.
2. **Muerte por linaje**: en la última corrida ninguna comunidad detectada alcanzó Jaccard ≥ 0.3 con su última membresía, así que
   el linaje no reapareció y el tema pasa a `dead` **sin mirar su vitalidad**. Por eso existen fósiles con vitalidad de 40 o más:
   no murieron de olvido. Sus señales siguen ahí y siguen vivas; lo que se rompió es la continuidad del grupo — típicamente porque
   el tema se fragmentó en varios o se fundió con otro, que sigue vivo con id propio.

La vitalidad que se muestra de un fósil **no está congelada**: cada corrida la recalcula sumando la vitalidad actual de
`lastMemberIds`, así que sigue decayendo. Un fósil con vitalidad alta es material vivo en un linaje roto, y merece que lo digas
así al narrarlo.

Un fósil se oculta en la UI por defecto (toggle "mostrar fósiles").

**OJO**: un fósil **no es un tema borrado**. La fila sigue en la DB, con su id, sus miembros guardados en `lastMemberIds`, su historia en snapshots.
Es un archivo, no una desaparición.

**Resurrección**: si una nueva señal entra con vitalidad ≥ 1.0 y se empareja por linaje con el fósil, el fósil resucita automáticamente.
Se cuenta el ciclo en `revivedCount`.

Lo deciden el decaimiento de vitalidad y el emparejamiento de linaje, nunca un borrado manual ni un filtrado arbitrario.
Es reversible.

**Constantes reales:**
- **Vitalidad para morir**: `< 1.0` (DEAD_THRESHOLD, umbral de muerte del modelo de vitalidad)
- **Segunda vía de muerte**: `Jaccard < 0.3 con la membresía anterior (sea cual sea la vitalidad)` (LINEAGE_JACCARD, umbral de emparejamiento del job de grafo)

**Relacionado:** [Tema (cluster semántico)](#tema-cluster-semantico), [Vitalidad](#vitalidad), resurrección, [Linaje](#linaje)

## Resurrección

> La vuelta a vida de un fósil cuando llega una nueva señal con vitalidad suficiente que se empareja por linaje.

Una **resurrección** es cuando un tema fósil (dead) vuelve a `status: 'alive'`.
Sucede automáticamente en cada corrida de grafo:
1. Se detecta una nueva comunidad (grafo actual).
2. Se empareja con un tema existente por linaje (Jaccard).
3. Si el tema existente está dead pero la nueva comunidad suma ≥ 1.0 de vitalidad, resucita.

El contador `revivedCount` registra cuántas veces ha pasado. No requiere intervención manual.
Muestra que un tema que estaba dormido vuelve a ser relevante.

**Constantes reales:**
- **Contador**: `revivedCount (integer)` (contador persistido en el propio tema)

**Relacionado:** [Fósil (tema muerto)](#fosil-tema-muerto), [Tema (cluster semántico)](#tema-cluster-semantico), [Vitalidad](#vitalidad), [Linaje](#linaje)

## Vitalidad

> Un número [0, ∞) que mide cuánta atención tiene una señal o tema. Decae exponencialmente con el tiempo; se reanima por cercanía semántica reciente.

La **vitalidad** es lo que diferencia una señal viva de una dormida (o muerta, si está bajo 1.0).

**Para una señal**:
- Valor intrínseco: `0.5^(días desde el like / 30)`. Con HALF_LIFE = 30, pierde mitad de vitalidad cada 30 días.
- Valor por vecinas: la vitalidad intrínseca de sus vecinas cercanas (coseno > 0.55) la empuja hacia arriba, ponderado por el score.
- Valor final: `max(intrínseco, max_de_vecinas * score)`.

**Para una señal huérfana** (sin tema):
- Decae al doble: HALF_LIFE = 15 días. Si nada las acompaña, fueron ruido.

**Para un tema**:
- Suma de vitalidad de sus miembros.
- Si suma < 1.0, el tema pasa a `dead` (fósil).
- **Al revés no vale**: vitalidad alta NO garantiza que el tema esté vivo. Un tema cuyo linaje no empareja en una corrida
  (Jaccard < 0.3) pasa a fósil con la vitalidad que tenga. Lee siempre `status` junto al número, nunca el número solo.

En la UI:
- **Opacidad del nodo**: proporcional a vitalidad.
- **Tamaño del nodo**: número de conexiones (aristas).
- **Nodos bajo 0.15**: se ocultan tras toggle "mostrar fósiles".

Se recalcula en cada corrida. No es un score estático, sino una foto del "ahora mismo".

**Fórmula:**
```
vitalidad(i) = max(0.5^(días/30), max_j(vitalidad(j) * score(i,j))) | tema: sum(miembros)
```

**Constantes reales:**
- **HALF_LIFE_DAYS**: `30` (HALF_LIFE_DAYS, vida media configurable del job de grafo)
- **ORPHAN_HALF_LIFE_DAYS**: `15 (mitad de 30)` (derivada: la mitad de HALF_LIFE_DAYS)
- **Umbral de muerte**: `< 1.0` (DEAD_THRESHOLD, umbral de muerte del modelo de vitalidad)

**Relacionado:** [Señal](#senal), [Tema (cluster semántico)](#tema-cluster-semantico), [Fósil (tema muerto)](#fosil-tema-muerto), [Señal huérfana](#senal-huerfana), [Decaimiento de vitalidad](#decaimiento-de-vitalidad)

## Señal huérfana

> Una señal publicada que no pertenece a ningún tema porque está sola o la comunidad de la que forma parte es muy pequeña (< 3 miembros).

Una **señal huérfana** es una que no tiene tema asignado (`clusterId = null`).
Sucede cuando:
- Ningún vecino semántico tiene coseno > 0.55.
- Sus vecinos forman un grupo < 3 señales (por debajo de MIN_CLUSTER_SIZE).

Las huérfanas **decaen al doble de velocidad** que las temas porque se supone que si nadie las acompaña, fueron ruido.
HALF_LIFE = 15 días en vez de 30.

En el grafo se renderizan en gris, sin color de tema. En la serie temporal (snapshots) se cuentan por separado (`orphans`).

Una huérfana puede cobrar vida si más tarde llegan señales semánticamente cercanas y la siguiente corrida detecta una comunidad.
Entonces se empareja (si Jaccard ≥ 0.3) o forma tema nuevo.

**Constantes reales:**
- **ORPHAN_HALF_LIFE_DAYS**: `15` (derivada: la mitad de HALF_LIFE_DAYS)
- **Tamaño mínimo de comunidad**: `3` (MIN_CLUSTER_SIZE, constante de la detección de comunidades)

**Relacionado:** [Señal](#senal), [Tema (cluster semántico)](#tema-cluster-semantico), [Vitalidad](#vitalidad), embeddingsingularidad

## Horizonte 1 (H1 · ya está pasando)

> Tendencia consolidada: grande, viva y cerca del centro del mapa. Lo que dominará en los próximos meses.

**H1** es la categoría de temas que ya están pasando: tendencias consolidadas.

**Heurística automática** (en `suggestHorizons`):
- H1 si: size ≥ 8 AND vitalidad ≥ 3 AND novedad ≤ mediana.

**Interpretación**:
- **Size ≥ 8**: es un tema gordo, muchas señales.
- **Vitalidad ≥ 3**: el tema está vivo y activo.
- **Novedad ≤ mediana**: no es lejano ni exótico; está en el centro del mapa. Las señales que lo componen son cercanas al centroide global.

**En la UI**: "Tendencia consolidada: grande, viva y cerca del centro del mapa."

**Decisión manual**: puedes fijar un tema a H1 desde la app (`horizonSource = 'manual'`),
y entonces la corrida automática **no lo pisa** (respeta lo que fijaste a mano).

**Constantes reales:**
- **Size mínimo**: `≥ 8` (heurística de horizontes del job de grafo)
- **Vitalidad mínima**: `≥ 3` (heurística de horizontes del job de grafo)
- **Novedad máxima**: `≤ mediana` (heurística de horizontes del job de grafo)

**Relacionado:** [Horizonte](#horizonte), [Horizonte 2 (H2 · en transición)](#horizonte-2-h2-en-transicion), [Horizonte 3 (H3 · señal débil)](#horizonte-3-h3-senal-debil), [Velocidad](#velocidad), [Novedad](#novedad)

## Horizonte 2 (H2 · en transición)

> Tema que crece y conecta con otros; todavía no domina. Señales de maduración.

**H2** es la categoría de temas en transición: señales que están ganando tracción pero no dominan todavía.

**Heurística automática** (en `suggestHorizons`):
- H2 si: NOT(H1 criteria) AND NOT(H3 criteria).
Es decir, el "resto": temas medianos, moderadamente vivos, con novedad media.

**Interpretación**:
- Están **creciendo**: velocidad positiva, miembros nuevos.
- **Conectan** con otros temas (bridgeClusters > 0).
- **Novedad moderada**: ni exóticas (H3) ni centrales (H1).

**En la UI**: "Tema que crece y conecta con otros; todavía no domina."

Es la zona de transición donde se observa cuál tenderá a H1 y cuál desaparecerá.

**Relacionado:** [Horizonte](#horizonte), [Horizonte 1 (H1 · ya está pasando)](#horizonte-1-h1-ya-esta-pasando), [Horizonte 3 (H3 · señal débil)](#horizonte-3-h3-senal-debil), [Velocidad](#velocidad), [Conectividad](#conectividad)

## Horizonte 3 (H3 · señal débil)

> Chico, lejano o con poca vitalidad. Hipótesis a vigilar; alto riesgo de desaparecer.

**H3** es la categoría de señales débiles: hipótesis emergentes que pueden no llegar a nada.

**Heurística automática** (en `suggestHorizons`):
- H3 si: size < 5 OR vitalidad < 1.5 OR novedad > p75.

**Interpretación**:
- **Chico**: menos de 5 miembros, aún sin masa crítica.
- **Débil**: vitalidad bajo 1.5, poco refresco de señales.
- **Lejano**: distancia del centroide global está en percentil 75+; es exótico, no central.

**En la UI**: "Chico, lejano o con poca vitalidad: hipótesis a vigilar."

Son temas para **monitorear**, no para acción inmediata.
Si no reclutan más señales, caerán a `dead` (fósiles). Si reclutan, migran a H2 o H1.

**Constantes reales:**
- **Size máximo**: `< 5` (heurística de horizontes del job de grafo)
- **Vitalidad máxima**: `< 1.5` (heurística de horizontes del job de grafo)
- **Novedad mínima**: `> p75` (heurística de horizontes del job de grafo)

**Relacionado:** [Horizonte](#horizonte), [Horizonte 1 (H1 · ya está pasando)](#horizonte-1-h1-ya-esta-pasando), [Horizonte 2 (H2 · en transición)](#horizonte-2-h2-en-transicion), [Vitalidad](#vitalidad), [Novedad](#novedad)

## Horizonte

> Una clasificación (H1/H2/H3) que sitúa un tema en el ciclo de maduración: consolidado, en transición, o señal débil.

Un **horizonte** es una clasificación que responde a la pregunta: "¿dónde está este tema en su ciclo?"

Son tres:
- **H1 · ya está pasando**: tendencia consolidada (grande, viva, central).
- **H2 · en transición**: tema en crecimiento, conecta otros (mediano, moderado).
- **H3 · señal débil**: hipótesis a vigilar (chico, lejano o débil).

**Generación automática** (cada corrida, en `suggestHorizons`):
La corrida propone H1/H2/H3 basado en indicadores: size, vitalidad, novedad.
Puedes fijar un tema a mano a un horizonte desde la app (`horizonSource = 'manual'`),
y entonces la corrida respeta esa decisión (no la pisa).

**En la API y la UI**:
- Cada respuesta de tema incluye `horizon` (null si no asignado) y `horizonSuggested` (la propuesta automática).
- Se muestra la etiqueta corta y larga de HORIZON_LABELS: "H2 · en transición".
- En /horizones se agrupan todos los temas vivos de cada horizonte (máximo 5 macro-temas por horizonte).

**Estadística**: los tres horizontes junto dan una foto de la madurez del acervo.
Es **la herramienta principal para responder "¿en qué etapa estamos?"**.

**Constantes reales:**
- **Máximo de macro-temas por horizonte**: `5` (MAX_MACRO_PER_HORIZON, tope de la agrupación de segundo nivel)

**Relacionado:** [Horizonte 1 (H1 · ya está pasando)](#horizonte-1-h1-ya-esta-pasando), [Horizonte 2 (H2 · en transición)](#horizonte-2-h2-en-transicion), [Horizonte 3 (H3 · señal débil)](#horizonte-3-h3-senal-debil), [Tema (cluster semántico)](#tema-cluster-semantico), [Velocidad](#velocidad), [Novedad](#novedad), [Macro-tema](#macro-tema)

## Velocidad

> Tasa de cambio del tema: cuántas señales nuevas llegan en los últimos 30 días vs. los 30 anteriores.

La **velocidad** de un tema es su tasa de cambio: señales que entra en los últimos 30 días dividido por las de los 30 días anteriores.

**Fórmula**:
- `velocity30d` = número de miembros con `likedAt` en últimos 30 días.
- `velocityPrev30d` = número de miembros con `likedAt` entre hace 60 y hace 30 días.
- `velocityDelta` = velocity30d - velocityPrev30d (derivado; que no reste el agente).

**Interpretación**:
- **Delta > 0**: tema está **acelerando**, gana traction.
- **Delta ≈ 0**: tema **estable**, mismo ritmo.
- **Delta < 0**: tema está **desacelerando**, pierde atención.

**En la API**: incluido en los indicadores del tema (`ThemeDetailDTO.indicators.velocity{30d,Prev30d,Delta}`).

Es clave para distinguir H1 consolidada (estable) de H2 en crecimiento.

**Relacionado:** [Tema (cluster semántico)](#tema-cluster-semantico), [Horizonte](#horizonte), [Indicador](#indicador)

## Densidad

> Cohesión interna del tema: similitud coseno promedio entre los miembros y el centroide del grupo.

La **densidad** de un tema mide cuán cohesionados están sus miembros semánticamente.

**Fórmula**:
- Centroide = promedio de los embeddings de todos los miembros (en Postgres, `avg(embedding)`).
- Densidad = similitud coseno promedio entre cada miembro y el centroide.
- Rango: [0, 1]. 1 = todos los miembros son idénticos. 0 = dispersos.

**Interpretación**:
- **Densidad alta** (0.8-1.0): tema muy coherente; miembros muy parecidos.
- **Densidad media** (0.5-0.8): tema coherente pero con variación.
- **Densidad baja** (< 0.5): tema disperso; puede contener subtemas ocultos.

Una densidad baja puede señalar que el clustering detectó un grupo que debería estar en temas separados.
Contraste con novedad para ver si la dispersión es por amplitud (tema paraguas) o por error (temas que deberían escindirse).

**En la API**: `ThemeDetailDTO.indicators.density` (puede ser null si no hay embedding).

**Constantes reales:**
- **Rango**: `[0, 1]` (Similitud coseno normalizada)

**Relacionado:** [Tema (cluster semántico)](#tema-cluster-semantico), [Centroide](#centroide), [Novedad](#novedad), embeddingsingularidad

## Conectividad

> Proporción de aristas del tema que salen hacia otros temas. También: número de temas puente distintos alcanzados.

La **conectividad** de un tema responde a: "¿cuánto está enchufado a otros temas?"

Se calcula de dos formas (ambas en `ThemeDetailDTO.indicators`):
1. **Proporción de aristas salientes**: (aristas que tocan miembros de otros temas) / (todas las aristas que toca este tema).
   Rango [0, 1]. 1 = todas sus aristas van hacia afuera; 0 = completamente aislado.

2. **Número de temas puente** (`bridgeThemes`): cuántos temas distintos son alcanzados en un salto semántico.
   Indica su papel como **nodo de transición** en el grafo.

**Interpretación**:
- **Alta conectividad**: tema que actúa como puente; sus miembros son vecinos de muchos otros temas.
  Señal de que toca multiples frentes del mapa.
- **Baja conectividad**: tema aislado, sin relación semántica clara con otros.

**En la API**: `connectivity` (float, puede ser null) y `bridgeThemes` (integer).

Tema con alta conectividad y baja densidad = tema que hace puente entre varios subtemas.
Tema con alta conectividad y alta densidad = tema "centro" que impulsiona multiples direcciones.

**Relacionado:** [Tema (cluster semántico)](#tema-cluster-semantico), [Tema puente (bridge theme)](#tema-puente-bridge-theme), [Indicador](#indicador), [Horizonte](#horizonte)

## Novedad

> Distancia del centroide del tema al centroide global del mapa. Mide qué tan lejano/exótico es el tema.

La **novedad** de un tema mide su **distancia al centro** del mapa.

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

**En la API**: `ThemeDetailDTO.indicators.novelty` (puede ser null).

Contrasta con `density`: novedad alta + densidad baja = tema que mezcla varias cosas nuevas.
Novedad baja + densidad alta = tema muy coherente pero radical.

**Constantes reales:**
- **Rango**: `[0, 1]` (Similitud coseno normalizada)

**Relacionado:** [Tema (cluster semántico)](#tema-cluster-semantico), [Centroide](#centroide), [Densidad](#densidad), [Horizonte](#horizonte), [Horizonte 3 (H3 · señal débil)](#horizonte-3-h3-senal-debil)

## Tema puente (bridge theme)

> Un tema que actúa de nexo entre otros temas: alta conectividad, aristas hacia múltiples direcciones.

Un **tema puente** es un tema con alta **conectividad**: sus miembros tienen aristas semánticas hacia miembros de muchos otros temas.

Es el tema que "traduce" entre dominios. Ejemplo: un tema sobre "regulación de IA" puede ser puente entre "tecnología" y "política".

**Señales**:
- `connectivity` alta (muchas aristas salen del tema hacia afuera).
- `bridgeThemes` alto (toca muchos otros temas en un salto).
- Posiblemente `density` media-baja (el tema es paraguas, no monolítico).

**En la narrativa**:
- Temas puente son **críticos para entender transiciones**. Si desaparecen, el mapa se fragmenta.
- Son temas "en transición" o "de fusión".

**En la API**: se identifica por su `connectivity` y `bridgeThemes`.
Sirven como puntos de pivote al narrar escenarios.

**Relacionado:** [Tema (cluster semántico)](#tema-cluster-semantico), [Conectividad](#conectividad), [Horizonte](#horizonte), [Horizonte 2 (H2 · en transición)](#horizonte-2-h2-en-transicion)

## Macro-tema

> Agrupación de segundo nivel: conjuntos de hasta 5 temas vivos por horizonte, para simplificar la lectura del mapa.

Un **macro-tema** es una agrupación de segundo nivel: varios temas (H1, H2 o H3) que se agrupan por semejanza semántica.

**Características**:
- Se crean en cada corrida (no tienen linaje, sus ids **no son estables**).
- Máximo 5 por horizonte: si hay más de 5 temas en H1, se agrupan en ≤5 macro-temas.
- Se generan automáticamente agrupando temas por proximidad en el grafo.
- Son read-only, sin historia (a diferencia de temas, que son persistentes).

**En la API**:
- Endpoint `/macro-themes` devuelve todos.
- Endpoint `/horizons/{key}` incluye los macro-temas de ese horizonte.
- Cada macro-tema lleva: `id`, `name`, `summary`, `horizon`, `themes` (array de temas membros).

**Advertencia importante**:
No guardes ids de macro-temas. Se recrean cada corrida. Sus ids son opacos y efímeros.
Usa en cambio los ids de temas (que sí son estables) para referencias duraderas.

**Uso**: para el resumen ejecutivo ("3 macro-temas en H1, 7 en H2").
Para análisis profundo, usa temas individuales.

**Constantes reales:**
- **Máximo por horizonte**: `5` (MAX_MACRO_PER_HORIZON, tope de la agrupación de segundo nivel)
- **Linaje**: `Ninguno (se recrean cada corrida)` (por diseño del job de grafo: se borran y se recrean en cada corrida)

**Relacionado:** [Tema (cluster semántico)](#tema-cluster-semantico), [Horizonte](#horizonte), [Horizonte 1 (H1 · ya está pasando)](#horizonte-1-h1-ya-esta-pasando), [Horizonte 2 (H2 · en transición)](#horizonte-2-h2-en-transicion), [Horizonte 3 (H3 · señal débil)](#horizonte-3-h3-senal-debil)

## Snapshot (foto del grafo)

> Una captura temporal del estado de todos los temas en un momento. Base de la serie temporal.

Un **snapshot** es una foto del grafo en un momento: todos los temas, sus miembros, sus indicadores.

Se crea en cada corrida, con:
- `id` único.
- `takenAt` (timestamp).
- `trigger`: qué causó la corrida (cron, embed, publish, manual).
- `nodes`, `links`: conteos de señales y aristas en ese momento.
- `themesAlive`, `themesDead`, `orphans`: desglose de estado.
- Tabla `graph_snapshot_clusters`: para cada tema, su `size`, `vitality`, `velocity30d`, indicadores.
- Tabla `graph_snapshot_members`: membresía de cada tema en ese momento (para linaje).

**Uso**:
- **Serie temporal**: comparar dos snapshots revela cómo creció/murió cada tema.
- **Linaje**: el snapshot anterior es la "verdad" de membresía para emparejar con la nueva comunidad.
- **Auditoría**: ver qué estaba vivo hace 3 meses.

**En la API**:
- Endpoint `/snapshots` lista con paginación (por `takenAt`).
- Endpoint `/snapshots/{id}` trae el desglose completo. Opción `includeMembers` expande la membresía (cap: 5000 filas).
- Endpoint `/themes/{id}/history` devuelve la serie temporal de un tema solo (más ágil que iterar snapshots).

**Caché**: snapshots por id son inmutables, caché infinita (`max-age=86400, immutable`).

**Constantes reales:**
- **Datos preservados**: `takenAt, trigger, nodos, aristas, temesAlive, themesDead, huérfanas, indicadores` (lo que congela cada foto del grafo)

**Relacionado:** [Tema (cluster semántico)](#tema-cluster-semantico), [Vitalidad](#vitalidad), [Linaje](#linaje), [Horizonte](#horizonte)

## PESTEL

> Marco de análisis de 6 dimensiones macroeconómicas. Cada señal lleva máximo 2.

**PESTEL** es un acrónimo para categorizar las fuerzas que impulsan cambio:
- **P**olitical: leyes, regulaciones, gobiernos.
- **E**conomic: mercados, dinero, inflación.
- **S**ocial: cultura, demografía, valores.
- **T**echnological: tecnología, innovación, estándares.
- **E**nvironmental / Ambiental: clima, recursos, sostenibilidad.
- **L**egal: derechos, contratos, litigios.

Cada dimensión lleva una **letra** (Political=P, Economic=E, Social=S, Technological=T, Environmental=E, Legal=L).

**Clave en la DB**: las claves son inglesas lowercase sin espacios. Ejemplo: `political`, `economic`, `social`, `technological`, `environmental`, `legal`.

**En la API**:
- Endpoint `/pestel` devuelve el catálogo con letra, etiqueta en español, conteo.
- En cada señal: campo `pestel` es un array de hasta 2 claves. Ejemplo: `["technological", "legal"]`.

**Regla de análisis**: cada señal lleva **máximo 2 dimensiones PESTEL**.
Si toca más de 2, el analista elige las 2 más relevantes. Esto agiliza el análisis y concentra la categorización.

**En la UI**: checkboxes de 6 opciones, multiselect (pero el análisis respeta el tope de 2).

**Constantes reales:**
- **Dimensiones**: `Political, Economic, Social, Technological, Environmental, Legal` (catálogo PESTEL fijo del método)
- **Máximo por señal**: `2` (Regla del prompt de análisis)

**Relacionado:** [Señal](#senal), [Categoría](#categoria), categorización

## Categoría

> Clasificación temática manual del contenido: opciones fijas curadas (IA, Biología, etc.) o propuestas del modelo.

Una **categoría** es una etiqueta temática que clasifica el contenido de una señal.

**Origen**:
- **Catálogo curado**: las categorías que editas tú en `/categorias`. Son tuyas: cada banco tiene su propio catálogo.
  Ejemplo: "Inteligencia Artificial", "Biología", "Política".
- **Propuestas del modelo**: el análisis automático (Claude + Ollama) propone categorías nuevas.
  Inicialmente `inCatalog: false`; puedes promoverlas al catálogo curado desde la app.

**Atributos** (en DTO `CategoryDTO`):
- `name`: nombre de la categoría.
- `inCatalog`: si es parte del catálogo curado (true) o una propuesta (false).
- `signalCount`: cuántas señales la usan.
- `examples`: ejemplos de señales.

**Edición**:
- En `/categorias` de la app puedes crear, editar, eliminar y reordenar (drag-drop) las categorías de tu banco.
- La app permite recategorizar de golpe un rango temporal (solo sobre tu propio banco), rehaciendo las categorías automáticas
  respetando `*Source = 'manual'` (no toca lo que hayas fijado a mano).

**En la API**:
- Endpoint `/categories` devuelve el catálogo completo (curado + propuestas).
- Cada señal lleva `category` (string) o `null` (sin asignar) + `categoryConfidence` (0-1).

**Relacionado:** [Señal](#senal), [PESTEL](#pestel), analyze

## Embedding / Similitud semántica

> Vector denso (768 dims) que captura el significado de una señal. Usamos coseno para hallar vecinos semánticos.

Un **embedding** es una representación numérica del significado de un texto.

**Generación** (local):
- Texto de entrada: `contentTitle || tldr || tweetText` (en ese orden de prioridad).
- Modelo: Ollama local, `embeddinggemma` (768 dimensiones).
- Se calcula un hash del modelo + texto. Si el texto o el modelo cambia, se recalcula.
- Se guarda en la DB como tipo `vector(768)` (pgvector).

**Similitud semántica**:
- Medida: **similitud coseno** entre dos vectores. Rango: [0, 1], donde 1 = idénticos, 0 = ortogonales.
- Umbral de arista: ≥ 0.55 (SEMANTIC_LINK_THRESHOLD).
- Aristas: para cada señal, los `SEMANTIC_LINK_TOP_K = 8` vecinos más cercanos (si score ≥ 0.55).

**Temas y grafo**:
- El grafo de aristas (similitud coseno) es la base para detectar comunidades.
- Centroide de tema = promedio de embeddings de sus miembros.
- Densidad = similitud coseno promedio al centroide.
- Novedad = distancia del centroide del tema al centroide global.

**Nunca se devuelve**:
- El vector crudo en la API (`embedding` NO está en `select` de ningún query).
- El % de similitud para humanos (por decisión de producto: 0.65 se lee como falsa precisión).
- El score sí se devuelve para razonamiento de agentes (`score` en DTO), con etiqueta `strength` (fuerte/media/débil).

**En la UI**:
- Espesor de la arista visual = fuerza de la similitud.
- Orden de "vecinos más cercanos" en el panel lateral (sin porcentaje mostrado).

**Constantes reales:**
- **Dimensionalidad**: `768` (embeddinggemma (Ollama local))
- **Umbral de arista**: `≥ 0.55 (coseno)` (SEMANTIC_LINK_THRESHOLD, umbral de arista del grafo semántico)
- **Top-K por señal**: `8` (SEMANTIC_LINK_TOP_K, tope de vecinos por señal al construir el grafo)

**Relacionado:** [Tema (cluster semántico)](#tema-cluster-semantico), grafo, [Densidad](#densidad), [Novedad](#novedad), [Tema puente (bridge theme)](#tema-puente-bridge-theme)

## likedAt (fecha estimada del like)

> La fecha en que se hizo el like. **Siempre es una estimación**, no un dato exacto. Se muestra con `~` (virgulilla).

La **`likedAt`** es la fecha estimada en que guardaste una publicación de X con un like.

**¿Por qué estimada?**
La X API no expone cuándo se hace un like. El historial se importó con una herramienta externa,
que solo sabe cuándo detectó el like en un polling, no cuándo ocurrió realmente.

**Tres fechas distintas en cada señal** (`liked_items`):
1. **`tweetCreatedAt`**: exacta (del snowflake del tweet). Cuándo se publicó el contenido.
2. **`detectedAt`**: exacta (del polling). Cuándo la herramienta lo detectó.
3. **`likedAt`**: estimada. Acotada entre dos corridas de polling consecutivas.

Lo que la app muestra en esa columna es `detectedAt`. El valor de `likedAt` se estima como la fecha intermedia entre dos pollings, salvo que lo hayas fijado tú a mano.

**En la API y la UI**:
- `likedAt` siempre se **muestra con una virgulilla**: `~ 25 ago 2026`, **nunca sin ella**.
- El DTO declara `likedAtEstimated: true` (literal siempre verdadero).
- El DTO también trae `likedAtSource`: `"tweet_date"` (si se usó el snowflake) o `"ordered"` (si se estimó por orden de polling).

**Implicación para agentes**:
- Nunca digas "fue likado exactamente el 25 de agosto". Di "fue likado aprox. el 25 de agosto" o "alrededor del 25".
- Si necesitas precisión, usa `tweetCreatedAt` (exacto) o `detectedAt` (exacto del polling).
- En narrativas, la imprecisión es una característica, no un error: "las señales de agosto (~)" es correcto.

**Constantes reales:**
- **Representación visual**: `~ fecha` (Regla de formato del método)
- **likedAtEstimated**: `true (siempre)` (campo literal del DTO de señal)

**Relacionado:** [Señal](#senal), tweetCreatedAt, detectedAt

## Decaimiento de vitalidad

> El proceso exponencial por el cual las señales pierden vitalidad con el tiempo si no hay continuidad.

El **decaimiento** es el mecanismo que hace que las señales antiguas pierdan relevancia.

**Fórmula**: vitalidad intrínseca = `0.5^(días desde el like / HALF_LIFE)`
- Con HALF_LIFE = 30 días, una señal pierde el 50% de su vitalidad cada mes.
- Tras 30 días: 0.5.
- Tras 60 días: 0.25.
- Tras 90 días: 0.125.

**Reanimación**: una señal antigua puede recuperar vitalidad si una vecina reciente la empuja (reanimación por contagio).

**Huérfanas**: decaen al doble (HALF_LIFE = 15 días). Si nada llega a acompañarlas, se apagan rápido.

**Muerte de tema**: si la suma de vitalidad de los miembros cae bajo 1.0, el tema muere (pasa a `dead`/fósil).
Es la muerte que provoca el decaimiento — pero no la única que existe: un tema también pasa a fósil si su linaje no empareja
en una corrida, y eso ocurre a cualquier vitalidad (ver "Fósil").

**Propósito**: es el "olvido" natural del sistema. Lo que fue novedoso hace un año pierde importancia a menos que algo nuevo lo reactive.
Sin decaimiento, el mapa acumularía ruido histórico.

**Constantes reales:**
- **HALF_LIFE_DAYS**: `30 días` (HALF_LIFE_DAYS, vida media configurable del job de grafo)
- **ORPHAN_HALF_LIFE_DAYS**: `15 días` (derivada: la mitad de HALF_LIFE_DAYS)

**Relacionado:** [Vitalidad](#vitalidad), [Señal](#senal), [Señal huérfana](#senal-huerfana), [Fósil (tema muerto)](#fosil-tema-muerto)

## Centroide

> El promedio de embeddings de un conjunto de señales. Define el "centro" semántico del tema o del mapa.

Un **centroide** es el promedio de los vectores de embedding de un conjunto de señales.

**Usos**:
1. **Centroide del tema**: promedio de embeddings de los miembros del tema.
   - Se usa para calcular `densidad` (similitud de miembros al centroide).
   - Se usa para calcular `novedad` (distancia del centroide del tema al centroide global).

2. **Centroide global**: promedio de embeddings de **todas las señales publicadas**.
   - Es el "centro de gravedad" del mapa completo.
   - Punto de referencia para medir cuán lejano es cada tema.

**Cálculo**: en Postgres, `avg(embedding)` sobre un subconjunto (tema o global).

**Interpretación semántica**:
- Si todos los miembros de un tema tienen embeddings similares, el centroide está "en medio" (densidad alta).
- Si los miembros están dispersos, el centroide puede ser una región vacía del espacio semántico (densidad baja, tema disperso).

**No se expone**: el vector centroide no se devuelve en la API. Solo los indicadores (densidad, novedad) que lo usan.

**Relacionado:** [Embedding / Similitud semántica](#embedding-similitud-semantica), [Densidad](#densidad), [Novedad](#novedad), [Tema (cluster semántico)](#tema-cluster-semantico)

## Indicador

> Métrica cuantitativa que describe la salud o el estado de un tema: velocidad, densidad, conectividad, novedad.

Un **indicador** es una métrica numérica que ayuda a entender el estado de un tema.

**Los cuatro indicadores principales** (en `ThemeDetailDTO.indicators`):
1. **Velocidad**: señales nuevas en 30d vs. 30d previos (`velocity30d`, `velocityPrev30d`, `velocityDelta`).
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

**En la API**: siempre en formato `float | null` (densidad, conectividad, novedad pueden ser null si falta data).

**Relacionado:** [Tema (cluster semántico)](#tema-cluster-semantico), [Velocidad](#velocidad), [Densidad](#densidad), [Conectividad](#conectividad), [Novedad](#novedad)

---
*Generado desde `src/domain/glossary.ts` en `2026-08-26T17:44:54.760Z`*
