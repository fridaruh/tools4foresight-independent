# Referencia de tools — `mcp-t4f-multitenant`

> La superficie MCP completa: 18 tools, 7 resources y 6 prompts sobre **el banco de
> señales de la persona cuya API key se usó**. Este documento describe **lo que expone
> el servidor MCP**, no la API HTTP subyacente — para eso está `docs/API.md`, que es el
> contrato entre `MCP_T4F_Multitenant` y `tools4foresight`.
>
> **No hay filtro de "solo publicadas".** La persona es la curadora de su banco y lo ve
> completo; `publishStatus` viaja como dato («esto ya lo revisé»), nunca como una puerta
> cerrada. Para el vocabulario del
> dominio (señal, tema, fósil, vitalidad, horizonte...) ver `docs/DOMAIN.md` o, en
> tiempo de ejecución, la tool `explain_foresight_term`.

## Índice

1. [Cómo leer esta referencia](#1-cómo-leer-esta-referencia)
2. [Tools de señales](#2-tools-de-señales)
   - [`list_signals`](#list_signals)
   - [`search_signals`](#search_signals)
   - [`get_signal`](#get_signal)
   - [`get_signal_neighbors`](#get_signal_neighbors)
3. [Tools de temas](#3-tools-de-temas)
   - [`list_themes`](#list_themes)
   - [`get_theme`](#get_theme)
   - [`list_theme_signals`](#list_theme_signals)
   - [`get_theme_history`](#get_theme_history)
   - [`list_macro_themes`](#list_macro_themes)
4. [Tools de horizontes](#4-tools-de-horizontes)
   - [`get_horizons_overview`](#get_horizons_overview)
   - [`get_horizon`](#get_horizon)
5. [Tools de taxonomía](#5-tools-de-taxonomía)
   - [`list_categories`](#list_categories)
   - [`list_pestel_dimensions`](#list_pestel_dimensions)
   - [`get_corpus_overview`](#get_corpus_overview)
6. [Tool de grafo](#6-tool-de-grafo)
   - [`get_graph`](#get_graph)
7. [Tools de snapshots](#7-tools-de-snapshots)
   - [`list_snapshots`](#list_snapshots)
   - [`get_snapshot`](#get_snapshot)
8. [Tool de método](#8-tool-de-método)
   - [`explain_foresight_term`](#explain_foresight_term)
9. [Resources](#9-resources)
10. [Prompts](#10-prompts)
11. [Errores](#11-errores)
12. [Convenciones de la salida](#12-convenciones-de-la-salida)
13. [Criterio de `outputSchema`](#13-criterio-de-outputschema)

---

## 1. Cómo leer esta referencia

- **Toda tool devuelve dos canales a la vez**: `content` (un bloque `text` en
  markdown, en español, pensado para que lo lea directamente una persona) **y**
  `structuredContent` (el DTO crudo de la API, para que un agente lo parsee sin
  tener que reinterpretar el markdown). Vienen de `toolResult()` en
  `src/tools/context.ts`. El markdown solo se lee bien; el JSON solo se procesa
  bien — por eso van los dos.
- **Todas llevan `annotations.readOnlyHint: true`**, junto con `destructiveHint:
  false`, `idempotentHint: true` y `openWorldHint: true` (la constante `READ_ONLY`
  de `src/tools/context.ts`, aplicada a las 18 sin excepción). Es la señal formal,
  a nivel de protocolo, de que este servidor no puede mutar nada en
  tools4foresight — no hay ninguna tool de escritura en todo el catálogo.
- **Las listas paginadas devuelven `meta.nextCursor` y `meta.hasMore`.** Si
  `hasMore` es `true`, hay que volver a llamar a la misma tool con el mismo resto
  de filtros y `cursor: meta.nextCursor`. **El cursor es opaco**: no tiene una
  forma que valga la pena parsear ni construir a mano — se lee, se guarda tal
  cual y se reenvía sin tocar. Un cursor construido a mano es un cursor roto.
- Cuando la llamada a la API pública falla, la tool no lanza una excepción de
  protocolo: devuelve un **error de tool** (`isError: true`) con un mensaje en
  español pensado para que el modelo corrija el rumbo. Ver [§11](#11-errores).

---

## 2. Tools de señales

*(`src/tools/signals.ts`)*

Una **señal** es una pieza de contenido curado guardada como indicio de futuro: un
tweet o un artículo con su TL;DR, por qué importa e impacto. Estas cuatro tools
son la puerta de entrada al contenido concreto detrás del mapa.

### `list_signals`

Lista las señales del banco con filtros combinables (categoría, PESTEL, horizonte,
tema, rango de fechas, vitalidad mínima, huérfanas). Es la tool genérica de listado
— para buscar un término concreto, ver `search_signals`.

> Lista las señales de TU BANCO (artículos y tweets curados) con filtros. Una *señal* es una pieza de contenido guardada como indicio de futuro, con TL;DR, por qué importa e impacto. La fecha `likedAt` es una ESTIMACIÓN, no un dato: preséntala siempre con `~` (ej. «~25 ago 2026»). Devuelve una página; si `hasMore` es true, vuelve a llamar con el `cursor` que te dio.

**Parámetros**

| Parámetro | Tipo | Obligatorio | Default | Qué hace |
|---|---|---|---|---|
| `q` | string | no | — | Búsqueda de texto sobre título, texto, TL;DR y "por qué importa". |
| `category` | string[] | no | — | Filtra por una o más categorías (OR entre valores). |
| `pestel` | string[] | no | — | Filtra por dimensiones PESTEL (`political`, `economic`, `social`, `technological`, `environmental`, `legal`). |
| `horizon` | `"H1"\|"H2"\|"H3"` | no | — | Solo señales cuyo tema esté en este horizonte. |
| `theme_id` | string | no | — | Solo señales de este tema. |
| `macro_theme_id` | string | no | — | Solo señales de este macro-tema. |
| `from` | string | no | — | Desde esta fecha (`YYYY-MM-DD` o ISO), sobre `likedAt`. |
| `to` | string | no | — | Hasta esta fecha (`YYYY-MM-DD` o ISO), inclusive. |
| `min_vitality` | number | no | — | Vitalidad mínima. La vitalidad decae con el tiempo: `0.5^(días/30)`. |
| `orphans_only` | boolean | no | — | Solo señales sin tema asignado. |
| `sort` | `"likedAt"\|"vitality"` | no | `likedAt` | Orden (más reciente primero por defecto). |
| `limit` | integer | no | `25` | Cuántas traer (1-100). Fuera de rango es un error, no se recorta. |
| `cursor` | string | no | — | Cursor opaco de la página anterior. No lo construyas a mano. |

**Ejemplo de entrada**

```json
{
  "horizon": "H2",
  "pestel": ["legal", "social"],
  "limit": 2
}
```

**Ejemplo de salida** — `content`:

```markdown
### El Parlamento Europeo aprueba el reglamento de agentes autónomos

- **id**: `c7f3a914-20bc-4d4c-9c51-940f372e0d8a`
- **Autor**: Melissa Heikkilä (@melissa_heikkila)
- **Guardado**: ~18 ago 2026
- **Categoría**: Gobernanza y regulación
- **PESTEL**: social, legal
- **Vitalidad**: 0.87 (casi extinta)
- **Tema**: Responsabilidad legal de los agentes autónomos (vivo, H2 · en transición)
- **Curaduría**: revisada

El Parlamento Europeo votó a favor de extender el marco de responsabilidad civil a
los agentes de IA que ejecutan acciones en nombre de una persona. La norma
introduce la figura del "operador desplegante"...

https://www.euractiv.com/section/ai/news/ai-agents-liability-regulation-vote/

### Cuando el asistente decide por ti: fricción y delegación en el trabajo del conocimiento

- **id**: `9b21e0d4-5f7a-4c88-91b3-6ea0c4f27d15`
- **Autor**: @cacm.acm.org
- **Guardado**: ~16 ago 2026
- **Categoría**: Futuro del trabajo
- **PESTEL**: social, legal
- **Vitalidad**: 0.74 (apagándose)
- **Tema**: Responsabilidad legal de los agentes autónomos (vivo, H2 · en transición)
- **Curaduría**: todavía sin revisar

Ensayo sobre la delegación tácita: cuando un agente actúa sin confirmación
explícita, la responsabilidad se difumina entre quien lo configuró y quien lo
dejó correr...

https://cacm.acm.org/opinion/when-the-assistant-decides/

Siguiente página: cursor=djF8MjAyNi0wOC0xNlQyMDo0MTowNS4wMDBafDliMjFlMGQ0LTVmN2EtNGM4OC05MWIzLTZlYTBjNGYyN2QxNQ
```

**Extracto de `structuredContent`**

```json
{
  "data": [
    { "id": "c7f3a914-20bc-4d4c-9c51-940f372e0d8a", "vitality": 0.87, "category": "Gobernanza y regulación", "publishStatus": "published", "...": "..." }
  ],
  "meta": { "nextCursor": "djF8...", "hasMore": true, "count": 2, "total": 34, "generatedAt": "2026-08-25T14:32:12.550Z" }
}
```

**Cuándo usar esta y no aquella**: `list_signals` es para filtrar por atributos
estructurados (categoría, PESTEL, horizonte, fecha, vitalidad). Cuando el criterio
es un término de texto libre, `search_signals` es más directa. Cuando el criterio
es "parecido a esta otra señal" sin que compartan palabras, ninguna de las dos
sirve: eso es `get_signal_neighbors`.

---

### `search_signals`

Búsqueda de texto libre sobre título, texto original, TL;DR y "por qué importa".

> Búsqueda de texto libre sobre el título, el texto original, el TL;DR y el 'por qué importa' de tus señales. Úsala cuando busques un término concreto. Para explorar por CERCANÍA CONCEPTUAL (temas parecidos aunque no compartan palabras), parte de un resultado y usa `get_signal_neighbors`.

**Parámetros**

| Parámetro | Tipo | Obligatorio | Default | Qué hace |
|---|---|---|---|---|
| `query` | string | **sí** | — | El texto a buscar. |
| `horizon` | `"H1"\|"H2"\|"H3"` | no | — | Acota a un horizonte. |
| `from` | string | no | — | Desde esta fecha (`YYYY-MM-DD` o ISO). |
| `to` | string | no | — | Hasta esta fecha (`YYYY-MM-DD` o ISO). |
| `limit` | integer | no | `25` | Cuántas traer (1-100). |

**Ejemplo de entrada**

```json
{ "query": "agentes autónomos responsabilidad", "horizon": "H2", "limit": 1 }
```

**Ejemplo de salida** — `content`:

```markdown
### El Parlamento Europeo aprueba el reglamento de agentes autónomos

- **id**: `c7f3a914-20bc-4d4c-9c51-940f372e0d8a`
- **Autor**: Melissa Heikkilä (@melissa_heikkila)
- **Guardado**: ~18 ago 2026
- **Categoría**: Gobernanza y regulación
- **PESTEL**: social, legal
- **Vitalidad**: 0.87 (casi extinta)
- **Tema**: Responsabilidad legal de los agentes autónomos (vivo, H2 · en transición)
- **Curaduría**: revisada

El Parlamento Europeo votó a favor de extender el marco de responsabilidad civil...

https://www.euractiv.com/section/ai/news/ai-agents-liability-regulation-vote/
```

**Extracto de `structuredContent`**

```json
{
  "data": [{ "id": "c7f3a914-20bc-4d4c-9c51-940f372e0d8a", "title": "El Parlamento Europeo aprueba el reglamento de agentes autónomos", "publishStatus": "published" }],
  "meta": { "nextCursor": null, "hasMore": false, "count": 1, "generatedAt": "2026-08-25T14:32:40.011Z" }
}
```

**Cuándo usar esta y no aquella**: `search_signals` empareja **texto literal** — el
mismo término, o algo muy parecido, tiene que aparecer en el contenido. Para
"encuéntrame algo que hable de lo mismo aunque use otras palabras" (cercanía
**conceptual**, vía embeddings), la tool correcta es `get_signal_neighbors`,
partiendo de una señal ya localizada.

---

### `get_signal`

Ficha completa de una señal: TL;DR, por qué importa, impacto, categoría, PESTEL,
vitalidad, tema y procedencia exacta del tweet.

> Ficha completa de una señal: TL;DR, por qué importa, impacto en el desarrollo de la IA y en la interacción entre humanos, categoría, dimensiones PESTEL, vitalidad y el tema al que pertenece. La fecha `likedAt` es estimada (muéstrala con `~`); `tweetCreatedAt` sí es exacta.

**Parámetros**

| Parámetro | Tipo | Obligatorio | Default | Qué hace |
|---|---|---|---|---|
| `signal_id` | string | **sí** | — | El id de la señal. |

**Ejemplo de entrada**

```json
{ "signal_id": "c7f3a914-20bc-4d4c-9c51-940f372e0d8a" }
```

**Ejemplo de salida** — `content`:

```markdown
### El Parlamento Europeo aprueba el reglamento de agentes autónomos

- **id**: `c7f3a914-20bc-4d4c-9c51-940f372e0d8a`
- **Autor**: Melissa Heikkilä (@melissa_heikkila)
- **Guardado**: ~18 ago 2026
- **Categoría**: Gobernanza y regulación
- **PESTEL**: social, legal
- **Vitalidad**: 0.87 (casi extinta)
- **Tema**: Responsabilidad legal de los agentes autónomos (vivo, H2 · en transición)
- **Curaduría**: revisada

El Parlamento Europeo votó a favor de extender el marco de responsabilidad civil a
los agentes de IA que ejecutan acciones en nombre de una persona...

https://www.euractiv.com/section/ai/news/ai-agents-liability-regulation-vote/

**Por qué importa**

Es la primera vez que un legislador define quién responde cuando un agente actúa
solo. Fija el vocabulario con el que se van a escribir los contratos de software
de los próximos años...

**Impacto en el desarrollo de la IA y la interacción humana**

Si el riesgo legal recae en quien despliega y no en quien fabrica el modelo, las
organizaciones van a exigir agentes que expliquen y registren cada acción antes
que agentes que actúen más rápido...

- **Fuente**: like en X
- **Tweet publicado**: 17 ago 2026
- **Tweet**: https://x.com/melissa_heikkila/status/1957402219883110401
- **Vecinos semánticos**: 11
- **Revisada**: 19 ago 2026
```

**Extracto de `structuredContent`**

```json
{
  "data": {
    "id": "c7f3a914-20bc-4d4c-9c51-940f372e0d8a",
    "likedAt": "2026-08-18T09:14:22.103Z",
    "likedAtEstimated": true,
    "tweetCreatedAt": "2026-08-17T11:22:48.000Z",
    "vitality": 0.87,
    "publishStatus": "published",
    "neighborCount": 11
  }
}
```

**Cuándo usar esta y no aquella**: `get_signal` es la ficha completa de UNA señal ya
identificada (por `list_signals`, `search_signals` o como vecina de otra). No sirve
para descubrir señales — para eso, las tres anteriores.

---

### `get_signal_neighbors`

Las señales semánticamente más cercanas a una dada, según el grafo de similitud.

> Las señales semánticamente más cercanas a una dada, según el grafo. Es la forma de explorar el mapa por significado en vez de por palabras. Devuelve `strength` (fuerte/media/débil) y `score` (coseno crudo). USA `strength` CUANDO REDACTES PARA UNA PERSONA; el `score` es solo para tu razonamiento interno: no muestres el porcentaje de similitud al usuario final, se lee como una precisión que el método no tiene.

**Parámetros**

| Parámetro | Tipo | Obligatorio | Default | Qué hace |
|---|---|---|---|---|
| `signal_id` | string | **sí** | — | El id de la señal de partida. |
| `limit` | integer | no | `10` | Cuántos vecinos (1-50). |
| `min_score` | number | no | `0.55` | Score mínimo entre 0 y 1. El grafo ya filtra por debajo de 0.55. |

**Ejemplo de entrada**

```json
{ "signal_id": "c7f3a914-20bc-4d4c-9c51-940f372e0d8a", "limit": 2, "min_score": 0.7 }
```

**Ejemplo de salida** — `content`:

```markdown
### Cuando el asistente decide por ti: fricción y delegación en el trabajo del conocimiento

- **id**: `9b21e0d4-5f7a-4c88-91b3-6ea0c4f27d15`
- **Cercanía**: fuerte
- **Tema**: Responsabilidad legal de los agentes autónomos (vivo, H2 · en transición)
- **Guardado**: ~16 ago 2026

### Auditoría de bitácoras: qué registra realmente un agente en producción

- **id**: `31a7c5be-0d92-4a60-8f74-b1e3d8c04a27`
- **Cercanía**: media
- **Tema**: Responsabilidad legal de los agentes autónomos (vivo, H2 · en transición)
- **Guardado**: ~11 ago 2026
```

Nótese: **ni un `%` ni un decimal de similitud aparecen en este markdown** — es una
regla dura (hay un test que la verifica en `tests/format.test.ts`).

**Extracto de `structuredContent`**

```json
{
  "data": [
    { "signal": { "id": "9b21e0d4-5f7a-4c88-91b3-6ea0c4f27d15" }, "score": 0.8123, "strength": "fuerte" },
    { "signal": { "id": "31a7c5be-0d92-4a60-8f74-b1e3d8c04a27" }, "score": 0.7418, "strength": "media" }
  ],
  "meta": { "nextCursor": null, "hasMore": false, "count": 2, "total": 11, "generatedAt": "2026-08-25T14:33:40.702Z" }
}
```

**Cuándo usar esta y no aquella**: es la única forma de explorar por **cercanía
conceptual** en vez de por texto. `search_signals` exige coincidencia literal;
`get_signal_neighbors` sigue el grafo de embeddings y encuentra señales que hablan
de lo mismo con otro vocabulario. El `score` numérico viaja en `structuredContent`
para el razonamiento del agente (ordenar, poner un umbral propio); nunca debe
aparecer en texto dirigido a una persona.

---

## 3. Tools de temas

*(`src/tools/themes.ts`)*

Un **tema** es un LINAJE: un cluster semántico que persiste entre corridas del
grafo, acumula historia y puede morir (fósil, `status: 'dead'`) y resucitar. Nada
se borra nunca: un fósil sigue teniendo id, nombre y miembros consultables.

### `list_themes`

Lista los temas con filtros. Por defecto solo trae temas vivos.

> Lista los *temas* (clusters semánticos) con filtros. Un tema es un LINAJE que persiste entre corridas del grafo, acumula historia y puede **morir** (fósil, `status:'dead'`) y **resucitar** si llegan señales nuevas con vitalidad suficiente. Nada se borra: un fósil sigue siendo consultable íntegro (nombre, historia, últimos miembros). Por defecto solo trae temas vivos; pide `status:"any"` o `status:"dead"` para incluir fósiles. Devuelve una página; si `hasMore` es true, vuelve a llamar con el `cursor` que te dio.

**Parámetros**

| Parámetro | Tipo | Obligatorio | Default | Qué hace |
|---|---|---|---|---|
| `status` | `"alive"\|"dead"\|"any"` | no | `alive` | Filtra por estado. |
| `horizon` | `"H1"\|"H2"\|"H3"` | no | — | Solo temas de este horizonte (H1 ya está pasando, H2 en transición, H3 señal débil). |
| `macro_theme_id` | string | no | — | Solo temas de este macro-tema. |
| `q` | string | no | — | Búsqueda de texto sobre el nombre y el resumen del tema. |
| `min_vitality` | number | no | — | Vitalidad mínima. Un tema muere (fósil) cuando la suma de vitalidad de sus miembros cae bajo 1.0. |
| `sort` | `"vitality"\|"size"\|"velocity"\|"lastSignal"` | no | `vitality` | Orden, siempre descendente. |
| `limit` | integer | no | `25` | Cuántos traer (1-100). Fuera de rango es un error, no se recorta. |
| `cursor` | string | no | — | Cursor opaco de la página anterior. No lo construyas a mano. |

**Ejemplo de entrada**

```json
{ "horizon": "H2", "sort": "velocity", "limit": 2 }
```

**Ejemplo de salida** — `content`:

```markdown
### Responsabilidad legal de los agentes autónomos

- **id**: `4e9b1c72-8a30-4f11-b8d6-2c5a7e0d91f4`
- **Estado**: vivo
- **Horizonte**: H2 · en transición
- **Tamaño**: 14 señales
- **Vitalidad**: 4.12 (viva)
- **Macro-tema**: Gobernanza de sistemas que actúan solos
- **Última señal**: ~18 ago 2026

Señales sobre quién responde cuando un sistema de IA actúa por cuenta propia:
marcos regulatorios, bitácoras auditables, seguros y contratos de despliegue.

### Energía y límites físicos del cómputo

- **id**: `a1c60f93-77de-4b25-8c30-19f2b7e4d508`
- **Estado**: vivo
- **Horizonte**: H2 · en transición
- **Tamaño**: 11 señales
- **Vitalidad**: 3.48 (viva)
- **Última señal**: ~21 ago 2026

El costo eléctrico y térmico de entrenar e inferir aparece como restricción de
diseño: contratos de generación, ubicación de centros de datos y modelos más
pequeños por necesidad, no por elegancia.

Siguiente página: cursor=djF8MjAyNi0wOC0yMVQxNjo1MjozMy43NzFafGExYzYwZjkzLTc3ZGUtNGIyNS04YzMwLTE5ZjJiN2U0ZDUwOA
```

**Extracto de `structuredContent`**

```json
{
  "data": [
    { "id": "4e9b1c72-8a30-4f11-b8d6-2c5a7e0d91f4", "vitality": 4.12, "status": "alive", "horizon": "H2" }
  ],
  "meta": { "nextCursor": "djF8...", "hasMore": true, "count": 2, "total": 9, "generatedAt": "2026-08-25T14:34:05.330Z" }
}
```

**Cuándo usar esta y no aquella**: es el listado genérico de temas. Para leer las
señales concretas detrás de uno, `list_theme_signals`. Para su trayectoria en el
tiempo (¿crece o se apaga?), `get_theme_history`, no reordenar varias llamadas a
`list_themes`.

---

### `get_theme`

Ficha completa de un tema: linaje y los cuatro indicadores.

> Ficha completa de un tema: su linaje (cuándo nació, si murió y resucitó, cuántas veces) y sus cuatro indicadores — **velocidad** (señales nuevas en los últimos 30 días vs. los 30 previos: positivo es que acelera, negativo que se apaga), **densidad** (cohesión: similitud media de los miembros al centroide del tema), **conectividad** (proporción de aristas que salen hacia otros temas; alta = tema puente) y **novedad** (distancia del centroide del tema al centroide global del mapa: baja = radicalmente nuevo, alta = mainstream). Incluye la lista de ids de los miembros (`lastMemberIds` si el tema es fósil).

**Parámetros**

| Parámetro | Tipo | Obligatorio | Default | Qué hace |
|---|---|---|---|---|
| `theme_id` | string | **sí** | — | El id del tema. Es estable: persiste aunque el tema muera y resucite. |

**Ejemplo de entrada**

```json
{ "theme_id": "4e9b1c72-8a30-4f11-b8d6-2c5a7e0d91f4" }
```

**Ejemplo de salida** — `content`:

```markdown
### Responsabilidad legal de los agentes autónomos

- **id**: `4e9b1c72-8a30-4f11-b8d6-2c5a7e0d91f4`
- **Estado**: vivo
- **Horizonte**: H2 · en transición
- **Tamaño**: 14 señales
- **Vitalidad**: 4.12 (viva)
- **Macro-tema**: Gobernanza de sistemas que actúan solos
- **Última señal**: ~18 ago 2026

Señales sobre quién responde cuando un sistema de IA actúa por cuenta propia:
marcos regulatorios, bitácoras auditables, seguros y contratos de despliegue.

- **Nació**: 2 mar 2026
- **Resucitado**: 1 vez

**Indicadores**
- Velocidad: 6 señales nuevas en 30d (30d previos: 2, delta: +4)
- Densidad: 0.71
- Conectividad: 0.29
- Novedad: 0.40
- Temas puente: 3

**Miembros** (14): `31a7c5be-0d92-4a60-8f74-b1e3d8c04a27`, `9b21e0d4-5f7a-4c88-91b3-6ea0c4f27d15`, `c7f3a914-20bc-4d4c-9c51-940f372e0d8a`, ...
```

**Extracto de `structuredContent`**

```json
{
  "data": {
    "id": "4e9b1c72-8a30-4f11-b8d6-2c5a7e0d91f4",
    "revivedCount": 1,
    "indicators": { "velocity30d": 6, "velocityPrev30d": 2, "velocityDelta": 4, "density": 0.7134, "connectivity": 0.2857, "novelty": 0.4021, "bridgeThemes": 3 },
    "memberIds": ["31a7c5be-0d92-4a60-8f74-b1e3d8c04a27", "9b21e0d4-5f7a-4c88-91b3-6ea0c4f27d15", "c7f3a914-20bc-4d4c-9c51-940f372e0d8a"]
  }
}
```

**Cuándo usar esta y no aquella**: `get_theme` es una **foto** — el estado del tema
ahora mismo, con sus indicadores actuales. Para saber si esos indicadores vienen
subiendo o bajando (la **trayectoria**), la tool es `get_theme_history`: no se
infiere una tendencia de un solo `get_theme`.

---

### `list_theme_signals`

Las señales que componen un tema (su membresía actual).

> Las señales que componen un tema (su membresía actual), ordenadas por vitalidad o por fecha de like. Úsala para leer el contenido concreto detrás de un tema, no solo sus indicadores agregados. La fecha `likedAt` de cada señal es una ESTIMACIÓN: preséntala siempre con `~`.

**Parámetros**

| Parámetro | Tipo | Obligatorio | Default | Qué hace |
|---|---|---|---|---|
| `theme_id` | string | **sí** | — | El id del tema. |
| `sort` | `"vitality"\|"likedAt"` | no | `vitality` | Orden, siempre descendente. |
| `limit` | integer | no | `25` | Cuántas traer (1-100). |
| `cursor` | string | no | — | Cursor opaco de la página anterior. No lo construyas a mano. |

**Ejemplo de entrada**

```json
{ "theme_id": "4e9b1c72-8a30-4f11-b8d6-2c5a7e0d91f4", "sort": "likedAt", "limit": 1 }
```

**Ejemplo de salida** — `content`:

```markdown
### El Parlamento Europeo aprueba el reglamento de agentes autónomos

- **id**: `c7f3a914-20bc-4d4c-9c51-940f372e0d8a`
- **Autor**: Melissa Heikkilä (@melissa_heikkila)
- **Guardado**: ~18 ago 2026
- **Categoría**: Gobernanza y regulación
- **PESTEL**: social, legal
- **Vitalidad**: 0.87 (casi extinta)
- **Tema**: Responsabilidad legal de los agentes autónomos (vivo, H2 · en transición)
- **Curaduría**: revisada

El Parlamento Europeo votó a favor de extender el marco de responsabilidad civil...

https://www.euractiv.com/section/ai/news/ai-agents-liability-regulation-vote/

Siguiente página: cursor=djF8MjAyNi0wOC0xOFQwOToxNDoyMi4xMDNafGM3ZjNhOTE0LTIwYmMtNGQ0Yy05YzUxLTk0MGYzNzJlMGQ4YQ
```

**Extracto de `structuredContent`**

```json
{
  "data": [{ "id": "c7f3a914-20bc-4d4c-9c51-940f372e0d8a", "vitality": 0.87 }],
  "meta": { "nextCursor": "djF8...", "hasMore": true, "count": 1, "total": 14, "generatedAt": "2026-08-25T14:34:51.006Z" }
}
```

> Nota de dominio: un tema **fósil** devuelve `[]` aquí (sus señales quedaron sin
> `clusterId`). Para reconstruir qué tuvo un fósil, se recorre `memberIds` de
> `get_theme` y se pide cada señal con `get_signal`.

**Cuándo usar esta y no aquella**: `get_theme` da los indicadores agregados;
`list_theme_signals` da el contenido real que los sostiene. Úsala cuando el
indicador por sí solo no explica de qué habla el tema, o cuando hay que citar
señales concretas en un informe.

---

### `get_theme_history`

La serie temporal de un tema a través de las corridas del grafo.

> La serie temporal de un tema a través de las corridas del grafo: cómo cambiaron su tamaño, vitalidad, velocidad y horizonte con el tiempo. **Es la tool para responder "¿esto está creciendo o apagándose?"** — no lo infieras de un solo `get_theme`, pide la historia. Los puntos vienen en orden ascendente por fecha, tal como los da el servidor: no los reordenes.

**Parámetros**

| Parámetro | Tipo | Obligatorio | Default | Qué hace |
|---|---|---|---|---|
| `theme_id` | string | **sí** | — | El id del tema. |
| `from` | string | no | — | Desde esta fecha (`YYYY-MM-DD` o ISO), sobre la fecha de la corrida. |
| `to` | string | no | — | Hasta esta fecha (`YYYY-MM-DD` o ISO), inclusive. |
| `limit` | integer | no | — | Cuántos puntos traer como máximo. |

**Ejemplo de entrada**

```json
{ "theme_id": "4e9b1c72-8a30-4f11-b8d6-2c5a7e0d91f4", "from": "2026-08-20", "limit": 3 }
```

**Ejemplo de salida** — `content`:

```markdown
## Historia de "Responsabilidad legal de los agentes autónomos"

- 21 ago 2026, 06:00 UTC (cron): tamaño 12, vivo, 3.61 (viva), velocidad 4, H2 · en transición
- 23 ago 2026, 18:41 UTC (publish): tamaño 13, vivo, 3.95 (viva), velocidad 5, H2 · en transición
- 25 ago 2026, 06:00 UTC (cron): tamaño 14, vivo, 4.12 (viva), velocidad 6, H2 · en transición
```

**Extracto de `structuredContent`**

```json
{
  "data": {
    "themeId": "4e9b1c72-8a30-4f11-b8d6-2c5a7e0d91f4",
    "points": [
      { "size": 12, "vitality": 3.61, "velocity30d": 4, "horizon": "H2", "takenAt": "2026-08-21T06:00:08.114Z", "trigger": "cron" },
      { "size": 14, "vitality": 4.12, "velocity30d": 6, "horizon": "H2", "takenAt": "2026-08-25T06:00:11.402Z", "trigger": "cron" }
    ]
  }
}
```

**Cuándo usar esta y no aquella**: es la respuesta directa a "¿está creciendo o
apagándose?". `get_theme` da un punto; `get_theme_history` da la serie completa
para trazar la trayectoria — no hay atajo válido comparando dos `get_theme` en
momentos distintos, porque no arma la serie intermedia.

---

### `list_macro_themes`

Macro-temas: agrupación de segundo nivel de hasta 5 temas vivos por horizonte.

> Macro-temas: una agrupación de segundo nivel de hasta 5 temas vivos por horizonte, para simplificar la lectura del mapa (por ejemplo, para un resumen ejecutivo tipo "3 macro-temas en H1, 7 en H2"). **Sus ids NO son estables entre corridas**: se borran y se recrean enteros cada vez que corre el grafo, así que NO los guardes ni los uses como referencia duradera — para eso usa los ids de los temas individuales, que sí persisten. Para análisis profundo de un macro-tema, entra a sus temas miembro con `get_theme`.

**Parámetros**

| Parámetro | Tipo | Obligatorio | Default | Qué hace |
|---|---|---|---|---|
| `horizon` | `"H1"\|"H2"\|"H3"` | no | — | Acota a un horizonte. Sin filtro trae los de los tres. |

**Ejemplo de entrada**

```json
{ "horizon": "H2" }
```

**Ejemplo de salida** — `content`:

```markdown
## Macro-temas

### Gobernanza de sistemas que actúan solos

- **id**: `b8d40e21-3f6c-4a19-9e02-77c5a1f4b930` _(no estable entre corridas — no lo guardes)_
- **Horizonte**: H2 · en transición

Temas que convergen en la misma pregunta desde ángulos distintos: cuando el
software deja de sugerir y empieza a ejecutar, quién firma, quién audita y quién
paga.

**Temas**
- Responsabilidad legal de los agentes autónomos — 4.12 (viva)
- Identidad y credenciales para máquinas — 2.87 (viva)
```

**Extracto de `structuredContent`**

```json
{
  "data": [
    { "id": "b8d40e21-3f6c-4a19-9e02-77c5a1f4b930", "name": "Gobernanza de sistemas que actúan solos", "horizon": "H2", "themes": [ "..." ] }
  ],
  "meta": { "nextCursor": null, "hasMore": false, "count": 1, "generatedAt": "2026-08-25T14:35:44.128Z" }
}
```

**Cuándo usar esta y no aquella**: para un resumen ejecutivo de alto nivel ("3
macro-temas en H1, 7 en H2") en vez de una lista plana de decenas de temas
individuales. No la uses para guardar o citar un id entre sesiones — para eso, el
id de un tema (`get_theme`), que sí es estable.

---

## 4. Tools de horizontes

*(`src/tools/horizons.ts`)*

Un **horizonte** es una de las tres franjas temporales del mapa: H1 (ya está
pasando), H2 (en transición) y H3 (señal débil).

### `get_horizons_overview`

El panorama de los tres horizontes con sus agregados. La puerta de entrada
habitual para "¿cómo va el mapa?".

> EMPIEZA POR AQUÍ cuando te pidan 'el estado del mapa' o un resumen general de hacia dónde va todo. Devuelve los tres horizontes de foresight con su etiqueta real (no la inventes, viene del glosario): H1 · ya está pasando (tendencia consolidada, grande y cerca del centro del mapa), H2 · en transición (crece y conecta pero todavía no domina) y H3 · señal débil (chico o lejano; hipótesis a vigilar, alto riesgo de desaparecer). En este listado los macro-temas vienen sin su lista de temas completa; para eso usa `get_horizon`.

**Parámetros**: ninguno (`inputSchema: {}`).

**Ejemplo de entrada**

```json
{}
```

**Ejemplo de salida** — `content`:

```markdown
## H1 · ya está pasando

Tendencia consolidada: grande, viva y cerca del centro del mapa.

- **Temas vivos**: 4
- **Señales**: 212
- **Vitalidad total**: 38.71

**Macro-temas**
- El asistente como capa de trabajo por defecto

## H2 · en transición

Tema que crece y conecta con otros; todavía no domina.

- **Temas vivos**: 9
- **Señales**: 143
- **Vitalidad total**: 26.44

**Macro-temas**
- Gobernanza de sistemas que actúan solos

## H3 · señal débil

Chico, lejano o con poca vitalidad: hipótesis a vigilar.

- **Temas vivos**: 14
- **Señales**: 97
- **Vitalidad total**: 19.02

**Macro-temas**
- Cuerpos, sensores y presencia
```

**Extracto de `structuredContent`**

```json
{
  "data": [
    { "key": "H1", "labelShort": "H1 · ya está pasando", "themeCount": 4, "signalCount": 212, "vitalitySum": 38.71, "macroThemes": [] },
    { "key": "H2", "labelShort": "H2 · en transición", "themeCount": 9, "signalCount": 143, "vitalitySum": 26.44, "macroThemes": [] },
    { "key": "H3", "labelShort": "H3 · señal débil", "themeCount": 14, "signalCount": 97, "vitalitySum": 19.02, "macroThemes": [] }
  ],
  "meta": { "nextCursor": null, "hasMore": false, "count": 3, "generatedAt": "2026-08-25T14:36:10.775Z" }
}
```

**Cuándo usar esta y no aquella**: es el primer paso casi siempre que se pregunta
por el mapa en general. Aquí los `macroThemes` vienen con la lista de temas vacía
(para no devolver el corpus entero en una llamada); cuando hace falta bajar al
detalle completo de una franja, `get_horizon`.

---

### `get_horizon`

Un horizonte con TODOS sus temas vivos y sus macro-temas.

> Un horizonte (H1/H2/H3) con TODOS sus temas vivos y sus macro-temas. Úsala después de `get_horizons_overview` cuando quieras bajar del panorama general a la lista completa de temas de una sola franja temporal.

**Parámetros**

| Parámetro | Tipo | Obligatorio | Default | Qué hace |
|---|---|---|---|---|
| `horizon` | `"H1"\|"H2"\|"H3"` | **sí** | — | La clave del horizonte: H1 (ya está pasando), H2 (en transición) o H3 (señal débil). |

**Ejemplo de entrada**

```json
{ "horizon": "H3" }
```

**Ejemplo de salida** — `content`:

```markdown
## H3 · señal débil

Chico, lejano o con poca vitalidad: hipótesis a vigilar.

- **Temas vivos**: 14
- **Señales**: 97
- **Vitalidad total**: 19.02

**Macro-temas**
- Cuerpos, sensores y presencia

**Temas**
- Duelo y memoria con modelos de lenguaje — 1.63 (estable)
- Robótica doméstica de propósito general — 1.29 (estable)
```

**Extracto de `structuredContent`**

```json
{
  "data": {
    "key": "H3",
    "themeCount": 14,
    "signalCount": 97,
    "themes": [
      { "id": "e04f21b7-6c85-4a30-9d12-3f70b8ea5c69", "name": "Duelo y memoria con modelos de lenguaje", "vitality": 1.63 },
      { "id": "5a8c30d9-1e47-4b62-90fa-cd2178e6b043", "name": "Robótica doméstica de propósito general", "vitality": 1.29 }
    ]
  },
  "meta": { "count": 2, "generatedAt": "2026-08-25T14:36:38.201Z" }
}
```

**Cuándo usar esta y no aquella**: cuando ya se sabe qué franja interesa y hace
falta la lista completa de sus temas (no solo el agregado que da
`get_horizons_overview`). No sirve para listar señales sueltas ni para filtrar por
categoría — para eso, `list_signals` con `horizon`.

---

## 5. Tools de taxonomía

*(`src/tools/taxonomy.ts`)*

### `list_categories`

El catálogo de categorías con las que se clasifica cada señal, curadas y
propuestas.

> El catálogo de categorías con las que se clasifica cada señal, curadas y propuestas. `inCatalog: false` marca una categoría que PROPUSO el modelo de análisis y todavía no está en el catálogo curado — es una FEATURE (así se descubren categorías nuevas antes de curarlas a mano), no un error ni una categoría rota.

**Parámetros**: ninguno.

**Ejemplo de entrada**

```json
{}
```

**Ejemplo de salida** — `content`:

```markdown
## Categorías

- **Gobernanza y regulación** (218 señales) — Normas, votaciones, litigios y estándares que definen qué se puede construir y desplegar, y quién responde cuando algo sale mal.
- **Futuro del trabajo** (176 señales) — Cómo cambia la tarea, el oficio y la relación laboral cuando parte del trabajo lo hace un modelo.
- **Otros** (31 señales) · categoría de último recurso — Categoría de último recurso para señales que todavía no encajan en ninguna otra.
- **Infraestructura energética** (7 señales) _(propuesta por el modelo, aún no está en el catálogo curado)_
```

**Extracto de `structuredContent`**

```json
{
  "data": [
    { "name": "Gobernanza y regulación", "signalCount": 218, "isFallback": false, "inCatalog": true },
    { "name": "Infraestructura energética", "signalCount": 7, "isFallback": false, "inCatalog": false }
  ],
  "meta": { "nextCursor": null, "hasMore": false, "count": 4, "generatedAt": "2026-08-25T14:37:02.663Z" }
}
```

**Cuándo usar esta y no aquella**: para conocer el vocabulario válido de
`category` antes de filtrar con `list_signals`, o para detectar categorías
emergentes (`inCatalog: false`) que el modelo de análisis ya está proponiendo.

---

### `list_pestel_dimensions`

Las seis dimensiones PESTEL con su conteo de señales.

> Las seis dimensiones PESTEL (Political, Economic, Social, Technological, Environmental, Legal) con su conteo de señales. OJO: cada señal lleva como máximo 2 dimensiones, así que la suma de los conteos puede superar el total de señales — eso es esperado, no una inconsistencia.

**Parámetros**: ninguno.

**Ejemplo de entrada**

```json
{}
```

**Ejemplo de salida** — `content`:

```markdown
## Dimensiones PESTEL

- **P · Político** (`political`): 214 señales
- **E · Económico** (`economic`): 331 señales
- **S · Social** (`social`): 502 señales
- **T · Tecnológico** (`technological`): 806 señales
- **E · Ambiental** (`environmental`): 88 señales
- **L · Legal** (`legal`): 173 señales
```

**Extracto de `structuredContent`**

```json
{
  "data": [
    { "key": "political", "letter": "P", "label": "Político", "signalCount": 214 },
    { "key": "technological", "letter": "T", "label": "Tecnológico", "signalCount": 806 }
  ],
  "meta": { "nextCursor": null, "hasMore": false, "count": 6, "generatedAt": "2026-08-25T14:37:20.995Z" }
}
```

**Cuándo usar esta y no aquella**: para conocer las seis claves válidas del
parámetro `pestel` de `list_signals`, o para responder "qué tan cargado está el
mapa hacia lo legal vs. lo tecnológico".

---

### `get_corpus_overview`

Conteos del banco, rango de fechas, última corrida y las constantes reales del
modelo.

> LLAMA A ESTA TOOL PRIMERO si no sabes el tamaño ni la actualidad del corpus. Devuelve conteos (señales, temas vivos/fósiles, macro-temas, aristas, categorías, snapshots), el rango de fechas cubierto, cuándo corrió el grafo por última vez y las constantes reales del modelo (vida media de 30 días, umbral de muerte 1.0, umbral de arista 0.55, entre otras) — así no las inventas ni las das por hecho.

**Parámetros**: ninguno.

**Ejemplo de entrada**

```json
{}
```

**Ejemplo de salida** — `content`:

```markdown
## Resumen de tu banco de señales

- **Señales**: 452
- **Temas vivos**: 27
- **Temas fósiles**: 41
- **Macro-temas**: 9
- **Aristas del grafo**: 6294
- **Categorías**: 4
- **Snapshots**: 214

- **Rango de fechas** (`likedAt`, estimado): ~4 mar 2026 — ~25 ago 2026
- **Última corrida del grafo**: 25 ago 2026, 06:00 UTC

**Constantes del modelo**
- Vida media de la vitalidad: 30 días
- Vida media de señales huérfanas: 15 días (mitad de la vida media normal)
- Umbral de muerte de un tema (vitalidad suma): < 1
- Umbral de arista del grafo (coseno): > 0.55
- Tamaño mínimo para ser tema: 3 señales
- Máximo de macro-temas por horizonte: 5

_generado 25 ago 2026, 14:38 UTC_
```

**Extracto de `structuredContent`**

```json
{
  "data": {
    "counts": { "publishedSignals": 452, "themesAlive": 27, "themesDead": 41, "macroThemes": 9, "links": 6294, "categories": 4, "snapshots": 214 },
    "lastGraphRunAt": "2026-08-25T06:00:11.402Z",
    "domain": { "halfLifeDays": 30, "orphanHalfLifeDays": 15, "deadThreshold": 1, "linkThreshold": 0.55, "minThemeSize": 3, "maxMacroPerHorizon": 5 }
  }
}
```

**Cuándo usar esta y no aquella**: es la tool de orientación, para no arrancar a
ciegas sobre tamaño o actualidad del corpus, ni inventar constantes del modelo. No
sustituye a `explain_foresight_term` cuando la duda es conceptual en vez de
numérica.

> **Nota de implementación**: esta tool NO reutiliza `formatMeta` de
> `src/format/shared.ts` — ese `formatMeta` formatea el **envelope** `ApiMeta`
> (el pie "N resultados · generado…" de un listado paginado), no el `MetaDTO`
> de `/meta` que necesita esta tool. El markdown se compone directamente en
> `src/tools/taxonomy.ts` (función `renderCorpusOverview`) con los helpers de
> fecha que `shared.ts` sí exporta.

---

## 6. Tool de grafo

*(`src/tools/graph.ts`)*

### `get_graph`

El grafo semántico completo (nodos + aristas) de las señales del banco.

> El grafo semántico completo (nodos + aristas) de las señales de tu banco: es la estructura de la que se derivan los temas. Para lectura normal ("qué está pasando", "qué temas hay") es mejor usar temas y horizontes — esta tool es para análisis ESTRUCTURAL del mapa (densidad de conexión, huérfanas, tamaño real del grafo). El servidor puede recortar el resultado con `limit`: **si la respuesta viene marcada como truncada, dilo explícitamente al usuario** — un agente que recibe, por ejemplo, 500 nodos de un grafo de 3000 sin saberlo saca conclusiones falsas sobre la estructura completa del mapa.

**Parámetros**

| Parámetro | Tipo | Obligatorio | Default | Qué hace |
|---|---|---|---|---|
| `horizon` | `"H1"\|"H2"\|"H3"` | no | — | Acota el grafo a un horizonte. |
| `min_vitality` | number | no | — | Solo nodos con esta vitalidad mínima. |
| `min_score` | number | no | `0.55` | Solo aristas con este score coseno mínimo. |
| `limit` | integer | no | `500` | Tope de nodos a devolver (máx. 2000). Si el grafo real tiene más, la respuesta viene truncada (avísalo). |

**Ejemplo de entrada**

```json
{ "horizon": "H2", "min_score": 0.7, "limit": 3 }
```

**Ejemplo de salida** — `content`:

```markdown
## Grafo semántico

- **Nodos**: 3
- **Aristas**: 3
- **Temas vivos**: 9
- **Temas fósiles**: 41
- **Huérfanas**: 0
```

Con un `limit` menor al tamaño real del grafo, `meta.truncated` viene `true` y el
markdown añade:

```markdown

_Nota: el resultado se recortó al límite de nodos pedido; hay más señales en el mapa de las que se muestran aquí._
```

**Extracto de `structuredContent`**

```json
{
  "data": {
    "nodes": [
      { "id": "c7f3a914-20bc-4d4c-9c51-940f372e0d8a", "vitality": 0.87, "themeId": "4e9b1c72-8a30-4f11-b8d6-2c5a7e0d91f4", "horizon": "H2" }
    ],
    "edges": [
      { "a": "9b21e0d4-5f7a-4c88-91b3-6ea0c4f27d15", "b": "c7f3a914-20bc-4d4c-9c51-940f372e0d8a", "score": 0.8123, "strength": "fuerte" }
    ],
    "stats": { "nodes": 3, "edges": 3, "themesAlive": 9, "themesDead": 41, "orphans": 0 }
  },
  "meta": { "generatedAt": "2026-08-25T14:37:55.410Z" }
}
```

**Cuándo usar esta y no aquella**: `get_graph` es para **análisis estructural**
del mapa — contar aristas, medir densidad de conexión, encontrar huérfanas,
auditar el tamaño real. Para lectura normal ("qué está pasando", "qué temas hay")
`list_themes` y las tools de horizontes son mejores: no vuelcan miles de nodos en
la respuesta, ya vienen agrupados y resumidos.

---

## 7. Tools de snapshots

*(`src/tools/snapshots.ts`)*

Un **snapshot** es una foto completa del mapa en un momento: todos los temas, su
estado y (si se pide) su membresía exacta. Se crea en cada corrida del grafo.

### `list_snapshots`

Lista las corridas del grafo.

> Lista las corridas del grafo (snapshots), una por cada vez que se recalculó el mapa. Cada snapshot es una foto completa del estado en ese momento: temas vivos, fósiles, huérfanas, nodos, aristas. Con dos o más snapshots comparados se ve la evolución del mapa. Para la evolución de UN tema en particular usa `get_theme_history`, que ya hace ese trabajo sin iterar snapshots a mano.

**Parámetros**

| Parámetro | Tipo | Obligatorio | Default | Qué hace |
|---|---|---|---|---|
| `from` | string | no | — | Desde esta fecha (`YYYY-MM-DD` o ISO), sobre `takenAt`. |
| `to` | string | no | — | Hasta esta fecha (`YYYY-MM-DD` o ISO), inclusive. |
| `limit` | integer | no | `25` | Cuántos traer (1-100). |
| `cursor` | string | no | — | Cursor opaco de la página anterior. No lo construyas a mano. |

**Ejemplo de entrada**

```json
{ "from": "2026-08-23", "limit": 2 }
```

**Ejemplo de salida** — `content`:

```markdown
## Snapshots

- 25 ago 2026, 06:00 UTC (`f2c81d47-6b39-4e05-a71c-90d3e5f8b264`, cron): 1483 nodos, 6294 aristas, 27 vivos / 41 fósiles, 112 huérfanas
- 23 ago 2026, 18:41 UTC (`0a5e73b1-c418-4d92-86f0-27ad9c1e4b58`, publish): 1479 nodos, 6251 aristas, 27 vivos / 41 fósiles, 115 huérfanas

Siguiente página: cursor=djF8MjAyNi0wOC0yM1QxODo0MTo1Mi42NjdafDBhNWU3M2IxLWM0MTgtNGQ5Mi04NmYwLTI3YWQ5YzFlNGI1OA
```

**Extracto de `structuredContent`**

```json
{
  "data": [
    { "id": "f2c81d47-6b39-4e05-a71c-90d3e5f8b264", "takenAt": "2026-08-25T06:00:11.402Z", "trigger": "cron", "nodes": 1483, "themesAlive": 27, "themesDead": 41 }
  ],
  "meta": { "nextCursor": "djF8...", "hasMore": true, "count": 2, "total": 214, "generatedAt": "2026-08-25T14:38:11.070Z" }
}
```

**Cuándo usar esta y no aquella**: para ver la evolución del **mapa completo**
comparando dos o más corridas. Cuando el interés es un solo tema, no hace falta
iterar snapshots a mano: `get_theme_history` ya hace ese trabajo.

---

### `get_snapshot`

Una corrida concreta del grafo: el estado de todos los temas en ese momento.

> Una corrida concreta del grafo: el estado de todos los temas en ese momento (tamaño, vitalidad, estado vivo/fósil). Con `include_members:true` trae además la membresía exacta (qué señal estaba en qué tema), útil para auditar el linaje o reconstruir qué pasó en una fecha pasada — pero está topada a 5000 filas por el servidor: **si la respuesta viene truncada, dilo explícitamente**, no presentes una membresía parcial como si fuera completa.

**Parámetros**

| Parámetro | Tipo | Obligatorio | Default | Qué hace |
|---|---|---|---|---|
| `snapshot_id` | string | **sí** | — | El id del snapshot. |
| `include_members` | boolean | no | `false` | Si `true`, incluye la membresía fila por fila (tope de 5000). |

**Ejemplo de entrada**

```json
{ "snapshot_id": "f2c81d47-6b39-4e05-a71c-90d3e5f8b264", "include_members": true }
```

**Ejemplo de salida** — `content`:

```markdown
## Snapshot del 25 ago 2026, 06:00 UTC

- **id**: `f2c81d47-6b39-4e05-a71c-90d3e5f8b264`
- **Disparado por**: cron
- **Nodos**: 1483
- **Aristas**: 6294
- **Temas vivos**: 27
- **Temas fósiles**: 41
- **Huérfanas**: 112

**Temas en esta corrida**
- Responsabilidad legal de los agentes autónomos: vivo, 4.12 (viva)
- Duelo y memoria con modelos de lenguaje: vivo, 1.63 (estable)
- Chatbots de atención al cliente de primera generación: fósil, 0.41 (apagándose)

**Membresía**: 3 filas
```

**Extracto de `structuredContent`**

```json
{
  "data": {
    "id": "f2c81d47-6b39-4e05-a71c-90d3e5f8b264",
    "themes": [
      { "themeId": "4e9b1c72-8a30-4f11-b8d6-2c5a7e0d91f4", "status": "alive", "vitality": 4.12, "horizon": "H2" }
    ],
    "members": [
      { "itemId": "c7f3a914-20bc-4d4c-9c51-940f372e0d8a", "themeId": "4e9b1c72-8a30-4f11-b8d6-2c5a7e0d91f4", "vitality": 0.87 }
    ]
  },
  "meta": { "count": 3, "truncated": false, "generatedAt": "2026-08-25T14:38:44.826Z" }
}
```

**Cuándo usar esta y no aquella**: para auditar el linaje o reconstruir el estado
exacto del mapa en una fecha concreta, sobre todo con `include_members: true`.
Cuando el interés es la serie temporal (varias corridas) en vez de una sola foto,
`list_snapshots` para el resumen o `get_theme_history` si el foco es un tema.

---

## 8. Tool de método

*(`src/tools/domain.ts`)*

### `explain_foresight_term`

Explica un término del método de foresight. Es LOCAL: no toca la red, resuelve
contra el glosario embebido en el propio paquete (`src/domain/glossary.ts`, 25
entradas).

> Explica un término del método de foresight (señal, tema, vitalidad, fósil, horizonte, velocidad, densidad, conectividad, novedad, puente, macro-tema, PESTEL, snapshot, huérfana, entre otros: 25 términos en total). ÚSALA PARA EXPLICAR BIEN EL MAPA EN VEZ DE INVENTAR LA DEFINICIÓN — evita, por ejemplo, decir 'tema eliminado' cuando la palabra correcta del dominio es 'fósil' (un tema fósil no se borra: se conserva íntegro y puede resucitar). No hace ninguna llamada de red: resuelve en local contra el glosario del servidor.

**Parámetros**

| Parámetro | Tipo | Obligatorio | Default | Qué hace |
|---|---|---|---|---|
| `term` | enum (25 claves) | **sí** | — | La clave del término a explicar (ej. `vitalidad`, `fosil`, `H2`). |

**Ejemplo de entrada**

```json
{ "term": "fosil" }
```

**Ejemplo de salida** — `content`:

```markdown
## Fósil (tema muerto)

> Un tema cuya vitalidad suma cayó bajo 1.0 y pasó a estado 'dead', pero se preserva en la base de datos.

Un **fósil** es un tema que murió: su vitalidad total (suma de vitalidad de sus
miembros) cayó por debajo de 1.0. Pasa a `status: 'dead'` y se oculta en la UI
por defecto (toggle "mostrar fósiles").

**OJO**: un fósil **no es un tema borrado**. La fila sigue en la DB, con su id,
sus miembros guardados en `lastMemberIds`, su historia en snapshots. Es un
archivo, no una desaparición.

**Resurrección**: si una nueva señal entra con vitalidad ≥ 1.0 y se empareja por
linaje con el fósil, el fósil resucita automáticamente. Se cuenta el ciclo en
`revivedCount`.

**Constantes reales:**
- **Vitalidad para morir**: `< 1.0` (DEAD_THRESHOLD (src/lib/jobs/graph.ts))

**Relacionado:** tema, vitalidad, resurrección, linaje
```

**Extracto de `structuredContent`**

```json
{
  "data": {
    "key": "fosil",
    "term": "Fósil (tema muerto)",
    "short": "Un tema cuya vitalidad suma cayó bajo 1.0 y pasó a estado 'dead', pero se preserva en la base de datos.",
    "related": ["tema", "vitalidad", "resurrección", "linaje"]
  }
}
```

**Cuándo usar esta y no aquella**: para redactar sobre el mapa con el vocabulario
correcto del dominio en vez de improvisar sinónimos que llevan a error ("tema
eliminado", "puntaje de similitud del 81%"). No toca la red — a diferencia de
todas las demás tools de este documento, no puede fallar por la API caída ni por
rate limit.

---

## 9. Resources

*(`src/resources/index.ts`)*

A diferencia de las tools (pensadas para que un agente las llame solo), un
**resource** existe para que una persona lo adjunte a mano como contexto en un
cliente como Claude Desktop o Cursor. El contenido es el mismo markdown legible
que producen las tools: reusan `src/format/` en vez de inventar un formato nuevo.

| Nombre | URI | ¿Plantilla? | Qué lista (`list`) | Qué devuelve (`read`) |
|---|---|---|---|---|
| `foresight-overview` | `foresight://overview` | No | — | Conteos, rango de fechas y constantes del modelo (`/meta`). La puerta de entrada al banco. |
| `foresight-glossary` | `foresight://glossary` | No | — | El glosario completo del dominio en markdown. Sin red: siempre disponible, aunque la API esté caída. |
| `foresight-horizons` | `foresight://horizons` | No | — | El panorama de los tres horizontes con sus macro-temas (igual que `get_horizons_overview`). |
| `foresight-signal` | `foresight://signal/{id}` | Sí | **Sin listado** (`list: undefined`) — el corpus de señales es demasiado grande para un selector. | La ficha completa de una señal (igual que `get_signal`). |
| `foresight-theme` | `foresight://theme/{id}` | Sí | Hasta 100 temas **vivos**, ordenados por vitalidad. Los fósiles no se listan (saturarían el selector), pero sí se pueden leer por id directo. | Ficha del tema + hasta 25 de sus señales más vitales. |
| `foresight-horizon` | `foresight://horizon/{key}` | Sí | Los tres horizontes, con su `labelShort` real. `complete` resuelve `H1`/`H2`/`H3` en local, sin red (son un catálogo fijo). | Un horizonte con todos sus temas vivos (igual que `get_horizon`). |
| `foresight-macro-theme` | `foresight://macro-theme/{id}` | Sí | Hasta 15 macro-temas vigentes (≤5 por horizonte × 3 horizontes), sin paginar. | Un macro-tema con sus temas miembro. Si el id ya no existe (recreado en una corrida posterior), devuelve un mensaje explicando que los ids de macro-tema no son estables, en vez de un error. |

Notas de implementación relevantes:

- Ningún resource tiene el canal `isError` de una tool: un fallo de red en una
  **lectura** se degrada al propio contenido devuelto (el mensaje accionable de
  `T4FApiError.messageForModel()`, con `mimeType: "text/plain"`), en vez de
  reventar la llamada.
- Un fallo de red en un **listado** (`list` de una plantilla) no puede usar ese
  mismo mecanismo — el SDK concatena el `resources/list` de todas las plantillas
  en una sola respuesta, así que un solo `list` que lance tira el listado entero.
  Se degrada silenciosamente a "sin candidatos" (`{ resources: [] }`) y el error
  queda en `stderr` para diagnóstico.
- `foresight-glossary` es el único resource verdaderamente sin red: no pasa por
  `guardedRead` porque `renderGlossaryMarkdown()` es una función pura sobre datos
  embebidos.

---

## 10. Prompts

*(`src/prompts/index.ts`)*

**Un prompt no da ninguna capacidad extra.** No puede hacer nada que las tools de
arriba no hagan ya, y el servidor sigue siendo de solo lectura de punta a punta.
Lo que aporta cada prompt es un **guion**: el orden correcto de llamadas para una
pregunta que se repite, para que cada persona (o cada sesión) no lo reinvente. Los
seis inyectan primero el mismo bloque fijo de reglas del dominio (`likedAt` con
`~`, "fósil" no "eliminado", `strength` no `score` al redactar, ids de macro-tema
no estables, `publishStatus` es un dato y no un filtro, y consultar
`explain_foresight_term` ante la duda) y después la secuencia de pasos específica.

| Nombre | Argumentos | Qué guion arma |
|---|---|---|
| `analizar_horizonte` | `horizonte` (string: `H1`, `H2` o `H3`) | `get_horizon` → detectar los 3 temas de mayor velocidad → `get_theme_history` de esos 3 → `list_theme_signals` de los opacos. Cierra con qué madura, qué se apaga y qué sorprende. |
| `informe_de_tema` | `tema` (id o nombre) | Localiza con `list_themes` si hace falta → `get_theme` → `list_theme_signals` por vitalidad → `get_theme_history` → si hay conectividad alta, `get_signal_neighbors` sobre una señal central. Arma un informe: qué es · por qué importa · señales clave · trayectoria · con qué hace puente · qué vigilar. |
| `radar_semanal` | `dias` (string opcional, default `"7"`) | `get_corpus_overview` (avisa si el mapa está desactualizado) → `list_signals` desde hace N días → `list_snapshots` del periodo + `get_snapshot` del más antiguo y el más reciente → compara. Cierra con tres listas: **entró**, **se movió**, **se apagó**. |
| `senales_debiles` | `categoria` (string opcional) | `get_horizon` con `H3` → `get_theme` de los de mayor **novedad** aunque sean chicos → `list_theme_signals` de los prometedores → `get_signal_neighbors` sobre una señal suelta por si conecta con H1/H2. Para cada candidata: qué es, por qué podría importar, qué la haría crecer, qué la mataría. |
| `comparar_temas` | `tema_a`, `tema_b` (id o nombre, ambos obligatorios) | Localiza ambos con `list_themes` si hace falta → `get_theme` de cada uno → `get_theme_history` de los dos → `list_theme_signals` + `get_signal_neighbors` para encontrar los puentes entre ambos. Cierra con una tabla comparativa de indicadores. |
| `explorar_desde_senal` | `senal` (id o texto para buscarla) | Localiza con `search_signals` si hace falta → `get_signal` → `get_signal_neighbors` (primer salto) → `get_signal_neighbors` de los 2-3 vecinos más cercanos (segundo salto) → `get_theme` de los temas que aparezcan. Narra el recorrido; cercanía siempre en fuerte/media/débil, nunca en porcentaje. |

---

## 11. Errores

Cuando la llamada a la API pública falla, la tool **no lanza una excepción de
protocolo MCP**: `guarded()` en `src/tools/context.ts` atrapa cualquier fallo y lo
traduce a un **error de tool**, `{ content: [{ type: "text", text: <mensaje> }],
isError: true }`. La diferencia importa — una excepción corta la conversación de
golpe; un error de tool vuelve al modelo como cualquier otro resultado, y el
modelo puede leer el mensaje, entender qué hacer y corregir el rumbo (pedir otro
id, esperar, avisar al usuario de una clave rota) en vez de simplemente fallar.

El texto exacto que recibe el modelo sale de `T4FApiError.messageForModel()`
(`src/client/errors.ts`), según el status HTTP devuelto por la API:

| Status | Mensaje literal para el modelo |
|---|---|
| `401` | `La API key de tools4foresight es inválida, fue revocada o falta. Es la clave que identifica TU banco de señales: revísala en la cabecera Authorization de tu cliente MCP, o genera una nueva en /perfil. No reintentes.` |
| `403` | `tools4foresight rechazó el acceso con esa clave. No reintentes: no es un problema pasajero. (Ojo: pedir algo de otro banco NO da 403, da 404.)` |
| `404` | `No existe ese id en tu banco de señales. Usa list_signals o list_themes para obtener ids válidos.` — también es lo que se recibe al pedir un id que existe en el banco de **otra persona**: la API responde 404, nunca 403 (ver `SECURITY.md`). |
| `429` | `Límite de peticiones alcanzado. Espera unos segundos antes de volver a pedir.` |
| `400` | `` Parámetro inválido ("<param>"): <mensaje de la API>. Corrige el argumento de la tool y vuelve a intentar. `` |
| `503` | `La API pública de tools4foresight está deshabilitada temporalmente del lado del servidor. No es un problema de tu petición; intenta más tarde.` |
| `5xx` (cualquiera) | `` tools4foresight no respondió correctamente (HTTP <status>). Ya se reintentó <attempts> veces. `` |
| sin respuesta (red caída / timeout) | `` tools4foresight no respondió (error de red[/timeout]). Ya se reintentó <attempts> veces. Si persiste, informa al usuario que el servicio podría estar caído. `` |
| Otro status no cubierto | `` tools4foresight devolvió un error inesperado (HTTP <status>): <mensaje>. `` |

Solo se reintentan automáticamente `429`, los `5xx` y los errores de red/timeout
(`isRetryable()` en `src/client/errors.ts`); un `401`/`403`/`400`/`404` nunca se
reintenta del lado del cliente HTTP, porque el problema no lo va a resolver
insistir — es una credencial mala, un permiso insuficiente o un parámetro/id
incorrecto, no un fallo de transporte pasajero.

---

## 12. Convenciones de la salida

Reglas de presentación que atraviesan todas las tools, centralizadas en
`src/format/shared.ts` para que no se escriban de dos formas distintas en dos
sitios:

- **`~` en toda fecha `likedAt`** (y en cualquier fecha derivada de ella, como
  `lastSignalAt` de un tema): `~25 ago 2026`, nunca sin la virgulilla. La API de X
  no expone cuándo ocurrió un like, solo el orden — `likedAt` es una estimación
  acotada, y el `~` es el recordatorio permanente de esa incertidumbre.
  `tweetCreatedAt` y `publishedAt` (la fecha de revisión), en cambio, sí son exactas y se muestran **sin**
  `~` (`formatDate`, no `formatEstimatedDate`).
- **"fósil" en vez de "muerto"**: un tema con `status: 'dead'` se presenta siempre
  como "fósil" (`formatThemeStatus`). Nunca "eliminado", nunca "muerto" a secas —
  ambos sugieren un borrado que no ocurrió: el tema conserva id, nombre, historia
  y `lastMemberIds`, y puede resucitar.
- **Vitalidad con 2 decimales y etiqueta cualitativa**: `4.12 (viva)`, `0.87
  (casi extinta)` (`formatVitality`). Los cortes son `>= 2` viva, `>= 1` estable,
  `>= 0.15` apagándose, y por debajo "casi extinta" — la misma escala sirve tanto
  para la vitalidad de una señal (0..1, decae `0.5^(días/30)`) como para la de un
  tema (suma sin techo de sus miembros).
- **Horizonte con su etiqueta real**: `H2 · en transición`, nunca solo `H2`
  (`formatHorizonLabel`, que la extrae de `GLOSSARY['H2'].term` — una sola fuente
  de verdad, el glosario, para que la etiqueta no se reinvente en dos archivos).
  Cuando el DTO ya trae `labelShort`/`labelLong` propios (`HorizonDTO`), se usan
  esos directamente en vez de reconstruirlos.
- **El markdown nunca muestra el `%` de similitud, aunque `score` sí viaje en
  `structuredContent`.** Es la regla de §7 de `docs/API.md`: un coseno como
  "0.63" leído por una persona se interpreta como una medida de precisión que no
  tiene — es un promedio sobre embeddings de 768 dimensiones de textos ya
  resumidos por un modelo, y comparaciones tipo "este par tiene 4 puntos más que
  aquel" no significan nada. Por eso el markdown de `get_signal_neighbors` y de
  cualquier salida que involucre vecinos o aristas solo usa `strength`
  (fuerte/media/débil, con acento al mostrarla aunque el DTO use `"debil"` en
  ASCII). El `score` crudo sigue viajando en `structuredContent` porque un
  **agente** sí lo necesita: para ordenar, para poner su propio umbral, para
  decidir si un segundo salto en el grafo vale la pena. Es una regla de
  presentación hacia personas, no de ocultar el dato — por eso hay un test
  (`tests/format.test.ts`) que verifica que ningún `%` ni decimal de similitud
  se cuele en ese markdown.

---

## 13. Criterio de `outputSchema`

**Ninguna de las 18 tools declara `outputSchema`.** Se verificó contra el código:
`grep -rn "outputSchema" src/` no devuelve ninguna coincidencia en todo el
repositorio — ni en `src/tools/*.ts` ni en ningún otro módulo.

El motivo, consistente con cómo están construidas las 18: todas devuelven una
**lista paginada** (`list_signals`, `search_signals`, `list_themes`,
`list_theme_signals`, `list_macro_themes`, `list_categories`,
`list_pestel_dimensions`, `list_snapshots`, `get_horizons_overview`) o un
**detalle cuya forma exacta puede variar según parámetros opcionales**
(`get_snapshot` con `include_members`, cuya clave `members` está presente solo a
veces; `get_graph`, cuyo tamaño de `nodes`/`edges` depende de `limit`;
`get_theme`, cuyos campos de indicadores pueden venir `null`). Fijar un
`outputSchema` formal ataría al cliente MCP a la forma exacta de un DTO que:

- puede ganar campos opcionales sin romper compatibilidad (docs/API.md §1.3:
  `v1` está congelado, pero agregar un campo opcional a un DTO es un cambio
  compatible que no sube de versión), y
- en el caso de las listas, ya lleva su propia validación de forma en runtime vía
  el cliente HTTP tipado (`src/client/http-client.ts` contra `src/client/types.ts`)
  y en los tests de contrato.

En su lugar, el contrato de salida se documenta por convención uniforme:
`content[0].text` siempre es markdown, y `structuredContent` siempre existe y
contiene `{ data, meta }` en las tools de lista, o `{ data }` en las de detalle
(`toolResult()`, `src/tools/context.ts`) — la misma forma que ya usa el envelope
de la API pública (`ApiListResponse<T>` / `ApiItemResponse<T>` de
`src/client/types.ts`), sin necesidad de repetirla en un `outputSchema` de JSON
Schema por tool.
