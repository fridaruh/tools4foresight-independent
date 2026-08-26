# API pública read-only de tools4foresight — `/api/public/v1`

> **Este documento es el contrato entre los dos repos.**
> Los route handlers viven en `tools4foresight` (`src/app/api/public/v1/**`); el cliente
> que los consume vive en `MCP_T4F_Multitenant` (`src/client/`). Si `src/client/types.ts`
> y este documento divergen, **manda este documento**.
>
> Versión del contrato: `v1` — heredado del contrato single-tenant de `x-likes-curator`
> (hoy `tools4foresight`), con las diferencias multi-tenant marcadas a lo largo del
> documento.
>
> **Verificado contra la implementación real** (`tools4foresight/src/app/api/public/v1/**`,
> `src/lib/public-dto.ts`, `public-query.ts`, `public-api-response.ts`, `public-api-auth.ts`,
> `public-cursor.ts`, `public-rate-limit.ts`, `public-horizons.ts`), no solo contra el plan.
> Los 17 handlers ya están escritos y en verde. Lo poco que no se pudo verificar contra
> código queda marcado explícitamente como «PENDIENTE DE CONFIRMAR» en el punto exacto
> donde aplica — no hay una advertencia general para todo el documento.

---

## Tabla de contenidos

1. [Introducción](#1-introducción)
   - [1.1 Qué expone](#11-qué-expone)
   - [1.2 Qué NO expone (lista negra)](#12-qué-no-expone-lista-negra)
   - [1.3 Base URL y versionado](#13-base-url-y-versionado)
2. [Autenticación](#2-autenticación)
3. [Convenciones generales](#3-convenciones-generales)
   - [3.1 Envelope de respuesta](#31-envelope-de-respuesta)
   - [3.2 Paginación por cursor](#32-paginación-por-cursor)
   - [3.3 Fechas](#33-fechas)
   - [3.4 Cabeceras de respuesta y caché](#34-cabeceras-de-respuesta-y-caché)
   - [3.5 CORS](#35-cors)
   - [3.6 Rate limiting](#36-rate-limiting)
   - [3.7 Tipos y parseo de parámetros](#37-tipos-y-parseo-de-parámetros)
4. [Endpoints](#4-endpoints)
   - [4.1 `GET /meta`](#41-get-meta)
   - [4.2 `GET /health`](#42-get-health)
   - [4.3 `GET /signals`](#43-get-signals)
   - [4.4 `GET /signals/{id}`](#44-get-signalsid)
   - [4.5 `GET /signals/{id}/neighbors`](#45-get-signalsidneighbors)
   - [4.6 `GET /themes`](#46-get-themes)
   - [4.7 `GET /themes/{id}`](#47-get-themesid)
   - [4.8 `GET /themes/{id}/signals`](#48-get-themesidsignals)
   - [4.9 `GET /themes/{id}/history`](#49-get-themesidhistory)
   - [4.10 `GET /macro-themes`](#410-get-macro-themes)
   - [4.11 `GET /horizons`](#411-get-horizons)
   - [4.12 `GET /horizons/{key}`](#412-get-horizonskey)
   - [4.13 `GET /categories`](#413-get-categories)
   - [4.14 `GET /pestel`](#414-get-pestel)
   - [4.15 `GET /graph`](#415-get-graph)
   - [4.16 `GET /snapshots`](#416-get-snapshots)
   - [4.17 `GET /snapshots/{id}`](#417-get-snapshotsid)
5. [DTOs](#5-dtos)
6. [Errores](#6-errores)
7. [`score` vs `strength`](#7-score-vs-strength)
8. [Notas para quien implementa](#8-notas-para-quien-implementa)

---

## 1. Introducción

`/api/public/v1` es una API **HTTP, JSON, de solo lectura y multi-tenant** sobre el banco de
señales de una persona: sus señales curadas (artículos y tweets guardados como indicios de
futuro), los temas semánticos que forman entre ellas, los horizontes en los que caen, y la
serie temporal de cómo todo eso cambia corrida a corrida.

**No hay un acervo común.** La API key no es un permiso para leer un contenido compartido:
**es la identidad del banco**. Resuelve a un `ownerId` y todo lo que se lee pasa por
`withOwner(ownerId, …)`, sobre tablas protegidas con Row-Level Security en Postgres. Dos
claves distintas ven dos universos disjuntos.

Su único consumidor previsto es el servidor MCP `mcp-t4f-multitenant`, que la traduce a
tools para un agente. No es una API de escritura, no es una API de usuarios, y no es
pública en el sentido de "sin credencial": toda petición exige una API key porque sin ella
no hay dueño y, por tanto, no hay nada que leer.

### 1.1 Qué expone

- **Todas las señales del banco del dueño de la clave**, sin filtrar por estado de
  curaduría, con su ficha de análisis: TL;DR, por qué importa, impacto, categoría,
  dimensiones PESTEL, vitalidad y `publishStatus`.

  > **Cambio respecto al contrato single-tenant.** Allí la API servía solo
  > `publishStatus = 'published'` y el campo estaba en la lista negra. Aquí la persona ES
  > la curadora de su banco: ve el 100% de su material y `publishStatus` viaja como dato
  > útil («esto ya lo revisé»), filtrable con `?publishStatus=` (ver [§4.3](#43-get-signals)).
  > Confirmado en `public-dto.ts` (`SignalSummaryDTO.publishStatus`, siempre presente) y
  > `public-query.ts` (`parsePublishStatusParam`).
- **Etiquetas libres (`tags`)** por señal: 3 a 5 palabras que genera el pipeline al
  analizarla. Es contenido curado, del mismo tipo que `category`/`pestel`, pensado para que
  un agente filtre sin tener que leer el texto entero. Vacío si la señal todavía no pasó por
  el pipeline. No hay parámetro de filtro por `tags` en `v1`.
- **Temas** (clusters semánticos con linaje): nombre, resumen, estado vivo/fósil,
  tamaño, vitalidad, horizonte e indicadores (velocidad, densidad, conectividad, novedad).
- **Macro-temas**: agrupación de segundo nivel, máximo 5 por horizonte.
- **Horizontes** H1/H2/H3 con sus etiquetas y agregados.
- **Taxonomía**: catálogo de categorías y las seis dimensiones PESTEL, con conteos.
- **Grafo semántico**: nodos (señales) y aristas (similitud coseno entre pares).
- **Snapshots**: una foto por corrida del grafo, con el estado de cada tema en ese momento.
- **Metadatos del banco**: conteos, rango de fechas, última corrida y las constantes del modelo.

### 1.2 Qué NO expone (lista negra)

Esta lista es normativa. **Ningún endpoint de `v1` devuelve, hoy ni nunca, nada de lo
siguiente.** Si un campo no aparece en un DTO de la [sección 5](#5-dtos), no sale por la API:
los DTOs son la frontera de seguridad, no un formato de conveniencia.

| Nunca se expone | Por qué |
|---|---|
| `users`, `sessions`, `accounts`, `verifications` | Datos de cuenta y autenticación de personas reales. |
| `ownerId` en cualquier DTO | El identificador del dueño no sale nunca. Es lo que impide correlacionar bancos o enumerarlos desde fuera. |
| `api_keys`, incluidos los hashes | Son credenciales. La tabla que resuelve la identidad no se expone jamás. |
| `favorites`, `feedback`, `onboarding_emails` | Actividad privada de miembros identificables. |
| `x_auth_tokens` | Credenciales de la API de X, aunque estén cifradas. |
| `prompt_settings` | Prompts internos del sistema de análisis. |
| `custom_field_definitions`, `liked_item_custom_fields` | Banco de trabajo privado del enriquecimiento: nombres libres que pueden contener notas internas. |
| `x_auth_tokens`, `user_secrets` | Credenciales de terceros, cifradas en la base. |
| La columna `embedding` (vector 768d) | 768 floats por señal; expone el modelo y no le sirve de nada a un agente. Todos los queries usan `select` explícito para no tocarla nunca. |
| Cualquier fila de otro dueño | Garantizado por `withOwner(ownerId, …)` + RLS. Un id ajeno responde **404, nunca 403** (ver §6). |
| `ingestion_cursor`, `like_rank`, `detectedAt`, `embeddingHash` | Fontanería de ingesta; sin valor para el lector y con información sobre el pipeline. |
| `categorySource`, `pestelSource`, `tldrSource`, `impactSource`, `whyMattersSource`, `membersHash` | Metadatos de proceso interno. |

### 1.3 Base URL y versionado

```
https://<dominio-del-despliegue-multi-tenant>/api/public/v1
```

⚠️ **PENDIENTE DE CONFIRMAR**: el dominio de producción del proyecto de Vercel
`tools4foresight-app` todavía no está fijado. Por eso el servidor MCP exige
`T4F_API_BASE_URL` **sin valor por defecto** (ver `docs/ARCHITECTURE.md`).

En desarrollo: `http://localhost:3000/api/public/v1`.

- El namespace lleva la versión en la ruta: `/api/public/v1/...`.
- **`v1` está congelado.** Agregar un campo **opcional** a un DTO, o un query param nuevo
  con default que preserve el comportamiento, es compatible y no sube versión.
- **Cualquier cambio rompiente** —renombrar o quitar un campo, cambiar el tipo de uno,
  cambiar el default de un parámetro, cambiar la forma del envelope— exige `/api/public/v2`.
  `v1` no cambia bajo los pies de nadie.
- Toda respuesta lleva la cabecera `X-T4F-Api-Version: v1`, y los envelopes de error
  llevan `meta.apiVersion`.
- Solo se aceptan los verbos `GET` y `OPTIONS`. Cualquier otro verbo recibe **405**
  (lo genera Next.js automáticamente al no existir el handler).

---

## 2. Autenticación

Toda petición exige una API key en la cabecera `Authorization`:

```
Authorization: Bearer <api-key>
```

**La clave no autoriza: identifica.** Resuelve a un `ownerId`, y ese `ownerId` es lo que
determina qué universo de datos existe para esa petición. No hay contenido que se lea "sin
dueño", así que no hay forma de que una petición no autenticada devuelva nada.

### Cómo se genera una clave

Cada persona genera la suya en **`/perfil` → "Conecta tus agentes"** de la app. Sale una
sola vez, empieza por `t4f_` y va tal cual en la cabecera.

**No existen claves de entorno.** El contrato single-tenant permitía configurar claves de
servicio en `T4F_PUBLIC_API_KEYS`; aquí esa variable **se elimina**: una clave sin dueño no
tiene banco que leer, y mantenerla sería una puerta sin tenant. La única fuente de claves es
la tabla `api_keys`.

Del lado del servidor:

- Se almacena un **hash** de la clave, nunca la clave.
- El acceso es mínimo y sin gradiente: `la clave existe && !revokedAt && el usuario existe`
  → `ownerId`. **No hay paywall, ni Stripe, ni planes.** Confirmado en
  `resolveApiKey()` (`src/lib/api-keys.ts` de tools4foresight): el `include` del usuario
  solo comprueba que la fila siga ahí, nada de plan o suscripción.
- Tope de **10 claves activas por usuario** (`MAX_ACTIVE_KEYS`). No es una defensa de
  seguridad —el dueño ya tiene acceso a su propio banco— sino de higiene: una lista de 3
  claves se audita, una de 200 no. Las revocadas no cuentan contra el tope.
- Revocar una clave afecta solo a su dueña. No hay rotación coordinada.

### Comportamiento

| Situación | Status | `code` |
|---|---|---|
| Falta la cabecera `Authorization` o no tiene la forma `Bearer <clave>` | `401` | `unauthorized` |
| La clave no existe, fue revocada, o su usuario ya no existe | `401` | `invalid_api_key` |

No hay `503 api_disabled`: no queda ninguna variable de entorno de cuya presencia dependa
que la API atienda.

Los intentos con clave inválida **cuentan contra un rate limit por IP**. El límite general
se agrupa por **`ownerId`, no por clave**: si fuera por clave, cualquiera multiplicaría su
cuota generando claves.

```json
{
  "error": {
    "code": "unauthorized",
    "message": "Falta la cabecera Authorization: Bearer <tu API key de tools4foresight>.",
    "param": null
  },
  "meta": { "apiVersion": "v1", "generatedAt": "2026-08-25T14:32:10.884Z" }
}
```

---

## 3. Convenciones generales

### 3.1 Envelope de respuesta

**Listas** — envelope `{ data, meta }`, con `data` siempre un array:

```json
{
  "data": [ /* ... */ ],
  "meta": {
    "nextCursor": "djF8MjAyNi0wOC0xOFQwOToxNDoyMi4xMDNafGM3ZjNhOTE0LTIwYmMtNGQ0Yy05YzUxLTk0MGYzNzJlMGQ4YQ",
    "hasMore": true,
    "count": 25,
    "generatedAt": "2026-08-25T14:32:10.884Z"
  }
}
```

**Detalle** — mismo envelope, con `data` como **objeto plano**:

```json
{
  "data": { "id": "…", "name": "…" },
  "meta": { "generatedAt": "2026-08-25T14:32:10.884Z" }
}
```

Forma exacta de `meta`:

```ts
type ApiMeta = {
  /** Cursor opaco para pedir la página siguiente. `null` si no hay más. Ausente en detalle. */
  nextCursor: string | null;
  /** `true` si existe al menos una fila más después de esta página. Ausente en detalle. */
  hasMore: boolean;
  /** Número de elementos en `data` de ESTA página. Ausente en detalle. */
  count: number;
  /** Total de filas que casan con el filtro, ignorando la paginación. OPCIONAL:
      solo lo emiten los endpoints donde contar es barato. No asumas que viene. */
  total?: number;
  /** Momento en que el servidor armó la respuesta. Siempre presente, también en detalle y en errores. */
  generatedAt: string;
};
```

Reglas:

- `generatedAt` está **siempre**: en listas, en detalle y en errores.
- `nextCursor`, `hasMore` y `count` están **solo** en respuestas de lista.
- `total` es **opcional**. Un cliente correcto nunca lo da por hecho.
- Algunos endpoints añaden claves extra a `meta` (por ejemplo `truncated` en
  [`/snapshots/{id}`](#417-get-snapshotsid)). Un cliente debe ignorar las claves de `meta`
  que no conozca en vez de fallar.
- Una lista vacía es `{ "data": [], "meta": { "nextCursor": null, "hasMore": false, "count": 0, ... } }`
  con status **200**. La lista vacía no es un 404.

### 3.2 Paginación por cursor

La paginación es **keyset compuesto sobre `(likedAt, id)`**, con orden
`ORDER BY liked_at DESC, id DESC`. Se eligió sobre offset porque `likedAt` es una
estimación con empates frecuentes: un cursor de campo único se salta filas, y offset se
desordena entre páginas cuando entra contenido nuevo. El par `(likedAt, id)` sí es un
orden total y estable.

El cursor se serializa en **base64url** de la cadena `v1|<likedAt ISO>|<id>`:

```
v1|2026-08-18T09:14:22.103Z|c7f3a914-20bc-4d4c-9c51-940f372e0d8a
  → djF8MjAyNi0wOC0xOFQwOToxNDoyMi4xMDNafGM3ZjNhOTE0LTIwYmMtNGQ0Yy05YzUxLTk0MGYzNzJlMGQ4YQ
```

> **El cursor es OPACO.** Está documentado su formato para que quien implemente el servidor
> lo produzca bien, no para que un cliente lo construya, lo parsee ni lo interprete. Un
> cliente solo debe: leer `meta.nextCursor`, guardarlo tal cual, y devolverlo sin modificar
> en `?cursor=`. El prefijo `v1|` existe precisamente para poder cambiar el formato interno
> sin avisar. Un cursor construido a mano es un cursor roto.

- Se pide la página siguiente con `?cursor=<meta.nextCursor>` **manteniendo el resto de
  filtros idénticos**. Cambiar un filtro a mitad de paginación produce resultados sin sentido.
- `meta.nextCursor` es `null` **si y solo si** `meta.hasMore` es `false`.
- Un cursor que no decodifica, no lleva el prefijo `v1|`, no trae fecha ISO válida o no
  trae id → **400 `invalid_parameter`** con `param: "cursor"`.
- **Límites**: `limit` por defecto **25**, máximo **100**, salvo donde la tabla del
  endpoint diga otra cosa (`/signals/{id}/neighbors` topa en 50; `/graph` en 2000).
  Un `limit` no numérico, ≤ 0, o por encima del máximo → **400 `invalid_parameter`**.
  (Decisión: el máximo **no** se recorta en silencio; se rechaza, para que un cliente
  mal calibrado se entere en vez de creer que recibió todo.)

Los endpoints que ordenan por algo distinto de `likedAt` (`/themes?sort=vitality`, por
ejemplo) siguen usando el mismo cursor opaco: el servidor decide qué par de columnas
serializa. El cliente no cambia nada.

### 3.3 Fechas

- **Todas** las fechas son cadenas **ISO 8601 en UTC**, con milisegundos y sufijo `Z`:
  `"2026-08-18T09:14:22.103Z"`. Nunca hay offsets locales ni timestamps numéricos.
- Los parámetros `from` y `to` aceptan `YYYY-MM-DD` o ISO 8601 completo. `from` es
  **inclusivo** (`>=`); `to` es **inclusivo** (`<=`). Un `YYYY-MM-DD` en `from` se
  interpreta como el inicio del día UTC; en `to`, como el **final** del día UTC
  (`23:59:59.999Z`), para que `from=2026-08-01&to=2026-08-31` cubra agosto entero.
  Una fecha que no parsea → **400 `invalid_parameter`**.

#### `likedAt` es una ESTIMACIÓN

La API de X **no expone cuándo ocurrió un like**, solo el orden. `likedAt` es una
estimación acotada entre la fecha del tweet y el momento del polling que lo detectó.
Por eso:

- **`likedAtEstimated` viene SIEMPRE con el valor literal `true`.** No es un booleano que
  a veces sea `false`: es un recordatorio en el payload de que la fecha es aproximada.
  Está tipado como el literal `true` a propósito.
- `likedAtSource` dice cuánto se pudo acotar:
  - `"tweet_date"` — solo se acotó con la fecha del tweet (ítems históricos, estimación más floja).
  - `"ordered"` — además se acotó con la ventana entre corridas y el orden de likes (más ajustada).
- **Convención de presentación**: quien renderice `likedAt` para una persona debe
  anteponerle una virgulilla: `~18 ago 2026`. Nunca sin ella.
- **`tweetCreatedAt` sí es exacta**: se deriva del snowflake ID del tweet, sin costo de API.
  Se presenta **sin** virgulilla. Es `null` en señales de origen `manual` (no hay tweet detrás).
- El resto de fechas del sistema (`publishedAt`, `takenAt`, `firstSeenAt`, `diedAt`,
  `vitalityAt`, `contentPublishedAt`, `generatedAt`) son exactas.

### 3.4 Cabeceras de respuesta y caché

Toda respuesta `200` lleva:

```
Content-Type: application/json; charset=utf-8
Cache-Control: <según perfil>
X-T4F-Api-Version: v1
Vary: Authorization, Origin
X-RateLimit-Limit: 120
X-RateLimit-Remaining: 117
X-RateLimit-Reset: 1787755200
```

Perfiles de caché. `n` es `max-age`; `stale-while-revalidate` es siempre `2n`:

| Perfil | `Cache-Control` | Se usa en |
|---|---|---|
| `live` | `private, no-store` | `/health` (un health cacheado mentiría) y **todas** las respuestas de error. |
| `short` | `private, max-age=60, stale-while-revalidate=120` | `/meta`, `/signals`, `/signals/{id}` |
| `graph` | `private, max-age=300, stale-while-revalidate=600` | `/signals/{id}/neighbors`, `/themes*`, `/macro-themes`, `/horizons*`, `/graph`, `/snapshots` |
| `static` | `private, max-age=3600, stale-while-revalidate=7200` | `/categories`, `/pestel`, **y también `/snapshots/{id}`** |

Un snapshot es conceptualmente inmutable (una foto histórica, nunca cambia), pero `v1`
**no tiene un perfil de caché dedicado más largo para eso todavía**: `/snapshots/{id}`
reutiliza el mismo perfil `static` de 1 hora que `/categories` y `/pestel`
(`cacheControlFor()` en `public-api-response.ts` solo define cuatro perfiles: `live`,
`short`, `graph`, `static`). Un `max-age=86400` o una directiva `immutable` específica para
snapshots sería una mejora razonable, pero no es lo que hay hoy — no lo asumas.

**`private`, nunca `public`**: la respuesta depende de quién la pidió y ningún CDN
intermedio debe compartir una respuesta entre claves distintas. Por lo mismo, `Vary`
incluye `Authorization` siempre.

Las respuestas de error (4xx/5xx) llevan `Cache-Control: no-store`.

### 3.5 CORS

CORS está **apagado por defecto**. Se habilita solo si `T4F_PUBLIC_API_ALLOWED_ORIGINS`
tiene valores:

- Si el `Origin` de la petición está en la lista, se **refleja ese origen exacto** en
  `Access-Control-Allow-Origin`. **Nunca se responde `*`.**
- Si el `Origin` no está en la lista, o la lista está vacía, no se emite ninguna cabecera
  CORS: la petición server-to-server funciona igual, la del navegador la bloquea el navegador.
- `Vary: Origin, Authorization` va **siempre**, haya o no CORS.

Preflight, en todas las rutas:

```
OPTIONS /api/public/v1/<lo que sea>
→ 204 No Content
Access-Control-Allow-Methods: GET, OPTIONS
Access-Control-Allow-Headers: Authorization, Content-Type
Access-Control-Max-Age: 86400
```

### 3.6 Rate limiting

El límite es **por dueño de la clave (`ownerId`), no por clave y no por IP**: una persona
con varias claves activas (hasta 10, [§2](#2-autenticación)) no multiplica su cuota
generándolas, y dos personas detrás del mismo NAT no se estorban entre sí.

| Alcance | Límite | Ventana |
|---|---|---|
| General (todos los endpoints) | 120 peticiones | 60 s |
| Endpoints caros: **todo** `/graph` y **todo** `/snapshots/{id}`, tenga o no `?includeMembers=true` | 10 peticiones | 60 s |
| Intentos con clave inválida (por IP, no por dueño: todavía no hay uno que perder) | 10 intentos | 60 s |

El bucket "caro" es **independiente** del general: no se descuenta de los 120/min. En
`/snapshots/{id}` la decisión de usar el bucket caro se toma **antes** de leer
`includeMembers`, así que aplica a cada petición al endpoint, no solo a las que piden la
membresía (ver [§4.17](#417-get-snapshotsid)).

Al superarlo: **429 `rate_limited`**, con `Retry-After: <segundos>` y las cabeceras
`X-RateLimit-*`.

El contador es **global**, no por instancia: vive en la tabla `rate_limits` de Postgres
(`consumeRateLimit()`, compartida con el resto de rate limits de tools4foresight), así que
la misma persona golpeando desde tres funciones serverless distintas comparte un único
cupo. Los valores de `X-RateLimit-Remaining`/`X-RateLimit-Reset` salen del mismo contador
que tomó la decisión de limitar o no, así que un cliente puede confiar en ellos — aun así,
la forma correcta de reaccionar a un 429 sigue siendo reintentar con backoff, no calcular
por adelantado cuándo se agota la cuota.

### 3.7 Tipos y parseo de parámetros

- **Booleanos**: se aceptan `true` y `false`. Cualquier otro valor → **400**.
  Ausente = el default documentado.
- **Listas**: se aceptan las **dos** formas, y se pueden mezclar:
  repetir el parámetro (`?category=IA&category=Trabajo`) o separar por coma
  (`?category=IA,Trabajo`). Los valores se recortan y los vacíos se descartan.
  Varios valores del mismo parámetro son un **OR**; parámetros distintos son un **AND**.
- **Números**: notación decimal simple. `minVitality=0.5`, `limit=50`.
- **Enums** (`horizon`, `status`, `sort`): sensibles a mayúsculas y minúsculas tal como se
  documentan (`H1`, no `h1`). Valor fuera del conjunto → **400 `invalid_parameter`** con
  el nombre del parámetro en `param`.
- Un parámetro **desconocido se ignora en silencio**. (Decisión: rechazarlo haría que
  agregar un parámetro nuevo en el futuro rompiera clientes que lo mandan por error.)

---

## 4. Endpoints

**17 endpoints.** Todos son `GET`, todos exigen `Authorization: Bearer`, todos devuelven
el envelope `{ data, meta }`.

| # | Ruta | `data` | Caché | Rate limit |
|---|---|---|---|---|
| 1 | `/meta` | `MetaDTO` | `short` | general |
| 2 | `/health` | `HealthDTO` | `live` | general |
| 3 | `/signals` | `SignalSummaryDTO[]` | `short` | general |
| 4 | `/signals/{id}` | `SignalDetailDTO` | `short` | general |
| 5 | `/signals/{id}/neighbors` | `NeighborDTO[]` | `graph` | general |
| 6 | `/themes` | `ThemeSummaryDTO[]` | `graph` | general |
| 7 | `/themes/{id}` | `ThemeDetailDTO` | `graph` | general |
| 8 | `/themes/{id}/signals` | `SignalSummaryDTO[]` | `graph` | general |
| 9 | `/themes/{id}/history` | `ThemeHistoryDTO` | `graph` | general |
| 10 | `/macro-themes` | `MacroThemeDTO[]` | `graph` | general |
| 11 | `/horizons` | `HorizonDTO[]` | `graph` | general |
| 12 | `/horizons/{key}` | `HorizonDTO & { themes }` | `graph` | general |
| 13 | `/categories` | `CategoryDTO[]` | `static` | general |
| 14 | `/pestel` | `PestelDTO[]` | `static` | general |
| 15 | `/graph` | `GraphDTO` | `graph` | **caro (10/min), siempre** |
| 16 | `/snapshots` | `SnapshotSummaryDTO[]` | `graph` | general |
| 17 | `/snapshots/{id}` | `SnapshotDetailDTO` | `static` | **caro (10/min), siempre** — no solo con `?includeMembers` |

---

### 4.1 `GET /meta`

Resumen del banco del dueño de la clave: conteos, rango de fechas, última corrida del grafo y las constantes del
modelo de vitalidad y clustering.

**Query params**: ninguno.

```bash
curl -s "https://$T4F_HOST/api/public/v1/meta" \
  -H "Authorization: Bearer AbC0dEf1GhI2jKl3MnO4pQr5StU6vWx7YzA8bCd9EfG"
```

```json
{
  "data": {
    "apiVersion": "v1",
    "generatedAt": "2026-08-25T14:32:10.884Z",
    "counts": {
      "signals": 1592,
      "publishedSignals": 1483,
      "themesAlive": 27,
      "themesDead": 41,
      "macroThemes": 12,
      "links": 6294,
      "categories": 9,
      "snapshots": 214
    },
    "lastGraphRunAt": "2026-08-25T06:00:11.402Z",
    "dateRange": {
      "earliestLikedAt": "2024-02-11T18:03:47.000Z",
      "latestLikedAt": "2026-08-24T21:47:09.318Z"
    },
    "domain": {
      "halfLifeDays": 30,
      "orphanHalfLifeDays": 15,
      "deadThreshold": 1,
      "linkThreshold": 0.55,
      "minThemeSize": 3,
      "maxMacroPerHorizon": 5
    }
  },
  "meta": { "generatedAt": "2026-08-25T14:32:10.884Z" }
}
```

Los valores de `domain` son las constantes **efectivas** en el servidor (algunas son
ajustables por variables de entorno), no literales quemados en el cliente. Un cliente que
necesite explicar el modelo debe leerlos de aquí.

`counts.signals` es el **total** del banco del dueño (publicadas o no);
`counts.publishedSignals` es el subconjunto con `publishStatus: 'published'` (las que ya
entraron al grafo y a `semantic_links`). Ambos conteos existen y significan cosas
distintas: un agente que solo mire `signals` sabe cuánto material hay guardado en total; si
compara los dos sabe además cuánto de eso ya está "listo" (revisado y en el mapa). Ninguno
de los dos es un filtro — son solo conteos.

---

### 4.2 `GET /health`

Sonda de vida de la API pública. **Query params**: ninguno.

```bash
curl -s "https://$T4F_HOST/api/public/v1/health" \
  -H "Authorization: Bearer AbC0dEf1GhI2jKl3MnO4pQr5StU6vWx7YzA8bCd9EfG"
```

```json
{
  "data": {
    "status": "ok",
    "apiVersion": "v1",
    "db": "ok",
    "checkedAt": "2026-08-25T14:32:11.019Z"
  },
  "meta": {
    "apiVersion": "v1",
    "nextCursor": null,
    "hasMore": false,
    "count": 1,
    "generatedAt": "2026-08-25T14:32:11.019Z"
  }
}
```

- `status`: `"ok"` | `"degraded"`. Es `"degraded"` exactamente cuando `db` no es `"ok"`.
- `db`: `"ok"` | `"down"`. **`"down"`, no `"error"`** — es el literal que emite el handler.
- `checkedAt`: ISO 8601 UTC del momento de la sonda.
- Lleva autenticación como todos los demás: la petición pasa por `withPublicApi`, así que
  sin `Authorization` válido devuelve 401 antes de sondear nada.

#### Por qué la sonda corre dentro de `withOwner`, y no como un `$queryRaw` pelado

En el repo de origen `/health` era una sonda de despliegue sin auth y sin tenant:
«¿el servicio contesta?». Aquí la petición **ya llega autenticada y atada a un `ownerId`**,
así que «el servicio funciona» puede significar algo más preciso y más útil: no solo que
Postgres responda en abstracto, sino que **el camino de ESTE tenant hasta su banco
funciona**.

Por eso el chequeo es, literalmente:

```ts
await withOwner(ownerId, (tx) => tx.$queryRaw`SELECT 1`);
```

y no un `prisma.$queryRaw` suelto contra el cliente global. La diferencia importa: además de
confirmar que la base contesta, confirma que `set_config('app.owner_id', …)` y la
transacción de este tenant se ejecutan sin error — que es **la vía real** que usa cualquier
otro endpoint de esta API con esa misma clave. Un `SELECT 1` global podría responder «ok»
mientras el camino con RLS está roto para todo el mundo, que es justo el fallo que esta
sonda tiene que detectar.

Si la sonda lanza, el error real va **solo al log del servidor** (`console.error`): al
cliente no le sirve el mensaje de Postgres y sí le filtraría detalles de la infraestructura.

#### Qué NO reporta, y por qué

`/health` es deliberadamente trivial: un booleano de disponibilidad, **nada de aritmética
sobre datos de nadie**. En concreto no reporta:

- **Ningún agregado de la PLATAFORMA** (cuántos usuarios hay, tamaño total de la base,
  cuántas claves existen). Eso no es «salud de la API pública» para quien pregunta: es
  información de otros tenants filtrándose por una puerta que parece inocua justamente
  porque no es un endpoint de contenido.
- **Ningún conteo del PROPIO banco** (señales, temas, snapshots), aunque devolverlo sería
  seguro. Ese trabajo ya lo hace [`/meta`](#41-get-meta), con su propio perfil de caché;
  duplicarlo aquí crearía **dos fuentes de verdad para el mismo número**, que acabarían
  discrepando en cuanto una de las dos se cachee distinto.

#### 200 incluso en `degraded`

El endpoint responde **200 aunque `db` sea `"down"`**. Es intencional: el 200 dice «la
función corre y el handler se ejecutó», y el cuerpo dice si la base contesta. Un 503 aquí
borraría esa diferencia, y un cliente no podría distinguir «la API está caída» (sin
respuesta, o 5xx de la plataforma) de «la API vive pero su base no» (200 con
`status: "degraded"`).

Nunca se cachea (`cache: "live"` → `Cache-Control: private, no-store`): un health cacheado
podría decir «ok» con la base ya caída, o «degraded» de un incidente ya resuelto.

---

### 4.3 `GET /signals`

Lista paginada de las señales del banco, con filtros. Sin filtro de publicación: salen todas.

| Param | Tipo | Default | Oblig. | Validación |
|---|---|---|---|---|
| `cursor` | string opaco | — | no | El `meta.nextCursor` de la página anterior, sin modificar. |
| `limit` | int | `25` | no | `1..100` |
| `q` | string | — | no | Busca, sin distinguir mayúsculas, en `tweetText`, `contentTitle`, `authorHandle`, `tldr` y `whyMatters`. Se recorta; vacío = sin filtro. |
| `category` | lista de string | — | no | Nombres exactos de categoría (OR entre valores). Repetible o separada por coma. Alias aceptado: `categories`. |
| `pestel` | lista de string | — | no | Claves de PESTEL: `political`, `economic`, `social`, `technological`, `environmental`, `legal`. Clave desconocida → 400. |
| `horizon` | enum | — | no | `H1` \| `H2` \| `H3`. Filtra por el horizonte del tema al que pertenece la señal. |
| `theme` | uuid | — | no | Id de un `SemanticCluster`. |
| `macroTheme` | uuid | — | no | Id de un `MacroCluster`. |
| `status` | enum | `any` | no | `alive` \| `dead` \| `any` — estado del **tema** al que pertenece la señal. |
| `publishStatus` | enum | `any` | no | `published` \| `pending` \| `any` — estado de curaduría de la **señal misma** (no confundir con `status`, que es del tema). `any` = no filtra nada: es el default porque el dueño ve su banco completo por defecto. |
| `from` | fecha | — | no | Sobre `likedAt`, inclusivo. |
| `to` | fecha | — | no | Sobre `likedAt`, inclusivo. |
| `minVitality` | float | — | no | `>= 0`. Vitalidad mínima de la señal. Las señales con `vitality` null quedan fuera al usarlo. |
| `orphans` | bool | `false` | no | `true` = solo señales sin tema (`clusterId` null). Incompatible con `theme`, `macroTheme`, `horizon` y `status` distinto de `any` → 400. |
| `sort` | enum | `likedAt` | no | `likedAt` (más reciente primero) \| `vitality` (más viva primero). |

```bash
curl -s "https://$T4F_HOST/api/public/v1/signals?horizon=H2&pestel=legal,social&limit=2" \
  -H "Authorization: Bearer AbC0dEf1GhI2jKl3MnO4pQr5StU6vWx7YzA8bCd9EfG"
```

```json
{
  "data": [
    {
      "id": "c7f3a914-20bc-4d4c-9c51-940f372e0d8a",
      "source": "x_like",
      "title": "El Parlamento Europeo aprueba el reglamento de agentes autónomos",
      "url": "https://www.euractiv.com/section/ai/news/ai-agents-liability-regulation-vote/",
      "authorHandle": "melissa_heikkila",
      "authorName": "Melissa Heikkilä",
      "likedAt": "2026-08-18T09:14:22.103Z",
      "likedAtEstimated": true,
      "likedAtSource": "ordered",
      "publishStatus": "published",
      "category": "Gobernanza y regulación",
      "pestel": ["social", "legal"],
      "tags": ["responsabilidad civil", "operador desplegante", "regulación UE"],
      "tldr": "El Parlamento Europeo votó a favor de extender el marco de responsabilidad civil a los agentes de IA que ejecutan acciones en nombre de una persona. La norma introduce la figura del 'operador desplegante' y obliga a mantener un registro auditable de cada acción autónoma con efectos jurídicos. Los proveedores de modelos quedan fuera del alcance directo salvo que comercialicen el agente como producto terminado. Entra en vigor de forma escalonada a partir de 2028.",
      "vitality": 0.87,
      "theme": {
        "id": "4e9b1c72-8a30-4f11-b8d6-2c5a7e0d91f4",
        "name": "Responsabilidad legal de los agentes autónomos",
        "status": "alive",
        "horizon": "H2"
      }
    },
    {
      "id": "9b21e0d4-5f7a-4c88-91b3-6ea0c4f27d15",
      "source": "manual",
      "title": "Cuando el asistente decide por ti: fricción y delegación en el trabajo del conocimiento",
      "url": "https://cacm.acm.org/opinion/when-the-assistant-decides/",
      "authorHandle": "cacm.acm.org",
      "authorName": null,
      "likedAt": "2026-08-16T20:41:05.000Z",
      "likedAtEstimated": true,
      "likedAtSource": "tweet_date",
      "publishStatus": "pending",
      "category": "Futuro del trabajo",
      "pestel": ["social", "legal"],
      "tags": [],
      "tldr": "Ensayo sobre la delegación tácita: cuando un agente actúa sin confirmación explícita, la responsabilidad se difumina entre quien lo configuró y quien lo dejó correr. El autor propone tres niveles de fricción de diseño —notificar, confirmar, coautorizar— y argumenta que eliminar toda fricción convierte al usuario en firmante de decisiones que no leyó.",
      "vitality": 0.74,
      "theme": {
        "id": "4e9b1c72-8a30-4f11-b8d6-2c5a7e0d91f4",
        "name": "Responsabilidad legal de los agentes autónomos",
        "status": "alive",
        "horizon": "H2"
      }
    }
  ],
  "meta": {
    "nextCursor": "djF8MjAyNi0wOC0xNlQyMDo0MTowNS4wMDBafDliMjFlMGQ0LTVmN2EtNGM4OC05MWIzLTZlYTBjNGYyN2QxNQ",
    "hasMore": true,
    "count": 2,
    "total": 34,
    "generatedAt": "2026-08-25T14:32:12.550Z"
  }
}
```

`tags` en el segundo ejemplo viene vacío a propósito: la señal `pending` de arriba todavía
no pasó por el pipeline que genera etiquetas. `publishStatus: "pending"` en ese mismo
ejemplo muestra que la lista **no** filtra por defecto: salen señales revisadas y sin
revisar mezcladas, salvo que se pida `?publishStatus=`.

---

### 4.4 `GET /signals/{id}`

Ficha completa de una señal del banco.

| Param | Tipo | Default | Oblig. | Validación |
|---|---|---|---|---|
| `id` (ruta) | uuid | — | **sí** | Id de un `LikedItem`. Si no existe **o es de otro dueño** → 404 (ver §6). |

```bash
curl -s "https://$T4F_HOST/api/public/v1/signals/c7f3a914-20bc-4d4c-9c51-940f372e0d8a" \
  -H "Authorization: Bearer AbC0dEf1GhI2jKl3MnO4pQr5StU6vWx7YzA8bCd9EfG"
```

```json
{
  "data": {
    "id": "c7f3a914-20bc-4d4c-9c51-940f372e0d8a",
    "source": "x_like",
    "title": "El Parlamento Europeo aprueba el reglamento de agentes autónomos",
    "url": "https://www.euractiv.com/section/ai/news/ai-agents-liability-regulation-vote/",
    "authorHandle": "melissa_heikkila",
    "authorName": "Melissa Heikkilä",
    "likedAt": "2026-08-18T09:14:22.103Z",
    "likedAtEstimated": true,
    "likedAtSource": "ordered",
    "publishStatus": "published",
    "category": "Gobernanza y regulación",
    "pestel": ["social", "legal"],
    "tags": ["responsabilidad civil", "operador desplegante", "regulación UE"],
    "tldr": "El Parlamento Europeo votó a favor de extender el marco de responsabilidad civil a los agentes de IA que ejecutan acciones en nombre de una persona. La norma introduce la figura del 'operador desplegante' y obliga a mantener un registro auditable de cada acción autónoma con efectos jurídicos. Los proveedores de modelos quedan fuera del alcance directo salvo que comercialicen el agente como producto terminado. Entra en vigor de forma escalonada a partir de 2028.",
    "vitality": 0.87,
    "theme": {
      "id": "4e9b1c72-8a30-4f11-b8d6-2c5a7e0d91f4",
      "name": "Responsabilidad legal de los agentes autónomos",
      "status": "alive",
      "horizon": "H2"
    },
    "tweetId": "1957402219883110401",
    "tweetText": "Se votó. La responsabilidad civil de los agentes de IA ya tiene texto, y la figura del \"operador desplegante\" va a cambiar cómo se compran estas herramientas. Mi análisis 👇 https://t.co/9KzQm1LpVt",
    "tweetUrl": "https://x.com/melissa_heikkila/status/1957402219883110401",
    "tweetCreatedAt": "2026-08-17T11:22:48.000Z",
    "mediaUrls": [
      "https://pbs.twimg.com/media/G1kQ8ZvXwAAr3nP.jpg"
    ],
    "contentUrl": "https://www.euractiv.com/section/ai/news/ai-agents-liability-regulation-vote/",
    "contentTitle": "El Parlamento Europeo aprueba el reglamento de agentes autónomos",
    "contentDescription": "El texto introduce la figura del operador desplegante y obliga a registros auditables de acciones autónomas con efectos jurídicos.",
    "contentImageUrl": "https://www.euractiv.com/wp-content/uploads/sites/2/2026/08/ep-plenary-ai.jpg",
    "contentPublishedAt": "2026-08-17T09:30:00.000Z",
    "categoryConfidence": 0.92,
    "categoryReasoning": "Voto parlamentario sobre un marco normativo específico de IA; encaja de lleno en gobernanza y regulación más que en futuro del trabajo.",
    "whyMatters": "Es la primera vez que un legislador define quién responde cuando un agente actúa solo. Fija el vocabulario con el que se van a escribir los contratos de software de los próximos años, y desplaza el riesgo del proveedor del modelo hacia quien lo despliega.",
    "impact": "Si el riesgo legal recae en quien despliega y no en quien fabrica el modelo, las organizaciones van a exigir agentes que expliquen y registren cada acción antes que agentes que actúen más rápido. Eso empuja el desarrollo de la IA hacia la trazabilidad y hacia interfaces de coautorización, y cambia la interacción humana: delegar deja de ser un gesto invisible y se vuelve un acto firmado.",
    "publishedAt": "2026-08-19T07:12:44.019Z",
    "vitalityAt": "2026-08-25T06:00:11.402Z",
    "neighborCount": 11
  },
  "meta": { "generatedAt": "2026-08-25T14:33:02.117Z" }
}
```

---

### 4.5 `GET /signals/{id}/neighbors`

Señales semánticamente cercanas a una señal, ordenadas por similitud descendente.

| Param | Tipo | Default | Oblig. | Validación |
|---|---|---|---|---|
| `id` (ruta) | uuid | — | **sí** | Señal del banco; si no existe o es de otro dueño → 404. |
| `limit` | int | `10` | no | `1..50` |
| `minScore` | float | *(sin default: no filtra si se omite)* | no | `0..1`. Solo se aplica un `score >= minScore` extra cuando el parámetro viene. Da igual: toda arista de `semantic_links` ya está por encima de `LINK_THRESHOLD = 0.55` por construcción (por debajo de ese piso el par ni se guarda), así que un `minScore` menor a 0.55 no amplía nada y omitirlo no relaja nada por debajo de ese piso. |

```bash
curl -s "https://$T4F_HOST/api/public/v1/signals/c7f3a914-20bc-4d4c-9c51-940f372e0d8a/neighbors?limit=2&minScore=0.7" \
  -H "Authorization: Bearer AbC0dEf1GhI2jKl3MnO4pQr5StU6vWx7YzA8bCd9EfG"
```

```json
{
  "data": [
    {
      "signal": {
        "id": "9b21e0d4-5f7a-4c88-91b3-6ea0c4f27d15",
        "source": "manual",
        "title": "Cuando el asistente decide por ti: fricción y delegación en el trabajo del conocimiento",
        "url": "https://cacm.acm.org/opinion/when-the-assistant-decides/",
        "authorHandle": "cacm.acm.org",
        "authorName": null,
        "likedAt": "2026-08-16T20:41:05.000Z",
        "likedAtEstimated": true,
        "likedAtSource": "tweet_date",
        "publishStatus": "pending",
        "category": "Futuro del trabajo",
        "pestel": ["social", "legal"],
        "tags": [],
        "tldr": "Ensayo sobre la delegación tácita: cuando un agente actúa sin confirmación explícita, la responsabilidad se difumina entre quien lo configuró y quien lo dejó correr. El autor propone tres niveles de fricción de diseño —notificar, confirmar, coautorizar— y argumenta que eliminar toda fricción convierte al usuario en firmante de decisiones que no leyó.",
        "vitality": 0.74,
        "theme": {
          "id": "4e9b1c72-8a30-4f11-b8d6-2c5a7e0d91f4",
          "name": "Responsabilidad legal de los agentes autónomos",
          "status": "alive",
          "horizon": "H2"
        }
      },
      "score": 0.8123,
      "strength": "fuerte"
    },
    {
      "signal": {
        "id": "31a7c5be-0d92-4a60-8f74-b1e3d8c04a27",
        "source": "x_like",
        "title": "Auditoría de bitácoras: qué registra realmente un agente en producción",
        "url": "https://www.anthropic.com/research/agent-audit-logs",
        "authorHandle": "simonw",
        "authorName": "Simon Willison",
        "likedAt": "2026-08-11T13:05:40.221Z",
        "likedAtEstimated": true,
        "likedAtSource": "ordered",
        "publishStatus": "published",
        "category": "Gobernanza y regulación",
        "pestel": ["technological", "legal"],
        "tags": ["bitácoras de auditoría", "trazabilidad de agentes"],
        "tldr": "Revisión de 14 despliegues reales de agentes: la mayoría registra la llamada a la herramienta pero no el razonamiento que la motivó, lo que hace imposible reconstruir por qué se tomó una decisión. Propone un formato mínimo de bitácora con intención, evidencia consultada y alternativas descartadas.",
        "vitality": 0.71,
        "theme": {
          "id": "4e9b1c72-8a30-4f11-b8d6-2c5a7e0d91f4",
          "name": "Responsabilidad legal de los agentes autónomos",
          "status": "alive",
          "horizon": "H2"
        }
      },
      "score": 0.7418,
      "strength": "media"
    }
  ],
  "meta": {
    "nextCursor": null,
    "hasMore": false,
    "count": 2,
    "total": 11,
    "generatedAt": "2026-08-25T14:33:40.702Z"
  }
}
```

> Ver [§7 `score` vs `strength`](#7-score-vs-strength) antes de renderizar esto para una persona.

---

### 4.6 `GET /themes`

Lista paginada de temas (clusters semánticos con linaje), vivos y fósiles.

| Param | Tipo | Default | Oblig. | Validación |
|---|---|---|---|---|
| `cursor` | string opaco | — | no | De `meta.nextCursor`. |
| `limit` | int | `25` | no | `1..100` |
| `status` | enum | `any` | no | `alive` \| `dead` \| `any`. **Default `any`**: un tema es un linaje que puede morir y resucitar, y por defecto la lista trae vivos y fósiles mezclados — pide `status=alive` explícitamente si solo quieres los vivos. |
| `horizon` | enum | — | no | `H1` \| `H2` \| `H3`. Un tema fósil tiene `horizon: null`, así que este filtro implica temas vivos. |
| `macroTheme` | uuid | — | no | Id de un `MacroCluster`. |
| `q` | string | — | no | Busca, sin distinguir mayúsculas, en `name` y `summary`. |
| `sort` | enum | `vitality` | no | `vitality` \| `size` \| `velocity` (por `velocity30d`) \| `lastSignal` (por `lastSignalAt`). Siempre descendente. |
| `minVitality` | float | — | no | `>= 0` |

```bash
curl -s "https://$T4F_HOST/api/public/v1/themes?horizon=H2&sort=velocity&limit=2" \
  -H "Authorization: Bearer AbC0dEf1GhI2jKl3MnO4pQr5StU6vWx7YzA8bCd9EfG"
```

```json
{
  "data": [
    {
      "id": "4e9b1c72-8a30-4f11-b8d6-2c5a7e0d91f4",
      "name": "Responsabilidad legal de los agentes autónomos",
      "summary": "Señales sobre quién responde cuando un sistema de IA actúa por cuenta propia: marcos regulatorios, bitácoras auditables, seguros y contratos de despliegue.",
      "status": "alive",
      "size": 14,
      "vitality": 4.12,
      "horizon": "H2",
      "horizonSuggested": "H2",
      "horizonSource": "auto",
      "macroTheme": {
        "id": "b8d40e21-3f6c-4a19-9e02-77c5a1f4b930",
        "name": "Gobernanza de sistemas que actúan solos"
      },
      "lastSignalAt": "2026-08-18T09:14:22.103Z"
    },
    {
      "id": "a1c60f93-77de-4b25-8c30-19f2b7e4d508",
      "name": "Energía y límites físicos del cómputo",
      "summary": "El costo eléctrico y térmico de entrenar e inferir aparece como restricción de diseño: contratos de generación, ubicación de centros de datos y modelos más pequeños por necesidad, no por elegancia.",
      "status": "alive",
      "size": 11,
      "vitality": 3.48,
      "horizon": "H2",
      "horizonSuggested": "H2",
      "horizonSource": "manual",
      "macroTheme": null,
      "lastSignalAt": "2026-08-21T16:52:33.771Z"
    }
  ],
  "meta": {
    "nextCursor": "djF8MjAyNi0wOC0yMVQxNjo1MjozMy43NzFafGExYzYwZjkzLTc3ZGUtNGIyNS04YzMwLTE5ZjJiN2U0ZDUwOA",
    "hasMore": true,
    "count": 2,
    "total": 9,
    "generatedAt": "2026-08-25T14:34:05.330Z"
  }
}
```

---

### 4.7 `GET /themes/{id}`

Detalle de un tema, con sus cuatro indicadores y la última membresía conocida.

| Param | Tipo | Default | Oblig. | Validación |
|---|---|---|---|---|
| `id` (ruta) | uuid | — | **sí** | Id de un `SemanticCluster`; si no existe → 404. Los temas fósiles **sí** se devuelven (un fósil no está borrado). |

```bash
curl -s "https://$T4F_HOST/api/public/v1/themes/4e9b1c72-8a30-4f11-b8d6-2c5a7e0d91f4" \
  -H "Authorization: Bearer AbC0dEf1GhI2jKl3MnO4pQr5StU6vWx7YzA8bCd9EfG"
```

```json
{
  "data": {
    "id": "4e9b1c72-8a30-4f11-b8d6-2c5a7e0d91f4",
    "name": "Responsabilidad legal de los agentes autónomos",
    "summary": "Señales sobre quién responde cuando un sistema de IA actúa por cuenta propia: marcos regulatorios, bitácoras auditables, seguros y contratos de despliegue.",
    "status": "alive",
    "size": 14,
    "vitality": 4.12,
    "horizon": "H2",
    "horizonSuggested": "H2",
    "horizonSource": "auto",
    "macroTheme": {
      "id": "b8d40e21-3f6c-4a19-9e02-77c5a1f4b930",
      "name": "Gobernanza de sistemas que actúan solos"
    },
    "lastSignalAt": "2026-08-18T09:14:22.103Z",
    "firstSeenAt": "2026-03-02T06:00:09.221Z",
    "diedAt": null,
    "revivedCount": 1,
    "indicators": {
      "velocity30d": 6,
      "velocityPrev30d": 2,
      "velocityDelta": 4,
      "density": 0.7134,
      "connectivity": 0.2857,
      "novelty": 0.4021,
      "bridgeThemes": 3
    },
    "memberIds": [
      "31a7c5be-0d92-4a60-8f74-b1e3d8c04a27",
      "9b21e0d4-5f7a-4c88-91b3-6ea0c4f27d15",
      "c7f3a914-20bc-4d4c-9c51-940f372e0d8a"
    ]
  },
  "meta": { "generatedAt": "2026-08-25T14:34:22.908Z" }
}
```

> `memberIds` viene truncado en el ejemplo por legibilidad; en la respuesta real trae los
> `size` ids. Ver la nota de `lastMemberIds` en [§8](#8-notas-para-quien-implementa).

---

### 4.8 `GET /themes/{id}/signals`

Las señales que componen un tema.

| Param | Tipo | Default | Oblig. | Validación |
|---|---|---|---|---|
| `id` (ruta) | uuid | — | **sí** | Tema existente; si no → 404. |
| `cursor` | string opaco | — | no | De `meta.nextCursor`. |
| `limit` | int | `25` | no | `1..100` |
| `sort` | enum | `vitality` | no | `vitality` \| `likedAt`. Siempre descendente. |

```bash
curl -s "https://$T4F_HOST/api/public/v1/themes/4e9b1c72-8a30-4f11-b8d6-2c5a7e0d91f4/signals?sort=likedAt&limit=1" \
  -H "Authorization: Bearer AbC0dEf1GhI2jKl3MnO4pQr5StU6vWx7YzA8bCd9EfG"
```

```json
{
  "data": [
    {
      "id": "c7f3a914-20bc-4d4c-9c51-940f372e0d8a",
      "source": "x_like",
      "title": "El Parlamento Europeo aprueba el reglamento de agentes autónomos",
      "url": "https://www.euractiv.com/section/ai/news/ai-agents-liability-regulation-vote/",
      "authorHandle": "melissa_heikkila",
      "authorName": "Melissa Heikkilä",
      "likedAt": "2026-08-18T09:14:22.103Z",
      "likedAtEstimated": true,
      "likedAtSource": "ordered",
      "publishStatus": "published",
      "category": "Gobernanza y regulación",
      "pestel": ["social", "legal"],
      "tags": ["responsabilidad civil", "operador desplegante", "regulación UE"],
      "tldr": "El Parlamento Europeo votó a favor de extender el marco de responsabilidad civil a los agentes de IA que ejecutan acciones en nombre de una persona. La norma introduce la figura del 'operador desplegante' y obliga a mantener un registro auditable de cada acción autónoma con efectos jurídicos.",
      "vitality": 0.87,
      "theme": {
        "id": "4e9b1c72-8a30-4f11-b8d6-2c5a7e0d91f4",
        "name": "Responsabilidad legal de los agentes autónomos",
        "status": "alive",
        "horizon": "H2"
      }
    }
  ],
  "meta": {
    "nextCursor": "djF8MjAyNi0wOC0xOFQwOToxNDoyMi4xMDNafGM3ZjNhOTE0LTIwYmMtNGQ0Yy05YzUxLTk0MGYzNzJlMGQ4YQ",
    "hasMore": true,
    "count": 1,
    "total": 14,
    "generatedAt": "2026-08-25T14:34:51.006Z"
  }
}
```

**Temas fósiles**: un tema `dead` tiene `clusterId` null en sus antiguas señales, así que
este endpoint devuelve `[]`. Para saber qué señales tuvo, se usan los `memberIds`
(`lastMemberIds`) de [`/themes/{id}`](#47-get-themesid) y luego `/signals/{id}` por cada uno.

---

### 4.9 `GET /themes/{id}/history`

Serie temporal de un tema: cómo cambiaron su tamaño, vitalidad, velocidad, indicadores y
horizonte en cada corrida del grafo. Es el endpoint de "¿esto está creciendo o apagándose?".

| Param | Tipo | Default | Oblig. | Validación |
|---|---|---|---|---|
| `id` (ruta) | uuid | — | **sí** | Tema existente; si no → 404. |
| `from` | fecha | — | no | Sobre `snapshot.takenAt`, inclusivo. |
| `to` | fecha | — | no | Sobre `snapshot.takenAt`, inclusivo. |
| `limit` | int | `100` | no | `1..500`. Si hay más puntos que `limit` dentro del rango, se devuelven los **más antiguos** de ese rango (la consulta ordena ascendente y corta con `take: limit`; no hay una segunda pasada que invierta el corte). Si te interesan los puntos recientes de un tema con mucha historia, combina `from`/`to` para acotar el rango en vez de subir `limit`. |

> **`points` va SIEMPRE en orden ascendente por `takenAt`** (el más antiguo primero), para
> que se pueda graficar y derivar sin reordenar. Este endpoint **no** pagina por cursor.

```bash
curl -s "https://$T4F_HOST/api/public/v1/themes/4e9b1c72-8a30-4f11-b8d6-2c5a7e0d91f4/history?from=2026-08-20&limit=3" \
  -H "Authorization: Bearer AbC0dEf1GhI2jKl3MnO4pQr5StU6vWx7YzA8bCd9EfG"
```

```json
{
  "data": {
    "themeId": "4e9b1c72-8a30-4f11-b8d6-2c5a7e0d91f4",
    "points": [
      {
        "themeId": "4e9b1c72-8a30-4f11-b8d6-2c5a7e0d91f4",
        "name": "Responsabilidad legal de los agentes autónomos",
        "size": 12,
        "status": "alive",
        "vitality": 3.61,
        "velocity30d": 4,
        "density": 0.6902,
        "connectivity": 0.2411,
        "novelty": 0.4388,
        "horizon": "H2",
        "takenAt": "2026-08-21T06:00:08.114Z",
        "trigger": "cron"
      },
      {
        "themeId": "4e9b1c72-8a30-4f11-b8d6-2c5a7e0d91f4",
        "name": "Responsabilidad legal de los agentes autónomos",
        "size": 13,
        "status": "alive",
        "vitality": 3.95,
        "velocity30d": 5,
        "density": 0.7011,
        "connectivity": 0.2663,
        "novelty": 0.4155,
        "horizon": "H2",
        "takenAt": "2026-08-23T18:41:52.667Z",
        "trigger": "publish"
      },
      {
        "themeId": "4e9b1c72-8a30-4f11-b8d6-2c5a7e0d91f4",
        "name": "Responsabilidad legal de los agentes autónomos",
        "size": 14,
        "status": "alive",
        "vitality": 4.12,
        "velocity30d": 6,
        "density": 0.7134,
        "connectivity": 0.2857,
        "novelty": 0.4021,
        "horizon": "H2",
        "takenAt": "2026-08-25T06:00:11.402Z",
        "trigger": "cron"
      }
    ]
  },
  "meta": { "count": 3, "generatedAt": "2026-08-25T14:35:19.442Z" }
}
```

`name` viaja en cada punto a propósito: los temas se rebautizan cuando cambia su membresía,
y la serie histórica conserva el nombre que tenían en ese momento.

---

### 4.10 `GET /macro-themes`

Macro-temas: agrupación de segundo nivel sobre los temas vivos, máximo 5 por horizonte
(15 en total).

| Param | Tipo | Default | Oblig. | Validación |
|---|---|---|---|---|
| `horizon` | enum | — | no | `H1` \| `H2` \| `H3`. Sin él, devuelve los de los tres horizontes. |

> **Los ids de macro-tema NO son estables.** Los macro-temas no tienen linaje: se borran y
> se recrean enteros en cada corrida del grafo. No los guardes entre sesiones; resuélvelos
> de nuevo cada vez.

Este endpoint **no pagina** (son 15 como máximo): `meta` trae `count` y `generatedAt`,
con `nextCursor: null` y `hasMore: false`.

```bash
curl -s "https://$T4F_HOST/api/public/v1/macro-themes?horizon=H2" \
  -H "Authorization: Bearer AbC0dEf1GhI2jKl3MnO4pQr5StU6vWx7YzA8bCd9EfG"
```

```json
{
  "data": [
    {
      "id": "b8d40e21-3f6c-4a19-9e02-77c5a1f4b930",
      "name": "Gobernanza de sistemas que actúan solos",
      "summary": "Temas que convergen en la misma pregunta desde ángulos distintos: cuando el software deja de sugerir y empieza a ejecutar, quién firma, quién audita y quién paga.",
      "horizon": "H2",
      "themes": [
        {
          "id": "4e9b1c72-8a30-4f11-b8d6-2c5a7e0d91f4",
          "name": "Responsabilidad legal de los agentes autónomos",
          "summary": "Señales sobre quién responde cuando un sistema de IA actúa por cuenta propia: marcos regulatorios, bitácoras auditables, seguros y contratos de despliegue.",
          "status": "alive",
          "size": 14,
          "vitality": 4.12,
          "horizon": "H2",
          "horizonSuggested": "H2",
          "horizonSource": "auto",
          "macroTheme": {
            "id": "b8d40e21-3f6c-4a19-9e02-77c5a1f4b930",
            "name": "Gobernanza de sistemas que actúan solos"
          },
          "lastSignalAt": "2026-08-18T09:14:22.103Z"
        },
        {
          "id": "7d2e91af-4c06-4f83-a5b1-e30c6d8a2145",
          "name": "Identidad y credenciales para máquinas",
          "summary": "Cómo se autentica un agente frente a otro servicio: claves delegadas con alcance, credenciales efímeras y el problema de revocar permisos que ya se ejercieron.",
          "status": "alive",
          "size": 9,
          "vitality": 2.87,
          "horizon": "H2",
          "horizonSuggested": "H2",
          "horizonSource": "auto",
          "macroTheme": {
            "id": "b8d40e21-3f6c-4a19-9e02-77c5a1f4b930",
            "name": "Gobernanza de sistemas que actúan solos"
          },
          "lastSignalAt": "2026-08-20T11:07:15.902Z"
        }
      ]
    }
  ],
  "meta": { "nextCursor": null, "hasMore": false, "count": 1, "generatedAt": "2026-08-25T14:35:44.128Z" }
}
```

---

### 4.11 `GET /horizons`

Panorama de los tres horizontes con sus agregados y sus macro-temas. Es la puerta de
entrada para "dame el estado del mapa".

**Query params**: ninguno. Devuelve **siempre los tres**, en orden `H1`, `H2`, `H3`,
aunque alguno tenga cero temas.

Las etiquetas son las reales del sistema:

| `key` | `labelShort` | `labelLong` |
|---|---|---|
| `H1` | `H1 · ya está pasando` | Tendencia consolidada: grande, viva y cerca del centro del mapa. |
| `H2` | `H2 · en transición` | Tema que crece y conecta con otros; todavía no domina. |
| `H3` | `H3 · señal débil` | Chico, lejano o con poca vitalidad: hipótesis a vigilar. |

```bash
curl -s "https://$T4F_HOST/api/public/v1/horizons" \
  -H "Authorization: Bearer AbC0dEf1GhI2jKl3MnO4pQr5StU6vWx7YzA8bCd9EfG"
```

```json
{
  "data": [
    {
      "key": "H1",
      "labelShort": "H1 · ya está pasando",
      "labelLong": "Tendencia consolidada: grande, viva y cerca del centro del mapa.",
      "themeCount": 4,
      "signalCount": 212,
      "vitalitySum": 38.71,
      "macroThemes": [
        {
          "id": "1f0a7c34-9b28-4e75-b6d0-52a9c1e30f87",
          "name": "El asistente como capa de trabajo por defecto",
          "summary": "La IA generativa dejó de ser una herramienta que se abre y pasó a ser el medio en el que se redacta, se busca y se decide dentro de las organizaciones.",
          "horizon": "H1",
          "themes": []
        }
      ]
    },
    {
      "key": "H2",
      "labelShort": "H2 · en transición",
      "labelLong": "Tema que crece y conecta con otros; todavía no domina.",
      "themeCount": 9,
      "signalCount": 143,
      "vitalitySum": 26.44,
      "macroThemes": [
        {
          "id": "b8d40e21-3f6c-4a19-9e02-77c5a1f4b930",
          "name": "Gobernanza de sistemas que actúan solos",
          "summary": "Temas que convergen en la misma pregunta desde ángulos distintos: cuando el software deja de sugerir y empieza a ejecutar, quién firma, quién audita y quién paga.",
          "horizon": "H2",
          "themes": []
        }
      ]
    },
    {
      "key": "H3",
      "labelShort": "H3 · señal débil",
      "labelLong": "Chico, lejano o con poca vitalidad: hipótesis a vigilar.",
      "themeCount": 14,
      "signalCount": 97,
      "vitalitySum": 19.02,
      "macroThemes": [
        {
          "id": "6c3b8e50-2a71-4d99-8f14-b7025de6a3c1",
          "name": "Cuerpos, sensores y presencia",
          "summary": "Hipótesis todavía sueltas sobre IA que percibe el espacio físico: robótica doméstica, wearables que interpretan estado afectivo y agentes con memoria del lugar.",
          "horizon": "H3",
          "themes": []
        }
      ]
    }
  ],
  "meta": { "nextCursor": null, "hasMore": false, "count": 3, "generatedAt": "2026-08-25T14:36:10.775Z" }
}
```

> **Nota de forma**: en el listado `/horizons`, los `macroThemes` vienen con
> `themes: []` para no devolver el mapa entero en una sola respuesta. Los temas completos
> de un horizonte se piden con [`/horizons/{key}`](#412-get-horizonskey), o los de un
> macro-tema con [`/macro-themes?horizon=`](#410-get-macro-themes), donde `themes` sí viene
> poblado. (Decisión tomada por ambigüedad del plan: `HorizonDTO` incluye `MacroThemeDTO[]`
> y `MacroThemeDTO` incluye `ThemeSummaryDTO[]`, lo que anidaría el corpus completo tres
> niveles; se resuelve dejando `themes` vacío en el listado y poblado en el detalle.)

- `themeCount` cuenta solo temas **vivos** de ese horizonte.
- `signalCount` cuenta las señales que pertenecen a esos temas vivos.
- `vitalitySum` es la suma de la vitalidad de esos temas, con 2 decimales.
- Las señales huérfanas (sin tema) no pertenecen a ningún horizonte y no se cuentan aquí;
  se piden con `/signals?orphans=true`.

---

### 4.12 `GET /horizons/{key}`

Un horizonte con **todos** sus temas vivos.

| Param | Tipo | Default | Oblig. | Validación |
|---|---|---|---|---|
| `key` (ruta) | enum | — | **sí** | `H1` \| `H2` \| `H3`. Cualquier otro valor → **400 `invalid_parameter`** con `param: "key"` (no 404: el conjunto es cerrado y conocido). |

```bash
curl -s "https://$T4F_HOST/api/public/v1/horizons/H3" \
  -H "Authorization: Bearer AbC0dEf1GhI2jKl3MnO4pQr5StU6vWx7YzA8bCd9EfG"
```

```json
{
  "data": {
    "key": "H3",
    "labelShort": "H3 · señal débil",
    "labelLong": "Chico, lejano o con poca vitalidad: hipótesis a vigilar.",
    "themeCount": 14,
    "signalCount": 97,
    "vitalitySum": 19.02,
    "macroThemes": [
      {
        "id": "6c3b8e50-2a71-4d99-8f14-b7025de6a3c1",
        "name": "Cuerpos, sensores y presencia",
        "summary": "Hipótesis todavía sueltas sobre IA que percibe el espacio físico: robótica doméstica, wearables que interpretan estado afectivo y agentes con memoria del lugar.",
        "horizon": "H3",
        "themes": []
      }
    ],
    "themes": [
      {
        "id": "e04f21b7-6c85-4a30-9d12-3f70b8ea5c69",
        "name": "Duelo y memoria con modelos de lenguaje",
        "summary": "Personas que conversan con reconstrucciones de familiares fallecidos a partir de sus mensajes: servicios comerciales, reacciones clínicas y los primeros marcos éticos.",
        "status": "alive",
        "size": 5,
        "vitality": 1.63,
        "horizon": "H3",
        "horizonSuggested": "H3",
        "horizonSource": "auto",
        "macroTheme": null,
        "lastSignalAt": "2026-08-14T22:18:47.512Z"
      },
      {
        "id": "5a8c30d9-1e47-4b62-90fa-cd2178e6b043",
        "name": "Robótica doméstica de propósito general",
        "summary": "Prototipos de robots del hogar guiados por modelos multimodales: manipulación no estructurada, precio objetivo y la brecha entre el video de demostración y la cocina real.",
        "status": "alive",
        "size": 4,
        "vitality": 1.29,
        "horizon": "H3",
        "horizonSuggested": "H3",
        "horizonSource": "auto",
        "macroTheme": {
          "id": "6c3b8e50-2a71-4d99-8f14-b7025de6a3c1",
          "name": "Cuerpos, sensores y presencia"
        },
        "lastSignalAt": "2026-08-09T07:33:02.884Z"
      }
    ]
  },
  "meta": { "count": 2, "generatedAt": "2026-08-25T14:36:38.201Z" }
}
```

`themes` trae **todos** los temas vivos del horizonte, sin paginar (son decenas como mucho),
ordenados por vitalidad descendente. `meta.count` es su número.

---

### 4.13 `GET /categories`

Catálogo de categorías con su conteo de señales.

**Query params**: ninguno. No pagina.

```bash
curl -s "https://$T4F_HOST/api/public/v1/categories" \
  -H "Authorization: Bearer AbC0dEf1GhI2jKl3MnO4pQr5StU6vWx7YzA8bCd9EfG"
```

```json
{
  "data": [
    {
      "name": "Gobernanza y regulación",
      "description": "Normas, votaciones, litigios y estándares que definen qué se puede construir y desplegar, y quién responde cuando algo sale mal.",
      "examples": [
        "Un parlamento aprueba un marco de responsabilidad para agentes",
        "Una agencia publica un estándar de auditoría de modelos"
      ],
      "position": 0,
      "isFallback": false,
      "signalCount": 218,
      "inCatalog": true
    },
    {
      "name": "Futuro del trabajo",
      "description": "Cómo cambia la tarea, el oficio y la relación laboral cuando parte del trabajo lo hace un modelo.",
      "examples": [
        "Un estudio mide la productividad de equipos con y sin asistente",
        "Un sindicato negocia cláusulas sobre uso de IA"
      ],
      "position": 1,
      "isFallback": false,
      "signalCount": 176,
      "inCatalog": true
    },
    {
      "name": "Otros",
      "description": "Categoría de último recurso para señales que todavía no encajan en ninguna otra.",
      "examples": [],
      "position": 8,
      "isFallback": true,
      "signalCount": 31,
      "inCatalog": true
    },
    {
      "name": "Infraestructura energética",
      "description": "",
      "examples": [],
      "position": -1,
      "isFallback": false,
      "signalCount": 7,
      "inCatalog": false
    }
  ],
  "meta": { "nextCursor": null, "hasMore": false, "count": 4, "generatedAt": "2026-08-25T14:37:02.663Z" }
}
```

- **`inCatalog: true`** — categoría del catálogo curado. Trae `description`, `examples`,
  `position` e `isFallback` reales. Aparece aunque su `signalCount` sea `0`.
- **`inCatalog: false`** — categoría que **propuso el modelo** al clasificar y que todavía
  no está en el catálogo curado. **Es una feature, no un error.** Como no existe fila de
  catálogo detrás, se emiten los valores convencionales `description: ""`, `examples: []`,
  `position: -1`, `isFallback: false`. (Decisión tomada por ambigüedad del plan: el DTO
  exige esos campos y una propuesta no los tiene.)
- Orden: primero las del catálogo por `position` ascendente, luego las propuestas por
  `signalCount` descendente.
- `LikedItem.category` es un string libre, no una clave foránea; por eso existen las
  propuestas.
- Las señales **sin categoría** (`category: null`) no producen una fila aquí. Para contarlas,
  se restan de `meta.counts.publishedSignals` (nombre heredado; ver §5) o se listan con `/signals`
  y se filtran en cliente.

---

### 4.14 `GET /pestel`

Las seis dimensiones PESTEL con su conteo de señales.

**Query params**: ninguno. No pagina. Devuelve **siempre las seis**, en el orden del
acrónimo, aunque alguna tenga `signalCount: 0`.

Cada señal lleva **como máximo 2** dimensiones, así que la suma de `signalCount` puede
superar el total de señales.

```bash
curl -s "https://$T4F_HOST/api/public/v1/pestel" \
  -H "Authorization: Bearer AbC0dEf1GhI2jKl3MnO4pQr5StU6vWx7YzA8bCd9EfG"
```

```json
{
  "data": [
    { "key": "political",     "letter": "P", "label": "Político",    "signalCount": 214 },
    { "key": "economic",      "letter": "E", "label": "Económico",   "signalCount": 331 },
    { "key": "social",        "letter": "S", "label": "Social",      "signalCount": 502 },
    { "key": "technological", "letter": "T", "label": "Tecnológico", "signalCount": 806 },
    { "key": "environmental", "letter": "E", "label": "Ambiental",   "signalCount": 88 },
    { "key": "legal",         "letter": "L", "label": "Legal",       "signalCount": 173 }
  ],
  "meta": { "nextCursor": null, "hasMore": false, "count": 6, "generatedAt": "2026-08-25T14:37:20.995Z" }
}
```

La letra `E` se repite a propósito (Económico y Ambiental/Ecológico): el acrónimo es en
inglés y las etiquetas están en español, así que la letra viaja aparte para que se entienda
de dónde sale el nombre. **`key` es lo que se guarda y lo que aceptan los filtros; `label`
es solo para mostrar** y puede cambiar sin migrar datos.

---

### 4.15 `GET /graph`

El grafo semántico completo de las señales del banco: nodos y aristas.

> Endpoint **caro**: rate limit aparte de **10 peticiones por minuto**. Para lectura normal
> se usan temas y horizontes; este endpoint es para dibujar el mapa o razonar sobre topología.

| Param | Tipo | Default | Oblig. | Validación |
|---|---|---|---|---|
| `horizon` | enum | — | no | `H1` \| `H2` \| `H3`. Restringe los nodos a señales de temas de ese horizonte; las aristas se recortan a los nodos que quedan. |
| `minVitality` | float | — | no | `>= 0`. Descarta nodos por debajo del umbral. |
| `minScore` | float | *(sin default: no filtra si se omite)* | no | `0..1`. Solo se aplica un `score >= minScore` extra cuando el parámetro viene — igual que en `/signals/{id}/neighbors` ([§4.5](#45-get-signalsidneighbors)), toda arista ya está por encima de `LINK_THRESHOLD = 0.55` por construcción. |
| `limit` | int | `500` | no | `1..2000`. Tope de **nodos**; se recorta por vitalidad descendente. Las aristas cuyos dos extremos no sobrevivan al corte se descartan. |

```bash
curl -s "https://$T4F_HOST/api/public/v1/graph?horizon=H2&minScore=0.7&limit=3" \
  -H "Authorization: Bearer AbC0dEf1GhI2jKl3MnO4pQr5StU6vWx7YzA8bCd9EfG"
```

```json
{
  "data": {
    "nodes": [
      {
        "id": "c7f3a914-20bc-4d4c-9c51-940f372e0d8a",
        "title": "El Parlamento Europeo aprueba el reglamento de agentes autónomos",
        "vitality": 0.87,
        "themeId": "4e9b1c72-8a30-4f11-b8d6-2c5a7e0d91f4",
        "category": "Gobernanza y regulación",
        "horizon": "H2"
      },
      {
        "id": "9b21e0d4-5f7a-4c88-91b3-6ea0c4f27d15",
        "title": "Cuando el asistente decide por ti: fricción y delegación en el trabajo del conocimiento",
        "vitality": 0.74,
        "themeId": "4e9b1c72-8a30-4f11-b8d6-2c5a7e0d91f4",
        "category": "Futuro del trabajo",
        "horizon": "H2"
      },
      {
        "id": "31a7c5be-0d92-4a60-8f74-b1e3d8c04a27",
        "title": "Auditoría de bitácoras: qué registra realmente un agente en producción",
        "vitality": 0.71,
        "themeId": "4e9b1c72-8a30-4f11-b8d6-2c5a7e0d91f4",
        "category": "Gobernanza y regulación",
        "horizon": "H2"
      }
    ],
    "edges": [
      {
        "a": "9b21e0d4-5f7a-4c88-91b3-6ea0c4f27d15",
        "b": "c7f3a914-20bc-4d4c-9c51-940f372e0d8a",
        "score": 0.8123,
        "strength": "fuerte"
      },
      {
        "a": "31a7c5be-0d92-4a60-8f74-b1e3d8c04a27",
        "b": "c7f3a914-20bc-4d4c-9c51-940f372e0d8a",
        "score": 0.7418,
        "strength": "media"
      },
      {
        "a": "31a7c5be-0d92-4a60-8f74-b1e3d8c04a27",
        "b": "9b21e0d4-5f7a-4c88-91b3-6ea0c4f27d15",
        "score": 0.7052,
        "strength": "media"
      }
    ],
    "stats": {
      "nodes": 3,
      "edges": 3,
      "themesAlive": 9,
      "themesDead": 41,
      "orphans": 0
    }
  },
  "meta": { "generatedAt": "2026-08-25T14:37:55.410Z" }
}
```

- Solo son nodos las señales **con embedding** (`embeddedAt != null`). En la práctica esto
  ya excluye casi toda señal `pending` (el job de embeddings solo embebe señales
  publicadas), pero no es un filtro de `publishStatus` explícito en esta consulta —es un
  efecto de cómo funciona hoy el pipeline de embeddings, no una garantía del contrato.
- Toda arista tiene sus dos extremos en el banco. El par va **ordenado**: `a < b`
  lexicográficamente, siempre.
- `stats.nodes` y `stats.edges` son del **resultado ya filtrado y recortado** por
  `limit`/`horizon`/`minVitality`/`minScore`. `themesAlive` y `themesDead` sí son del
  **banco completo del dueño** (no se filtran por horizonte). `orphans`, en cambio,
  **cuenta dentro del resultado devuelto**: es `nodes.filter(n => n.themeId === null).length`
  sobre los nodos que sobrevivieron al corte de `limit`, no un conteo global de huérfanas
  del banco — si `limit` recortó el conjunto, `orphans` puede no reflejar el total de
  huérfanas que existen. Para el total real de huérfanas del banco, usa
  `/signals?orphans=true` con `meta.total`.
- Si `limit` recortó el número de nodos por debajo del total que casaba los filtros,
  `meta.truncated: true` lo dice explícitamente (nunca en silencio).

---

### 4.16 `GET /snapshots`

Corridas del grafo. Cada snapshot es una foto completa del mapa en un momento; con dos o
más se ve nacer, crecer y apagarse a los temas.

| Param | Tipo | Default | Oblig. | Validación |
|---|---|---|---|---|
| `cursor` | string opaco | — | no | De `meta.nextCursor`. |
| `limit` | int | `25` | no | `1..100` |
| `from` | fecha | — | no | Sobre `takenAt`, inclusivo. |
| `to` | fecha | — | no | Sobre `takenAt`, inclusivo. |

Orden: `takenAt` descendente (la corrida más reciente primero).

```bash
curl -s "https://$T4F_HOST/api/public/v1/snapshots?from=2026-08-23&limit=2" \
  -H "Authorization: Bearer AbC0dEf1GhI2jKl3MnO4pQr5StU6vWx7YzA8bCd9EfG"
```

```json
{
  "data": [
    {
      "id": "f2c81d47-6b39-4e05-a71c-90d3e5f8b264",
      "takenAt": "2026-08-25T06:00:11.402Z",
      "trigger": "cron",
      "nodes": 1483,
      "links": 6294,
      "themesAlive": 27,
      "themesDead": 41,
      "orphans": 112
    },
    {
      "id": "0a5e73b1-c418-4d92-86f0-27ad9c1e4b58",
      "takenAt": "2026-08-23T18:41:52.667Z",
      "trigger": "publish",
      "nodes": 1479,
      "links": 6251,
      "themesAlive": 27,
      "themesDead": 41,
      "orphans": 115
    }
  ],
  "meta": {
    "nextCursor": "djF8MjAyNi0wOC0yM1QxODo0MTo1Mi42NjdafDBhNWU3M2IxLWM0MTgtNGQ5Mi04NmYwLTI3YWQ5YzFlNGI1OA",
    "hasMore": true,
    "count": 2,
    "total": 214,
    "generatedAt": "2026-08-25T14:38:11.070Z"
  }
}
```

`trigger` dice qué disparó la corrida: `embed` (terminó el job de embeddings),
`cron` (la corrida diaria), `publish` (se publicó o despublicó una señal) o
`manual` (alguien la lanzó a mano).

---

### 4.17 `GET /snapshots/{id}`

Una corrida con el estado de **todos** sus temas en ese momento, y opcionalmente la
membresía señal→tema.

| Param | Tipo | Default | Oblig. | Validación |
|---|---|---|---|---|
| `id` (ruta) | uuid | — | **sí** | Id de un `GraphSnapshot`; si no existe → 404. |
| `includeMembers` | bool | `false` | no | `true` añade `members`. |

> **Este endpoint entero es "caro" (10 peticiones/min), tenga o no `?includeMembers`.**
> La decisión de qué bucket de rate limit usar se toma en `withPublicApi(handler,
> { expensive: true })`, **antes** de que el handler lea ningún query param — así que no
> hay forma de aplicarla solo cuando se pide la membresía. Una llamada simple a
> `/snapshots/{id}` sin `includeMembers` ya cuenta contra el bucket de 10/min, no contra
> el general de 120/min.

Con `includeMembers=true`, `members` trae **como máximo 5000 filas** (cap duro). Si se
alcanzó el tope, `meta.truncated` viene `true`; si no se alcanzó, viene `false`. Sin
`includeMembers`, la clave `members` **no aparece** y `meta.truncated` tampoco.

Un snapshot es conceptualmente inmutable (una foto histórica, nunca cambia), pero la
implementación de hoy no le da un perfil de caché aparte: usa el mismo perfil `static`
que `/categories` y `/pestel` — `Cache-Control: private, max-age=3600,
stale-while-revalidate=7200` —, no el `max-age=86400, immutable` que podría esperarse de
algo que nunca cambia. Ver la nota de [§3.4](#34-cabeceras-de-respuesta-y-caché).

```bash
curl -s "https://$T4F_HOST/api/public/v1/snapshots/f2c81d47-6b39-4e05-a71c-90d3e5f8b264?includeMembers=true" \
  -H "Authorization: Bearer AbC0dEf1GhI2jKl3MnO4pQr5StU6vWx7YzA8bCd9EfG"
```

```json
{
  "data": {
    "id": "f2c81d47-6b39-4e05-a71c-90d3e5f8b264",
    "takenAt": "2026-08-25T06:00:11.402Z",
    "trigger": "cron",
    "nodes": 1483,
    "links": 6294,
    "themesAlive": 27,
    "themesDead": 41,
    "orphans": 112,
    "themes": [
      {
        "themeId": "4e9b1c72-8a30-4f11-b8d6-2c5a7e0d91f4",
        "name": "Responsabilidad legal de los agentes autónomos",
        "size": 14,
        "status": "alive",
        "vitality": 4.12,
        "velocity30d": 6,
        "density": 0.7134,
        "connectivity": 0.2857,
        "novelty": 0.4021,
        "horizon": "H2"
      },
      {
        "themeId": "e04f21b7-6c85-4a30-9d12-3f70b8ea5c69",
        "name": "Duelo y memoria con modelos de lenguaje",
        "size": 5,
        "status": "alive",
        "vitality": 1.63,
        "velocity30d": 2,
        "density": 0.6488,
        "connectivity": 0.1111,
        "novelty": 0.6902,
        "horizon": "H3"
      },
      {
        "themeId": "83b5f014-9d27-4c6a-b0e8-14a7c2593fd6",
        "name": "Chatbots de atención al cliente de primera generación",
        "size": 6,
        "status": "dead",
        "vitality": 0.41,
        "velocity30d": 0,
        "density": 0.5903,
        "connectivity": 0.0,
        "novelty": 0.2117,
        "horizon": null
      }
    ],
    "members": [
      {
        "itemId": "c7f3a914-20bc-4d4c-9c51-940f372e0d8a",
        "themeId": "4e9b1c72-8a30-4f11-b8d6-2c5a7e0d91f4",
        "vitality": 0.87
      },
      {
        "itemId": "9b21e0d4-5f7a-4c88-91b3-6ea0c4f27d15",
        "themeId": "4e9b1c72-8a30-4f11-b8d6-2c5a7e0d91f4",
        "vitality": 0.74
      },
      {
        "itemId": "7e40b28c-13da-4f57-9c86-05b1e9a37d24",
        "themeId": null,
        "vitality": 0.19
      }
    ]
  },
  "meta": {
    "count": 3,
    "truncated": false,
    "generatedAt": "2026-08-25T14:38:44.826Z"
  }
}
```

- `themes` trae **todos** los temas de la corrida, vivos y fósiles, ordenados por vitalidad
  descendente. `meta.count` es su número.
- Un tema `dead` tiene `horizon: null`: la heurística de horizonte solo corre sobre los vivos.
- En `members`, `themeId: null` significa **señal huérfana** en esa corrida: estaba en el
  grafo pero no cayó en ningún tema.

---

## 5. DTOs

Bloques TypeScript exactos. Un campo ausente de estos tipos **no sale por la API**
(ver [§1.2](#12-qué-no-expone-lista-negra)).

Convenciones de tipo:
- Todo `Decimal` de Prisma se serializa como `number` (nunca como string).
- Todo `Date` se serializa como `string` ISO 8601 UTC.
- `null` significa "no hay valor"; el campo **está presente** con valor `null`. Solo los
  campos marcados con `?` pueden faltar de la respuesta.

```ts
/** Los tres horizontes. Conjunto cerrado; ver HORIZON_LABELS para las etiquetas. */
export type HorizonKey = "H1" | "H2" | "H3";
```

### Señal

```ts
export type SignalSummaryDTO = {
  id: string;
  /** x_like = lo trajo la ingesta de likes de X. manual = se pegó el enlace a mano. */
  source: "x_like" | "manual";
  /** contentTitle si existe; si no, los primeros 120 caracteres de tweetText. */
  title: string;
  /** contentUrl si existe; si no, tweetUrl. El enlace que se le muestra a una persona. */
  url: string;
  /** Handle de X sin @. En señales manuales, el dominio del enlace. */
  authorHandle: string;
  authorName: string | null;
  /** ESTIMADA. Ver likedAtEstimated / likedAtSource y §3.3. */
  likedAt: string;
  /** Literal `true`, siempre. Recordatorio en el payload de que likedAt es aproximada. */
  likedAtEstimated: true;
  /** tweet_date = solo acotada por la fecha del tweet. ordered = además por el orden de likes. */
  likedAtSource: "tweet_date" | "ordered";
  /**
   * Estado de curaduría: `published` = la persona ya lo revisó; `pending` = todavía no.
   * NO es un filtro ni un permiso — es un dato, SIEMPRE presente (no opcional). El banco
   * es de quien pregunta y lo ve entero por defecto; filtrable con `?publishStatus=`
   * (ver §4.3). Confirmado en `public-dto.ts` (`SignalSummaryDTO.publishStatus`, tipo
   * `PublishStatus`, no opcional).
   */
  publishStatus: "pending" | "published";
  /** Nombre de categoría, string libre. null = sin clasificar. */
  category: string | null;
  /** Claves PESTEL (political | economic | social | technological | environmental | legal). Máximo 2. */
  pestel: string[];
  /** Etiquetas libres del pipeline (3-5 palabras). [] si la señal aún no pasó por él. */
  tags: string[];
  /** Resumen de ~100 palabras de lo que trata la señal. */
  tldr: string | null;
  /** Vitalidad de la señal en la última corrida: 0.5^(días desde likedAt / 30), reanimada
      por vecinas recientes. null = nunca entró al grafo (sin embedding). */
  vitality: number | null;
  /** El tema al que pertenece. null = señal huérfana. */
  theme: { id: string; name: string; status: "alive" | "dead"; horizon: HorizonKey | null } | null;
};

export type SignalDetailDTO = SignalSummaryDTO & {
  /** Id del tweet. En señales manuales, un id sintético `manual:<uuid>`. */
  tweetId: string;
  tweetText: string;
  tweetUrl: string;
  /** EXACTA (derivada del snowflake id). null en señales manuales. Se muestra sin virgulilla. */
  tweetCreatedAt: string | null;
  mediaUrls: string[];
  contentUrl: string | null;
  contentTitle: string | null;
  contentDescription: string | null;
  contentImageUrl: string | null;
  contentPublishedAt: string | null;
  /** Confianza del clasificador, 0..1. Decimal de Prisma serializado como number. */
  categoryConfidence: number | null;
  /** Razón corta del modelo al clasificar; sirve para auditar mal-clasificaciones. */
  categoryReasoning: string | null;
  /** Por qué esta señal importa como indicio de futuro. */
  whyMatters: string | null;
  /** Cómo puede cambiar esto el desarrollo de la IA y la interacción entre humanos. */
  impact: string | null;
  publishedAt: string | null;
  /** Momento de la corrida del grafo que calculó `vitality`. */
  vitalityAt: string | null;
  /** Número de aristas de esta señal con otras señales del banco. */
  neighborCount: number;
};
```

### Vecino semántico

```ts
export type NeighborDTO = {
  signal: SignalSummaryDTO;
  /** Similitud coseno cruda, 0..1. Para razonamiento del agente, no para mostrar. Ver §7. */
  score: number;
  /** Etiqueta cualitativa derivada de score. Esto es lo que se le muestra a una persona. */
  strength: "fuerte" | "media" | "debil";
};
```

### Tema

```ts
export type ThemeSummaryDTO = {
  id: string;
  /** Nombre que le puso el modelo al bautizar el tema. Cambia si cambia la membresía. */
  name: string;
  /** Por qué estas señales van juntas. */
  summary: string;
  /** alive = vivo. dead = fósil: no borrado, y reversible (puede resucitar). */
  status: "alive" | "dead";
  /** Número de señales del tema en la última corrida. */
  size: number;
  /** Suma de la vitalidad de sus miembros. */
  vitality: number;
  /** Horizonte EFECTIVO. null en temas fósiles (la heurística solo corre sobre los vivos). */
  horizon: HorizonKey | null;
  /** Lo que la heurística propuso en la última corrida, se haya aplicado o no. */
  horizonSuggested: HorizonKey | null;
  /** manual = alguien fijó el horizonte a mano y la heurística ya no lo pisa. */
  horizonSource: "auto" | "manual";
  /** Macro-tema al que pertenece. OJO: su id NO es estable entre corridas. */
  macroTheme: { id: string; name: string } | null;
  /** likedAt de la señal más reciente del tema. */
  lastSignalAt: string | null;
};

export type ThemeDetailDTO = ThemeSummaryDTO & {
  /** Cuándo nació este linaje. Sobrevive entre corridas. */
  firstSeenAt: string;
  /** Cuándo murió, si es fósil. null si está vivo. */
  diedAt: string | null;
  /** Cuántas veces murió y volvió. */
  revivedCount: number;
  indicators: {
    /** Señales nuevas en los últimos 30 días. */
    velocity30d: number;
    /** Señales nuevas en los 30 días anteriores a esos. */
    velocityPrev30d: number;
    /** velocity30d - velocityPrev30d, ya restado para que el agente no lo calcule. */
    velocityDelta: number;
    /** Cohesión: media de la similitud coseno de los miembros al centroide del tema. */
    density: number | null;
    /** Aristas salientes / aristas totales que tocan el tema. Alta = tema puente. */
    connectivity: number | null;
    /** Distancia coseno del centroide del tema al centroide global. Alta = periférico. */
    novelty: number | null;
    /** Número de temas distintos alcanzados por sus aristas salientes. */
    bridgeThemes: number;
  };
  /** Última membresía conocida (lastMemberIds). Es la única forma de saber qué señales
      tuvo un tema fósil: sus señales ya tienen clusterId null. Ordenados. */
  memberIds: string[];
};

export type ThemeHistoryDTO = {
  themeId: string;
  /** SIEMPRE en orden ascendente por takenAt. */
  points: (SnapshotThemeRowDTO & { takenAt: string; trigger: SnapshotTrigger })[];
};
```

### Macro-tema

```ts
export type MacroThemeDTO = {
  /** NO es estable: los macro-temas se borran y recrean en cada corrida. No lo guardes. */
  id: string;
  name: string;
  summary: string;
  horizon: HorizonKey;
  /** Poblado en /macro-themes y en /horizons/{key}. Viene vacío en el listado /horizons. */
  themes: ThemeSummaryDTO[];
};
```

### Horizonte

```ts
export type HorizonDTO = {
  key: HorizonKey;
  /** De HORIZON_LABELS, p. ej. "H2 · en transición". */
  labelShort: string;
  /** De HORIZON_LABELS, la explicación larga. */
  labelLong: string;
  /** Temas VIVOS en este horizonte. */
  themeCount: number;
  /** Señales que pertenecen a esos temas vivos. */
  signalCount: number;
  /** Suma de la vitalidad de esos temas. */
  vitalitySum: number;
  macroThemes: MacroThemeDTO[];
};

/** Lo que devuelve /horizons/{key}. */
export type HorizonDetailDTO = HorizonDTO & { themes: ThemeSummaryDTO[] };
```

### Categoría y PESTEL

```ts
export type CategoryDTO = {
  name: string;
  /** "" cuando inCatalog es false. */
  description: string;
  /** [] cuando inCatalog es false. */
  examples: string[];
  /** Orden en el catálogo curado. -1 cuando inCatalog es false. */
  position: number;
  /** La única categoría de último recurso del catálogo. */
  isFallback: boolean;
  /** Señales con esta categoría. */
  signalCount: number;
  /** false = la propuso el modelo y aún no está en el catálogo curado. Es una feature. */
  inCatalog: boolean;
};

export type PestelDTO = {
  /** Lo que se guarda y lo que aceptan los filtros. */
  key: string;
  /** Letra del acrónimo en inglés; la E se repite (Económico y Ambiental). */
  letter: string;
  /** Etiqueta en español, solo para mostrar. Puede cambiar sin migrar datos. */
  label: string;
  signalCount: number;
};
```

### Snapshot

```ts
/** Qué disparó la corrida del grafo. */
export type SnapshotTrigger = "embed" | "cron" | "publish" | "manual";

export type SnapshotSummaryDTO = {
  id: string;
  takenAt: string;
  trigger: SnapshotTrigger;
  /** Señales en el grafo en esa corrida. */
  nodes: number;
  /** Aristas en esa corrida. */
  links: number;
  themesAlive: number;
  themesDead: number;
  /** Señales del grafo sin tema en esa corrida. */
  orphans: number;
};

export type SnapshotThemeRowDTO = {
  themeId: string;
  /** El nombre que tenía el tema EN ESA CORRIDA; puede diferir del actual. */
  name: string;
  size: number;
  /** "alive" | "dead" en ese momento. Se expone como string porque es histórico. */
  status: string;
  vitality: number;
  velocity30d: number;
  density: number | null;
  connectivity: number | null;
  novelty: number | null;
  horizon: HorizonKey | null;
};

export type SnapshotMemberDTO = {
  itemId: string;
  /** null = señal huérfana en esa corrida. */
  themeId: string | null;
  vitality: number;
};

export type SnapshotDetailDTO = SnapshotSummaryDTO & {
  themes: SnapshotThemeRowDTO[];
  /** Solo con ?includeMembers=true. Cap duro de 5000 filas; ver meta.truncated. */
  members?: SnapshotMemberDTO[];
};
```

### Grafo

```ts
export type LinkStrength = "fuerte" | "media" | "debil";

export type GraphDTO = {
  nodes: {
    id: string;
    title: string;
    vitality: number | null;
    themeId: string | null;
    category: string | null;
    horizon: HorizonKey | null;
  }[];
  edges: {
    /** El par va ordenado: a < b lexicográficamente, siempre. */
    a: string;
    b: string;
    score: number;
    strength: LinkStrength;
  }[];
  stats: {
    /** Del resultado ya filtrado. */
    nodes: number;
    edges: number;
    /** Del banco (o del horizonte filtrado), como contexto. */
    themesAlive: number;
    themesDead: number;
    orphans: number;
  };
};
```

### Meta y health

```ts
export type MetaDTO = {
  apiVersion: "v1";
  generatedAt: string;
  counts: {
    /** Total de señales del banco del dueño, publicadas o no. */
    signals: number;
    /** Subconjunto de `signals` con `publishStatus: 'published'` (las que entran al grafo). */
    publishedSignals: number;
    themesAlive: number;
    themesDead: number;
    macroThemes: number;
    /** Aristas del grafo con ambos extremos en el banco. */
    links: number;
    /** Categorías del catálogo curado (no incluye las propuestas). */
    categories: number;
    snapshots: number;
  };
  /** takenAt del snapshot más reciente. null si nunca corrió el grafo. */
  lastGraphRunAt: string | null;
  dateRange: {
    earliestLikedAt: string | null;
    latestLikedAt: string | null;
  };
  /** Constantes EFECTIVAS en el servidor. No las quemes en el cliente: léelas de aquí. */
  domain: {
    /** Vida media de la vitalidad de una señal, en días. */
    halfLifeDays: number;
    /** Vida media de una señal huérfana: la mitad de halfLifeDays. */
    orphanHalfLifeDays: number;
    /** Vitalidad por debajo de la cual un tema se declara fósil. */
    deadThreshold: number;
    /** Similitud coseno mínima para que un par de señales sea arista. */
    linkThreshold: number;
    /** Tamaño mínimo para que una comunidad sea tema. */
    minThemeSize: number;
    maxMacroPerHorizon: number;
  };
};

export type HealthDTO = {
  /** "degraded" exactamente cuando `db` no es "ok". La respuesta sigue siendo 200. */
  status: "ok" | "degraded";
  apiVersion: "v1";
  /** OJO: el literal de fallo es "down", no "error". */
  db: "ok" | "down";
  /** ISO 8601 UTC del momento de la sonda. */
  checkedAt: string;
};
```

`HealthDTO` no lleva ningún conteo, ni de la plataforma ni del propio banco: ver el
razonamiento en [§4.2](#42-get-health).

---

## 6. Errores

Forma **exacta** del cuerpo de error. Siempre estas dos claves de primer nivel, siempre
estas tres claves dentro de `error`:

```json
{
  "error": {
    "code": "not_found",
    "message": "No existe una señal con ese id.",
    "param": null
  },
  "meta": {
    "apiVersion": "v1",
    "generatedAt": "2026-08-25T14:39:02.331Z"
  }
}
```

- `code` — enum estable. **Es lo que un cliente debe ramificar**, nunca el `message`.
- `message` — texto en español, legible, orientado a qué hacer. Puede cambiar sin subir versión.
- `param` — nombre del parámetro culpable, o `null`. Solo lo llena `invalid_parameter`.
- Las respuestas de error llevan `X-T4F-Api-Version: v1` y `Cache-Control: no-store`.
- El envelope de error **no** lleva `data`, y el de éxito **no** lleva `error`.

```ts
export type ErrorCode =
  | "unauthorized"
  | "invalid_api_key"
  | "rate_limited"
  | "not_found"
  | "invalid_parameter"
  | "internal_error";
```

**Solo 6 códigos — sin `api_disabled`.** El contrato single-tenant tenía un séptimo código,
`api_disabled` (503), para cuando faltaban las claves de servicio por variable de entorno.
Aquí no existen claves de entorno (§2): la API está disponible siempre que haya base de
datos, así que ese código desapareció por completo, no solo de la práctica sino del tipo
`ErrorCode` real en `public-api-response.ts`. Si alguna vez ves `api_disabled` en un
cliente MCP, es un tipo desfasado del cliente — no algo que esta API pueda emitir.

| Status | `code` | Cuándo se emite | Cabeceras extra |
|---|---|---|---|
| `400` | `invalid_parameter` | Cursor corrupto o no decodificable; `horizon` fuera de `H1`/`H2`/`H3`; `limit` no numérico, ≤ 0 o por encima del máximo del endpoint; fecha que no parsea; clave PESTEL desconocida; `sort` o `status` fuera del enum; booleano que no es `true`/`false`; combinación imposible (`orphans=true` junto con `theme`). `param` lleva el nombre del parámetro. | — |
| `401` | `unauthorized` | Falta la cabecera `Authorization`, o no tiene la forma `Bearer <clave>`. | — |
| `401` | `invalid_api_key` | La clave no existe, fue revocada, o su usuario ya no existe. Cuenta contra el rate limit de intentos fallidos por IP. | — |
| `404` | `not_found` | El id de la ruta no existe en el banco del dueño de la clave — **da igual si no existe en absoluto o si existe en el banco de otra persona**. Mismo `code` y mismo `message` en ambos casos. | — |
| `405` | — | Verbo distinto de `GET`/`OPTIONS`. Lo genera Next.js automáticamente al no existir el handler; el cuerpo **no** sigue este formato. | `Allow: GET, OPTIONS` |
| `429` | `rate_limited` | Se superó el límite general (120/min **por `ownerId`**), el de endpoints caros (10/min: **todo** `/graph` y **todo** `/snapshots/{id}`, con o sin `includeMembers`) o el de intentos con clave inválida (10/min por IP). Agrupar por dueño y no por clave evita que alguien multiplique su cuota generando claves. | `Retry-After`, `X-RateLimit-*` |
| `500` | `internal_error` | Cualquier fallo no previsto. **Mensaje genérico siempre**: nunca el stack, nunca el error de Prisma, nunca el SQL. El detalle va al log del servidor. | — |

### Por qué un id de otro tenant devuelve 404 y no 403

**Es LA decisión de seguridad de esta API multi-tenant.**

Un `403 Forbidden` es una respuesta informativa: dice "este recurso existe, y hay algo
detrás que no te dejo ver". Aquí, un 403 permitiría a cualquiera con una clave válida
**sondear ids y descubrir qué existe en el banco de otras personas**: probar uuids y
distinguir, por el código de estado, los que no existen (404) de los que existen pero son
de alguien más (403). Eso filtra la existencia y el volumen del material de terceros, que
es justo lo que el aislamiento tiene que hacer inobservable.

Con **404 en los dos casos**, el banco ajeno es indistinguible de la nada: mismo status,
mismo `code`, mismo `message`, mismas cabeceras. Para un cliente, "no es tuyo" y "no
existe" son literalmente lo mismo. La API responde como si el universo terminara en el
banco del dueño de la clave — que es exactamente lo que se quiere.

La misma regla aplica hacia abajo: un tema, un snapshot o una arista de otro dueño no se
lista, no se resuelve por id, y sus señales nunca aparecen como vecinas, como miembros ni
como nodos del grafo.

> Esto **reemplaza** a la regla del contrato single-tenant ("un ítem no publicado devuelve
> 404 y no 403"). Aquella ya no aplica: la persona ve el 100% de su banco y no hay catálogo
> oculto a su propio dueño. La regla nueva es más importante, porque lo que protege ya no
> es material sin revisar sino los datos de terceros.

Un `403` **no aparece en ninguna parte de esta API**. Si un cliente lo recibe, viene de la
plataforma (un WAF, un proxy), no de estos handlers.

---

## 7. `score` vs `strength`

Los DTOs de vecino y de arista llevan **los dos** campos. No es redundancia: sirven a dos
lectores distintos.

### La decisión

Existe una regla de producto en tools4foresight: **nunca mostrarle a una persona el
porcentaje de similitud entre dos señales**. Un "0.63" leído por un humano se interpreta
como una medida precisa de algo, cuando en realidad es un coseno entre dos embeddings de
768 dimensiones sobre textos resumidos por un modelo. Es precisión falsa: sugiere una
exactitud que el número no tiene, e invita a comparaciones que no significan nada
("este par tiene 4 puntos más que aquel").

Pero esa regla es **de presentación, no de seguridad**. Y un **agente** sí necesita el
número crudo: sin él no puede ordenar vecinos por cercanía, no puede poner un umbral propio
al explorar el grafo, no puede decidir si dos saltos valen la pena. Ocultárselo lo obligaría
a razonar sobre tres cubetas cuando el dato continuo existe y es barato de transmitir.

Por eso: **se exponen los dos, con una convención de uso explícita.**

### Los umbrales

Todas las aristas del grafo ya están por encima de `LINK_THRESHOLD = 0.55`: por debajo de
ese piso el par de señales ni siquiera se guarda como arista. Sobre ese piso, `strength` se
deriva así:

| `strength` | Condición | Lectura |
|---|---|---|
| `"fuerte"` | `score >= 0.75` | Hablan de lo mismo. |
| `"media"` | `0.65 <= score < 0.75` | Se tocan; comparten marco o consecuencia. |
| `"debil"` | `score < 0.65` (con `score >= 0.55` por construcción) | Hay un hilo, pero es fino. |

`strength` se calcula en el servidor, no en el cliente: si los umbrales cambian, cambian en
un solo lugar y todos los consumidores se enteran a la vez.

### La convención de uso

> **Usa `strength` cuando redactes para una persona; `score` es para tu razonamiento
> interno. No muestres el porcentaje de similitud al usuario final.**

Esta frase, literal, va en tres sitios: en este documento, en `docs/DOMAIN.md`, y —lo más
importante— **en la descripción de la tool MCP `get_signal_neighbors`**, que es donde
realmente la lee el modelo que va a redactar la respuesta.

En la práctica, para quien implementa el cliente MCP:

- El markdown de `content` que ve el usuario menciona `fuerte` / `media` / `débil`, y
  **no contiene ningún `%` ni ningún decimal de similitud**. Hay un test que lo verifica.
- El `score` viaja en `structuredContent`, disponible para el razonamiento del agente y
  para ordenar.
- `strength` se muestra con acento (`débil`) aunque el valor del DTO sea `"debil"` sin
  acento: el DTO usa ASCII para que la comparación de strings no dependa de la
  normalización Unicode.

---

## 8. Notas para quien implementa

Detalles que no se deducen del contrato y que hay que respetar en los route handlers.

### `select` explícito en TODOS los queries — nunca tocar `embedding`

`LikedItem.embedding` es `Unsupported("vector(768)")`. Un `findMany` sin `select` no solo
arriesga filtrar el vector: **Prisma no sabe leer ese tipo** y el query puede fallar o
traer basura. Todos los queries sobre `LikedItem` llevan un `select` explícito con los
campos exactos que necesita el DTO. Nunca `include` a ciegas, nunca spread de la fila de
Prisma al JSON de respuesta. Es la regla que hace que la lista negra de §1.2 sea real y no
una intención.

### `ownerId` en un solo lugar — lo que sustituye al filtro de publicación

El contrato single-tenant inyectaba `publishStatus: 'published'` en `buildPublicWhere`,
siempre y sin forma de desactivarlo. **Ese filtro desaparece**: la persona ve todo su banco.

Lo que ocupa su sitio, con la misma disciplina y mucho más peso, es el dueño: todo acceso a
datos de tenant va dentro de `withOwner(ownerId, …)`, sobre tablas con RLS. Ningún handler
construye su propio `where` sobre `LikedItem` sin pasar por ahí.

`publishStatus` deja de ser un filtro fijo y pasa a ser un **campo del DTO**, expuesto
además como filtro opcional de entrada: `?publishStatus=published|pending|any` en
`/signals` (default `any`, no filtra nada — ver [§4.3](#43-get-signals)).

Hay **dos** verificaciones de aislamiento, y son complementarias:

- `scripts/qa-tenant-isolation.ts` (`npm run qa:tenant`) — nivel **base de datos**. Crea
  dos usuarios de prueba, les mete una señal a cada uno y comprueba, incluido por SQL
  crudo, que ninguno ve ni toca la del otro, y que un query fuera de `withOwner(...)`
  devuelve cero filas.
- `scripts/qa-public-api.ts` (`npm run qa:public`) — nivel **HTTP**, y es el criterio de
  aceptación de esta API. Levanta un `next dev` real en el puerto 3126, crea dos tenants
  con su clave cada uno y recorre los endpoints por HTTP. Va por HTTP y no importando los
  handlers a propósito: el camino real es Bearer → `src/proxy.ts` → route handler →
  `withPublicApi` → `withOwner`, y un test que invocara los handlers a mano se saltaría
  justo la capa (el proxy) de la que depende que nada de esto sea alcanzable.

Sus checks:

| Check | Qué verifica |
|---|---|
| 1 | Aislamiento endpoint por endpoint; que los ids de cada lista sean **exactamente** los del tenant; y que pedir con la clave de A un id de B dé **404, nunca 403** — en las dos direcciones, porque un fallo asimétrico es tan grave como uno simétrico. |
| 2 | Que los **agregados** no filtren (conteos de `/meta`, `/categories`, `/pestel`, `/horizons` no deben incluir nada del otro tenant). |
| 3 | Que **`ownerId`/`owner_id` no aparezca nunca** en ninguna respuesta — ni como clave ni como valor suelto. Cita explícitamente la lista negra de `public-dto.ts`. |
| 4 | Ciclo de vida de la clave: crear, usar, revocar, y que la revocada deje de servir. |
| 5 | Que el **proxy deje pasar `/api/public`**. Ese matcher es una línea que alguien puede "limpiar" sin enterarse de que deja al MCP entero devolviendo 401; este check existe para que se entere ahí. |
| 6 | Que se vea el **banco completo**: publicadas y pendientes, sin filtro impuesto. |
| 7 | **Paginación** sin repetidos ni saltos, con empates de `likedAt` (el caso que motiva el cursor compuesto de [§3.2](#32-paginación-por-cursor)). |

El `finally` borra los dos usuarios (el cascade se lleva su banco) y mata el `next dev`
aunque un check reviente a la mitad: la base de desarrollo tiene datos reales y no puede
quedar sucia.

### #5 `/signals/{id}/neighbors` — el par de `semantic_links` va ORDENADO

En la tabla `semantic_links` el par está normalizado con `itemAId < itemBId`, para que la
restricción de unicidad deduplique A–B y B–A. Consecuencia: **una señal puede aparecer en
cualquiera de las dos columnas**, y el query tiene que buscar en ambas y luego quedarse con
"el otro lado":

```ts
where: {
  OR: [{ itemAId: id }, { itemBId: id }],
  // Sin filtro de publicación: el banco es de quien pregunta y lo ve entero.
  // El aislamiento lo pone `withOwner(ownerId, …)`, no un `where` a mano.
},
orderBy: { score: "desc" },
```

y después, por cada fila, el vecino es `link.itemAId === id ? link.itemB : link.itemA`.
Buscar solo por `itemAId` devuelve la mitad de los vecinos, y la mitad que devuelve depende
del uuid de la señal, así que el bug se ve intermitente. Lo mismo vale para
`neighborCount` en `SignalDetailDTO`.

El mismo orden se preserva en `GraphDTO.edges`: `a < b` siempre, tal como está en la tabla.

### #7 `/themes/{id}` — `lastMemberIds` es lo único que tienen los temas fósiles

Cuando un tema muere, sus señales quedan con `clusterId = null`. La relación se pierde,
pero `SemanticCluster.lastMemberIds` conserva los ids de su última membresía conocida. Por
eso `memberIds` del `ThemeDetailDTO` sale de `lastMemberIds` **y no de un `include` de
`items`**, en temas vivos y fósiles por igual: así el campo significa lo mismo en ambos
casos, y un tema fósil sigue siendo consultable ("¿qué señales tuvo esto que se apagó?").

Corolario: `/themes/{id}/signals` devuelve `[]` para un tema fósil, y eso es correcto.
Quien quiera reconstruir un fósil recorre `memberIds` y pide cada señal por su id.

### #9 `/themes/{id}/history` — orden ASCENDENTE, siempre

```ts
orderBy: { snapshot: { takenAt: "asc" } },
include: { snapshot: { select: { takenAt: true, trigger: true } } },
```

Es el único endpoint que no ordena descendente. La razón: la serie se consume para graficar
y para derivar tendencias, y una serie temporal al revés es una fuente de errores de signo
silenciosos. El recorte por `limit` se aplica con `take: limit` **sobre el resultado ya
ordenado ascendente**: si hay más puntos que `limit` dentro del rango, los que sobran son
los **más recientes** (quedan fuera los últimos de la serie, no los primeros) — no hay una
segunda pasada que invierta el corte para quedarse con los recientes. Un cliente que
necesite los puntos más nuevos de un tema con mucha historia debe acotar con `from`/`to`,
no confiar en que `limit` se lo dé.

El `name` se toma de la fila de `graph_snapshot_clusters`, no del tema actual: el histórico
conserva el nombre que el tema tenía en cada corrida.

### #11/#12 `/horizons` — agregar sobre temas vivos y reusar las etiquetas

Los agregados salen de `semanticCluster` agrupando por `horizon` con `status: 'alive'`, más
`macroCluster.findMany({ include: { clusters: true } })` para los macro-temas.
`labelShort` y `labelLong` se leen de `HORIZON_LABELS` (`src/lib/horizons.ts`) y las tres
claves de `HORIZONS`; **no se duplican como literales** en el route handler ni en el cliente.
Si se reescribe una etiqueta, cambia en un solo archivo.

Los tres horizontes se devuelven siempre, incluso vacíos: `themeCount: 0`, `signalCount: 0`,
`vitalitySum: 0`, `macroThemes: []`.

### #13 `/categories` — de `getCategoriesOverview(tx, ownerId)`

La firma de este repo ya no lleva el `publishedOnly: boolean` del origen: este repo tiene su
propia `category-service.ts` (CRUD de `/categorias`) con la firma
`getCategoriesOverview(tx, ownerId)`, que siempre cuenta el catálogo completo del tenant —
no hubo que forzar nada, la firma que ya existía aquí es la que corresponde una vez que no
hay `PUBLISHED_ONLY`. Del resultado:
- `distribution` → filas con `inCatalog: true`, con `description`, `examples`, `position`
  e `isFallback` de la fila de `Category`.
- `proposed` → filas con `inCatalog: false` y los valores convencionales de §4.13.
- `uncategorizedCount` **no** produce fila (no es una categoría).

### #15 `/graph` — cap por vitalidad y aristas coherentes

- Nodos: señales del dueño con `embeddedAt != null`. Ya no se filtra por `publishStatus`:
  una señal sin revisar que ya tiene embedding es parte del mapa de su dueña.
- `limit` corta por **vitalidad descendente**, no por fecha ni por orden de inserción.
- El corte se aplica **primero a los nodos**; después se descartan las aristas cuyos dos
  extremos no estén en el conjunto que sobrevivió. Devolver una arista que apunta a un nodo
  que no viene en `nodes` rompe cualquier renderizador.
- `select` explícito, con más razón que en ningún otro sitio: es el endpoint que más filas
  de `LikedItem` toca.

### #17 `/snapshots/{id}` — cap duro de 5000 en `includeMembers`

`GraphSnapshotMember` tiene una fila por señal y por corrida: con 1500 señales y 200
snapshots son cientos de miles de filas. Con `includeMembers=true`:

- `take: 5000` **duro**, no negociable por query param.
- Si se devolvieron exactamente 5000 filas, `meta.truncated = true`; si menos,
  `meta.truncated = false`. La clave `truncated` solo aparece cuando se pidió
  `includeMembers`.
- No hay paginación de `members` en `v1`: quien necesite la membresía completa de un
  snapshot grande, la reconstruye por temas. Si esto se vuelve una necesidad real, es
  material para `v2`.
- **Todo el endpoint**, no solo con `includeMembers=true`, cuenta contra el rate limit de
  endpoints caros (10/min), igual que `/graph`: `withPublicApi(handler, { expensive: true
  })` se decide antes de leer el query param (ver la nota en
  [§4.17](#417-get-snapshotsid)).

### El proxy tiene que dejar pasar `/api/public`

`src/proxy.ts` niega todo `/api/**` sin sesión y devuelve `401` antes de llegar al route
handler. `api/public` ya está en la negación del matcher, junto con `api/jobs` y
`api/auth`, porque esta API se autentica **adentro** con Bearer. **Confirmado en el
matcher real** (`"/((?!api/jobs|api/auth|api/public|onboarding/|...).*)"`): sin esa
entrada, los 17 endpoints responderían 401 antes de llegar a su propio handler y ninguno
de los ejemplos de este documento funcionaría. Si alguna vez se toca ese matcher, esta es
la primera cosa que hay que verificar que sigue ahí.

### `runtime = 'nodejs'` obligatorio

Prisma con `@prisma/adapter-pg` no corre en edge. Todo route handler de `/api/public/v1`
lleva `export const runtime = 'nodejs'`.

### `context.params` es una Promise

En Next.js 16 los parámetros de ruta llegan como promesa:

```ts
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
}
```

Es la firma que ya usan los handlers existentes del repo. Los GET no se cachean por defecto
desde Next 15, así que no hace falta `force-dynamic`; sí hace falta poner `Cache-Control`
a mano, que es lo que hace `ok()`.
