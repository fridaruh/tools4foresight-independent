# PLAN DE IMPLEMENTACIÓN — MCP_Tools4Foresight

> ⚠️ **DOCUMENTO HISTÓRICO, YA NO VIGENTE.** Este es el plan con el que se construyó
> la versión **single-tenant original** del servidor (el repo `MCP_Tools4Foresight`,
> antes de la bifurcación a `MCP_T4F_Multitenant`). Esa versión ya está construida
> y este plan cumplió su función; **se conserva sin reescribir** porque varios
> comentarios de `src/` (`docs/PLAN.md §2.5`, `§2.6`, `§2.7`, `§1.3`, etc.) citan
> secciones concretas de este documento como referencia de diseño, y renumerar o
> borrar el archivo dejaría esas citas apuntando a nada.
>
> **Lo que dice este plan sobre el modelo de auth y de datos ya NO es cierto.**
> La bifurcación multi-tenant lo cambió de raíz: no hay `MCP_ACCESS_TOKEN`, no
> hay `T4F_PUBLIC_API_KEYS` de entorno, no hay filtro `PUBLISHED_ONLY` que oculte
> lo no publicado, no hay distribución por `npx`, y el repo fuente ya no es
> `x-likes-curator` sino `tools4foresight`. Para el diseño **vigente**, la
> referencia es `docs/ARCHITECTURE.md`, `docs/API.md`, `docs/DEPLOYMENT.md` y
> `SECURITY.md` — este documento queda solo como archivo histórico y como mapa de
> qué sección de aquí originó qué comentario en el código. Donde este plan y esos
> documentos difieran, ganan ellos.

> Fuente única de verdad para todos los sub-agentes **durante la construcción original
> (ya completada)**. Si este documento y el código divergen hoy, no se actualiza este
> documento: se actualiza `docs/ARCHITECTURE.md` y compañía.

Dos repos involucrados en el plan original:
- **Fuente**: `/Users/fridaruh/Documents/Proyectos/x-likes-curator` (Next.js 16, Prisma 7, Neon+pgvector) — hoy `tools4foresight`, ya multi-tenant. Aquí se creó la API pública read-only.
- **Nuevo**: `/Users/fridaruh/Documents/Proyectos/MCP_Tools4Foresight` (TypeScript, MCP SDK) — el ancestro single-tenant de este repo (`MCP_T4F_Multitenant`). Aquí vivía el servidor MCP antes de la bifurcación.

---

## 0. Hallazgos de verificación (leídos en el código, no supuestos)

### 0.1 Next.js 16.2.12 — convenciones que aplican

- **`context.params` es una `Promise`**. Firma obligatoria:
  ```ts
  export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
  }
  ```
  Es la forma que ya usan `src/app/api/clusters/[id]/route.ts` y `src/app/api/liked-items/[id]/route.ts`. Consistencia > azúcar (`RouteContext<...>`).
- **Los GET no se cachean por defecto** (cambió en 15). No hace falta `force-dynamic`; sí hace falta poner `Cache-Control` a mano.
- **Cache Components NO está habilitado** en `next.config.ts` → **no** usar `use cache` / `cacheLife`.
- `export const runtime = 'nodejs'` es obligatorio (Prisma + `@prisma/adapter-pg` no corren en edge).
- **CORS**: cabeceras a mano en la `Response`. Un `OPTIONS` explícito reemplaza el automático.
- `NextResponse.json` es el patrón del repo; se mantiene.

### 0.2 BLOQUEANTE: el proxy corta todo `/api/**` sin sesión

`src/proxy.ts` termina con un matcher que niega `api/jobs|api/auth|api/billing/webhook|...`, y dentro hace:
```ts
if (request.nextUrl.pathname.startsWith("/api/")) {
  return NextResponse.json({ ok: false, error: "No autorizado" }, { status: 401 });
}
```
**Sin agregar `api/public` a la negación del matcher, TODA la API pública responde 401 antes de llegar al route handler.** Primer cambio a hacer.

### 0.3 Helpers reales del repo fuente (verificados)

| Archivo | Qué expone | Uso |
|---|---|---|
| `src/lib/prisma.ts` | `prisma` (PrismaClient con `PrismaPg`) | Directo |
| `src/lib/require-admin.ts` | `requireAdminApi`, `requireSessionApi`, `requireAccessApi`, `getAccess` | **NO se usan**: dependen de cookies. La API pública usa API key. |
| `src/lib/rate-limit.ts` | `isRateLimited(key, {windowMs, max})`, `requestIp(request)` | Se reutiliza tal cual. Best-effort por instancia (Map en memoria). |
| `src/lib/cron-auth.ts` | patrón `Authorization: Bearer <secret>` | **Se copia el patrón** para la API key. |
| `src/lib/horizons.ts` | `HORIZONS`, `HORIZON_LABELS`, `isHorizon` | Se reutiliza. |
| `src/lib/liked-items-query.ts` | `buildWhere(filters)`, `filtersFromSearchParams`, `DATE_RANGES`, `UNCATEGORIZED` | Se reutiliza `buildWhere`; se extiende sin tocarlo. |
| `src/lib/category-service.ts` | `getCategoriesOverview(publishedOnly)` | Se reutiliza con `publishedOnly = true`. |
| `src/config/pestel.ts` | `PESTEL_DIMENSIONS`, `pestelDimension`, `normalizePestel` | Se reutiliza para `/pestel`. |
| `src/lib/board-item.ts` | `toBoardItem`, `authorLabel`, `isManualItem` | **NO** se reutiliza el DTO (es de UI). Sí la disciplina `Decimal→number`, `Date→ISO`. |
| `src/lib/jobs/graph.ts` | `refreshGraph`, `computeVitality`, `suggestHorizons`, constantes | Solo se **lee** para documentar semántica. |
| `src/app/api/horizontes/export/route.ts` | CSV de temas/señales/historial | Referencia de qué campos ya se consideran publicables. |

### 0.4 Paginación: por qué cursor compuesto

`src/app/api/liked-items/route.ts` documenta que usa offset porque `likedAt` tiene empates y un cursor de campo único se salta filas. La API pública usa **keyset compuesto `(likedAt, id)`**, que sí es total y estable: `ORDER BY liked_at DESC, id DESC`. Con Prisma: `cursor: { id }` + `skip: 1` + `orderBy: [{ likedAt: 'desc' }, { id: 'desc' }]`. Cursor opaco en base64url: `v1|<likedAt ISO>|<id>`.

### 0.5 Semántica del dominio verificada en `src/lib/jobs/graph.ts`

- `HALF_LIFE_DAYS = 30` (env `GRAPH_HALF_LIFE_DAYS`), huérfanas a la mitad (`15`).
- `vitalidad(i) = max(propia(i), max_j propia(j)·score(i,j))`; `propia(i) = 0.5^(días/halfLife)`.
- `DEAD_THRESHOLD = 1.0`, `LINEAGE_JACCARD = 0.3`, `LINK_THRESHOLD = 0.55`, `LINK_TOP_K = 8`, `MIN_CLUSTER_SIZE = 3`.
- Vitalidad de un tema = **suma** de la vitalidad de sus miembros.
- `suggestHorizons`: `H3` si `size < 5 || vitality < 1.5 || novelty > p75`; `H1` si `size >= 8 && vitality >= 3 && novelty <= mediana`; `H2` el resto. `horizonSource='manual'` congela.
- `density` = media de similitud coseno de miembros al centroide del tema. `novelty` = distancia coseno del centroide del tema al centroide global. `connectivity` = aristas salientes / aristas totales que tocan el tema. `bridgeClusters` = nº de temas distintos alcanzados.
- `MAX_MACRO_PER_HORIZON = 5`; los macro-temas se **borran y recrean** en cada corrida (no tienen linaje).

### 0.6 MCP SDK — versión y API reales

Verificado inspeccionando `@modelcontextprotocol/sdk@1.30.0` (`dist/esm/server/mcp.d.ts` + ejemplos):

- **Instalar `@modelcontextprotocol/sdk@^1.30.0`**. `zod` es peer dep `^3.25 || ^4.0` → usar **`zod@^4.4.3`**, importado `import * as z from 'zod/v4'`.
- `registerTool(name, config, cb)` con `config = { title?, description?, inputSchema?, outputSchema?, annotations?, _meta? }`. **`inputSchema` es un `ZodRawShape` (objeto plano), NO un `z.object(...)`**:
  ```ts
  server.registerTool('greet', {
    title: 'Greeting Tool',
    description: 'A simple greeting tool',
    inputSchema: { name: z.string().describe('Name to greet') }
  }, async ({ name }) => ({ content: [{ type: 'text', text: `Hello, ${name}!` }] }));
  ```
- `outputSchema` también es raw shape, y obliga a devolver `structuredContent` además de `content`.
- `registerResource(name, uriOrTemplate, config, cb)`; para dinámicos, `new ResourceTemplate(uriTemplate, { list: undefined | cb, complete?: {...} })` — **`list` es obligatorio de especificar aunque sea `undefined`**.
- `registerPrompt(name, { title?, description?, argsSchema? }, cb)`; `argsSchema` es raw shape de `z.string()`.
- Transportes:
  - `StdioServerTransport` — `@modelcontextprotocol/sdk/server/stdio.js`.
  - **`WebStandardStreamableHTTPServerTransport`** — `@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js`. Recibe un `Request` y devuelve un `Response`: `return transport.handleRequest(request)`. **Es el que se usa en Vercel**. Opciones: `sessionIdGenerator?` (omitirlo = **stateless**), `enableJsonResponse?`, `eventStore?`, `allowedHosts?`.
  - `StreamableHTTPServerTransport` (Node/Express) es un wrapper. No hace falta.
  - **NO usar `SSEServerTransport`** (legacy).
- `exports` del SDK incluye wildcard `./*` → los deep imports `@modelcontextprotocol/sdk/server/mcp.js` son válidos.

---

## 1. API pública read-only en x-likes-curator

### 1.1 Principios

1. **Namespace versionado**: `/api/public/v1/...`. `v1` congelado; cambios rompientes → `v2`.
2. **Auth**: `Authorization: Bearer <T4F_PUBLIC_API_KEY>`, comparación en tiempo constante.
3. **Read-only de verdad**: solo `GET` (+ `OPTIONS`). Otros verbos → 405 automático de Next.
4. **Alcance blindado**: `publishStatus = 'published'` se aplica en un helper único.
5. Envelope uniforme `{ data, meta }` para listas; objeto plano para detalle.

### 1.2 Auth por API key — `src/lib/public-api-auth.ts` (NUEVO)

```ts
export type PublicApiKey = { id: string; label: string };
export class PublicApiError extends Error { status: number; code: string; }

/** Lee T4F_PUBLIC_API_KEYS (formato "label:clave,label2:clave2"). */
export function configuredKeys(): Map<string, PublicApiKey>;

/** null = autorizado. NextResponse = respuesta de error lista para devolver. */
export function requirePublicApiKey(request: Request): { key: PublicApiKey } | NextResponse;

/** crypto.timingSafeEqual sobre buffers del mismo largo. */
function safeEqual(a: string, b: string): boolean;
```

Comportamiento:
- Sin `Authorization` → `401 { error: { code: "unauthorized", message: "Falta la cabecera Authorization: Bearer <api-key>." } }`.
- Bearer inválido → `401 { code: "invalid_api_key" }`, y **cuenta contra el rate limit**: `isRateLimited(\`public-api:${requestIp(request)}\`, { windowMs: 60_000, max: 10 })` → `429`.
- Sin claves configuradas en env → `503 { code: "api_disabled" }`. **Nunca "abierto por defecto"**.
- Multi-clave con label para revocar una sin romper las demás; el label se loguea, **nunca la clave**.

Env nuevas en `.env.example` de x-likes-curator:
```
# API pública read-only para el MCP (namespace /api/public/v1).
# Formato: "label:clave" separadas por coma. Generar con:
# node -e "console.log('mcp-local:' + require('crypto').randomBytes(32).toString('base64url'))"
T4F_PUBLIC_API_KEYS=""
# Orígenes permitidos por CORS, separados por coma. Vacío = solo server-to-server.
T4F_PUBLIC_API_ALLOWED_ORIGINS=""
```

### 1.3 Helpers nuevos

**`src/lib/public-api-response.ts` (NUEVO)**
```ts
export const PUBLIC_API_VERSION = "v1";
export type ApiMeta = { nextCursor: string | null; hasMore: boolean; count: number; total?: number; generatedAt: string };
export function ok<T>(data: T, init?: { meta?: Partial<ApiMeta>; cache?: CacheProfile; request: Request }): NextResponse;
export function fail(code: ErrorCode, message: string, status: number, request?: Request): NextResponse;
export type ErrorCode =
  | "unauthorized" | "invalid_api_key" | "rate_limited" | "not_found"
  | "invalid_parameter" | "api_disabled" | "internal_error";
/** "live" (no-store), "short" (60s), "graph" (300s), "static" (3600s). */
export type CacheProfile = "live" | "short" | "graph" | "static";
export function corsHeaders(request: Request): Record<string, string>;
```
Cabeceras que pone `ok()`:
```
Content-Type: application/json; charset=utf-8
Cache-Control: private, max-age=<n>, stale-while-revalidate=<2n>   # o no-store para "live"
X-T4F-Api-Version: v1
Vary: Authorization, Origin
```
`private` y no `public`: el contenido es de paga, ningún CDN intermedio debe compartirlo entre claves.

**`src/lib/public-dto.ts` (NUEVO)** — mapea filas de Prisma a JSON estable. **Es la frontera de seguridad**: si un campo no está en un DTO, no sale.

```ts
// ---------- Señal ----------
export type SignalSummaryDTO = {
  id: string;
  source: "x_like" | "manual";
  title: string;                 // contentTitle ?? primeros 120 chars de tweetText
  url: string;                   // contentUrl ?? tweetUrl
  authorHandle: string;
  authorName: string | null;
  /** OJO: estimada. Ver likedAtEstimated/likedAtSource. */
  likedAt: string;               // ISO
  likedAtEstimated: true;        // literal: SIEMPRE es una estimación
  likedAtSource: "tweet_date" | "ordered";
  category: string | null;
  pestel: string[];              // claves de config/pestel.ts
  tldr: string | null;
  vitality: number | null;
  theme: { id: string; name: string; status: "alive" | "dead"; horizon: HorizonKey | null } | null;
};

export type SignalDetailDTO = SignalSummaryDTO & {
  tweetId: string;
  tweetText: string;
  tweetUrl: string;
  tweetCreatedAt: string | null; // exacto (derivado del snowflake)
  mediaUrls: string[];
  contentUrl: string | null;
  contentTitle: string | null;
  contentDescription: string | null;
  contentImageUrl: string | null;
  contentPublishedAt: string | null;
  categoryConfidence: number | null;   // Decimal -> number
  categoryReasoning: string | null;
  whyMatters: string | null;
  impact: string | null;
  publishedAt: string | null;
  vitalityAt: string | null;
  neighborCount: number;
};

// ---------- Vecino semántico ----------
export type NeighborDTO = {
  signal: SignalSummaryDTO;
  score: number;                       // coseno crudo [0,1]
  strength: "fuerte" | "media" | "debil";
};

// ---------- Tema (SemanticCluster) ----------
export type ThemeSummaryDTO = {
  id: string;
  name: string;
  summary: string;
  status: "alive" | "dead";
  size: number;
  vitality: number;
  horizon: HorizonKey | null;
  horizonSuggested: HorizonKey | null;
  horizonSource: "auto" | "manual";
  macroTheme: { id: string; name: string } | null;
  lastSignalAt: string | null;
};

export type ThemeDetailDTO = ThemeSummaryDTO & {
  firstSeenAt: string;
  diedAt: string | null;
  revivedCount: number;
  indicators: {
    velocity30d: number;
    velocityPrev30d: number;
    velocityDelta: number;             // derivado, para que el agente no reste
    density: number | null;
    connectivity: number | null;
    novelty: number | null;
    bridgeThemes: number;
  };
  memberIds: string[];                 // lastMemberIds (útil para temas fósiles)
};

// ---------- Macro-tema ----------
export type MacroThemeDTO = {
  id: string; name: string; summary: string; horizon: HorizonKey;
  themes: ThemeSummaryDTO[];
};

// ---------- Horizonte ----------
export type HorizonDTO = {
  key: HorizonKey;
  labelShort: string;                  // de HORIZON_LABELS
  labelLong: string;
  themeCount: number;
  signalCount: number;
  vitalitySum: number;
  macroThemes: MacroThemeDTO[];
};

// ---------- Categoría / PESTEL ----------
export type CategoryDTO = { name: string; description: string; examples: string[]; position: number; isFallback: boolean; signalCount: number; inCatalog: boolean };
export type PestelDTO = { key: string; letter: string; label: string; signalCount: number };

// ---------- Snapshot ----------
export type SnapshotSummaryDTO = { id: string; takenAt: string; trigger: "embed"|"cron"|"publish"|"manual"; nodes: number; links: number; themesAlive: number; themesDead: number; orphans: number };
export type SnapshotThemeRowDTO = { themeId: string; name: string; size: number; status: string; vitality: number; velocity30d: number; density: number|null; connectivity: number|null; novelty: number|null; horizon: HorizonKey|null };

// ---------- Grafo ----------
export type GraphDTO = {
  nodes: { id: string; title: string; vitality: number|null; themeId: string|null; category: string|null; horizon: HorizonKey|null }[];
  edges: { a: string; b: string; score: number; strength: "fuerte"|"media"|"debil" }[];
  stats: { nodes: number; edges: number; themesAlive: number; themesDead: number; orphans: number };
};

// ---------- Meta ----------
export type MetaDTO = {
  apiVersion: "v1";
  generatedAt: string;
  counts: { publishedSignals: number; themesAlive: number; themesDead: number; macroThemes: number; links: number; categories: number; snapshots: number };
  lastGraphRunAt: string | null;
  dateRange: { earliestLikedAt: string | null; latestLikedAt: string | null };
  domain: { halfLifeDays: number; orphanHalfLifeDays: number; deadThreshold: number; linkThreshold: number; minThemeSize: number; maxMacroPerHorizon: number };
};
```

**Decisión sobre `score` vs `strength`: se exponen los dos.**
- La regla "nunca mostrar el % de similitud" es de **producto para lectores humanos**: un 0.63 se lee como precisión falsa. No es una regla de seguridad.
- Un **agente** sí necesita el número: sin él no puede ordenar vecinos ni poner umbrales.
- El DTO lleva `score` (float crudo) **y** `strength` (`fuerte >= 0.75`, `media >= 0.65`, `debil` el resto — por encima del `LINK_THRESHOLD = 0.55` que ya filtra).
- La convención se documenta en `docs/API.md`, `docs/DOMAIN.md`, y —lo importante— **en la descripción de la tool MCP**, con la frase literal: *"Usa `strength` cuando redactes para una persona; `score` es para tu razonamiento interno. No muestres el porcentaje de similitud al usuario final."*

### 1.4 Filtros y helper de scope

**`src/lib/public-query.ts` (NUEVO)** — extiende `buildWhere` sin tocarlo:

```ts
export type PublicSignalFilters = {
  categories: string[];       // ?category=a&category=b (repetible) o ?categories=a,b
  pestel: string[];           // ?pestel=social,legal
  horizon: HorizonKey | null; // ?horizon=H2 -> filtra por cluster.horizon
  themeId: string | null;     // ?theme=<id>
  macroThemeId: string | null;
  status: "alive" | "dead" | "any";  // estado del tema al que pertenece
  from: Date | null;          // ?from=2026-01-01 (sobre likedAt)
  to: Date | null;            // ?to=2026-06-30
  search: string;             // ?q=
  minVitality: number | null; // ?minVitality=0.5
  orphansOnly: boolean;       // ?orphans=true (señales sin tema)
};

export function publicFiltersFromSearchParams(p: URLSearchParams): PublicSignalFilters; // PublicApiError(400) con el nombre del param malo
export function buildPublicWhere(f: PublicSignalFilters): Prisma.LikedItemWhereInput;   // SIEMPRE inyecta publishStatus: 'published'
export const PUBLISHED_ONLY = { publishStatus: "published" } as const;
```

`buildPublicWhere` reusa la lógica de búsqueda de `buildWhere` (`tweetText`/`contentTitle`/`authorHandle`, `mode: 'insensitive'`) y **añade** `tldr` y `whyMatters` al OR. Reemplaza `range` por `from`/`to` explícitos.

**Paginación** — `src/lib/public-cursor.ts` (NUEVO):
```ts
export function encodeCursor(row: { likedAt: Date; id: string }): string;   // base64url("v1|<iso>|<id>")
export function decodeCursor(raw: string): { likedAt: Date; id: string };   // PublicApiError(400) si no parsea
export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;
export function parseLimit(raw: string | null): number;
```

### 1.5 Catálogo exacto de endpoints

Todos: `GET`, `Authorization: Bearer` obligatorio, envelope `{ data, meta }`.

| # | Ruta | Archivo a crear | Query params | `data` | Caché |
|---|---|---|---|---|---|
| 1 | `/api/public/v1/meta` | `src/app/api/public/v1/meta/route.ts` | — | `MetaDTO` | `short` |
| 2 | `/api/public/v1/health` | `.../health/route.ts` | — | `{ status, apiVersion, db, uptimeCheckedAt }` | `live` |
| 3 | `/api/public/v1/signals` | `.../signals/route.ts` | `cursor,limit,q,category,pestel,horizon,theme,macroTheme,status,from,to,minVitality,orphans,sort` | `SignalSummaryDTO[]` | `short` |
| 4 | `/api/public/v1/signals/[id]` | `.../signals/[id]/route.ts` | — | `SignalDetailDTO` | `short` |
| 5 | `/api/public/v1/signals/[id]/neighbors` | `.../signals/[id]/neighbors/route.ts` | `limit` (<=50), `minScore` | `NeighborDTO[]` | `graph` |
| 6 | `/api/public/v1/themes` | `.../themes/route.ts` | `cursor,limit,status,horizon,macroTheme,q,sort(vitality\|size\|velocity\|lastSignal),minVitality` | `ThemeSummaryDTO[]` | `graph` |
| 7 | `/api/public/v1/themes/[id]` | `.../themes/[id]/route.ts` | — | `ThemeDetailDTO` | `graph` |
| 8 | `/api/public/v1/themes/[id]/signals` | `.../themes/[id]/signals/route.ts` | `cursor,limit,sort(vitality\|likedAt)` | `SignalSummaryDTO[]` | `graph` |
| 9 | `/api/public/v1/themes/[id]/history` | `.../themes/[id]/history/route.ts` | `from,to,limit` | `{ themeId, points: (SnapshotThemeRowDTO & {takenAt,trigger})[] }` | `graph` |
| 10 | `/api/public/v1/macro-themes` | `.../macro-themes/route.ts` | `horizon` | `MacroThemeDTO[]` | `graph` |
| 11 | `/api/public/v1/horizons` | `.../horizons/route.ts` | — | `HorizonDTO[]` (los 3) | `graph` |
| 12 | `/api/public/v1/horizons/[key]` | `.../horizons/[key]/route.ts` | — | `HorizonDTO & { themes: ThemeSummaryDTO[] }` | `graph` |
| 13 | `/api/public/v1/categories` | `.../categories/route.ts` | — | `CategoryDTO[]` | `static` |
| 14 | `/api/public/v1/pestel` | `.../pestel/route.ts` | — | `PestelDTO[]` | `static` |
| 15 | `/api/public/v1/graph` | `.../graph/route.ts` | `horizon,minVitality,minScore,limit(<=2000)` | `GraphDTO` | `graph` |
| 16 | `/api/public/v1/snapshots` | `.../snapshots/route.ts` | `cursor,limit,from,to` | `SnapshotSummaryDTO[]` | `graph` |
| 17 | `/api/public/v1/snapshots/[id]` | `.../snapshots/[id]/route.ts` | `includeMembers=true` | `SnapshotSummaryDTO & { themes: SnapshotThemeRowDTO[]; members?: [] }` | `static` (`max-age=86400, immutable`) |

Notas por endpoint:
- **#5 neighbors**: `semanticLink.findMany({ where: { OR: [{itemAId:id},{itemBId:id}], itemA:{publishStatus:'published'}, itemB:{publishStatus:'published'} }, orderBy:{score:'desc'} })`, luego normalizar "el otro lado" (el par siempre va ordenado `itemAId < itemBId`).
- **#9 history**: `graphSnapshotCluster.findMany({ where: { clusterId: id, snapshot: { takenAt: {gte,lte} } }, orderBy: { snapshot: { takenAt: 'asc' } }, include: { snapshot: { select: { takenAt:true, trigger:true } } } })`.
- **#11/#12 horizons**: agrega sobre `semanticCluster` agrupando por `horizon` con `status:'alive'`, más `macroCluster.findMany({ include: { clusters: true } })`. Reusa `HORIZONS` y `HORIZON_LABELS`.
- **#13 categories**: `getCategoriesOverview(true)`. `distribution` → `inCatalog:true`; `proposed` → `inCatalog:false`.
- **#15 graph**: nodos = señales publicadas con `embeddedAt != null`; aristas = `semanticLink` con ambos extremos publicados. `limit` corta por vitalidad descendente. **Nunca** se toca la columna `embedding`: `select` explícito en todos los queries.
- **#17 snapshots/[id]**: `includeMembers` con cap duro de 5000 y `meta.truncated: true`.

### 1.6 Errores

```json
{ "error": { "code": "not_found", "message": "No existe una señal publicada con ese id.", "param": null },
  "meta": { "apiVersion": "v1", "generatedAt": "2026-08-25T..." } }
```

| Status | code | Cuándo |
|---|---|---|
| 400 | `invalid_parameter` | cursor corrupto, `horizon` fuera de H1/H2/H3, `limit` no numérico, fecha no ISO. `param` lleva el nombre |
| 401 | `unauthorized` / `invalid_api_key` | sin Bearer / clave mala |
| 404 | `not_found` | id inexistente **o existente pero no publicado** (mismo mensaje) |
| 405 | — | Next lo genera solo |
| 429 | `rate_limited` | cabecera `Retry-After` |
| 500 | `internal_error` | mensaje genérico, nunca el stack ni el error de Prisma |
| 503 | `api_disabled` | sin claves en env |

**El 404 por "no publicado" es una decisión de seguridad**: un 403 revelaría que el id existe y hay contenido no publicado detrás.

### 1.7 Rate limiting

`src/lib/public-rate-limit.ts` (NUEVO), envoltorio de `src/lib/rate-limit.ts`:
- Por clave de API, no por IP: `isRateLimited(\`public:${key.id}\`, { windowMs: 60_000, max: 120 })`.
- Endpoints caros (`/graph`, `/snapshots/[id]?includeMembers`): límite aparte de 10/min.
- Cabeceras: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`.
- **Limitación documentada**: el `Map` es por instancia serverless → best-effort. Deuda anotada en `docs/DEPLOYMENT.md`.

### 1.8 CORS

- Se habilita **solo** si `T4F_PUBLIC_API_ALLOWED_ORIGINS` tiene valores: se refleja el `Origin` si está en la lista, **nunca `*`**.
- `OPTIONS` explícito compartido: `Access-Control-Allow-Methods: GET, OPTIONS`, `Access-Control-Allow-Headers: Authorization, Content-Type`, `Access-Control-Max-Age: 86400`.
- `Vary: Origin, Authorization` siempre.

### 1.9 Cambios en archivos EXISTENTES de x-likes-curator

1. **`src/proxy.ts`** — agregar `api/public` a la negación del matcher:
   `"/((?!api/public|api/jobs|api/auth|api/billing/webhook|login|...).*)"`, con un comentario explicando por qué (mismo patrón que `api/jobs`: se autentica adentro con Bearer). **Sin esto nada funciona.**
2. **`.env.example`** — bloque `# --- API pública read-only (MCP) ---`.
3. **`README.md`** — párrafo corto apuntando a `MCP_Tools4Foresight/docs/API.md`.
4. **`vercel.json`** y **`next.config.ts`** — sin cambios.

### 1.10 Tests en x-likes-curator

`vitest.config.mts` incluye `tests/**/*.test.{ts,tsx}`. Los tests nuevos son de lógica pura (sin DB, sin HTTP):
- `tests/public-api/public-dto.test.ts` — lista negra sobre `Object.keys`, `Decimal→number`, `Date→ISO`, `likedAtEstimated` siempre `true`.
- `tests/public-api/public-query.test.ts` — `buildPublicWhere` **siempre** inyecta `publishStatus:'published'`; parseo de filtros; errores 400.
- `tests/public-api/public-cursor.test.ts` — round-trip, cursores corruptos.
- `tests/public-api/public-api-auth.test.ts` — sin clave → 503; clave mala → 401; clave buena → ok; multi-clave.

---

## 2. Servidor MCP — repo MCP_Tools4Foresight

### 2.1 Estructura

```
MCP_Tools4Foresight/
├── package.json, tsconfig.json, vitest.config.ts, vercel.json
├── .gitignore, .env.example, .mcp.json.example
├── README.md, AGENTS.md, CLAUDE.md, CONTRIBUTING.md, SECURITY.md, CHANGELOG.md, LICENSE
├── docs/{PLAN,API,TOOLS,ARCHITECTURE,DOMAIN,DEPLOYMENT}.md
├── api/mcp.ts                  # Vercel Function (Streamable HTTP)
├── src/
│   ├── stdio.ts                # entry point local (bin)
│   ├── http.ts                 # servidor HTTP standalone (dev/self-host)
│   ├── config.ts               # env -> Config, validado con zod
│   ├── server.ts               # createServer(config): McpServer   <- core único
│   ├── client/{http-client,errors,cache,types}.ts
│   ├── tools/{index,signals,themes,horizons,graph,taxonomy,snapshots,domain}.ts
│   ├── resources/index.ts
│   ├── prompts/index.ts
│   ├── format/{signal,theme,shared}.ts
│   └── domain/glossary.ts
└── tests/{http-client,cache,tools.signals,tools.themes,format}.test.ts + fixtures/
```

### 2.2 package.json

```json
{
  "name": "mcp-tools4foresight",
  "version": "0.1.0",
  "description": "Servidor MCP de solo lectura para las señales de foresight de tools4foresight.com",
  "license": "MIT",
  "type": "module",
  "engines": { "node": ">=20" },
  "bin": { "mcp-tools4foresight": "dist/stdio.js" },
  "exports": { ".": { "types": "./dist/server.d.ts", "import": "./dist/server.js" } },
  "files": ["dist", "README.md", "docs", "LICENSE"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev:stdio": "tsx src/stdio.ts",
    "dev:http": "tsx watch src/http.ts",
    "inspect": "npx @modelcontextprotocol/inspector tsx src/stdio.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src tests",
    "prepublishOnly": "npm run build"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.30.0",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@types/node": "^22",
    "tsx": "^4.23.12",
    "typescript": "^5.7",
    "vitest": "^4.1.11",
    "eslint": "^9",
    "typescript-eslint": "^8"
  }
}
```

Cero dependencias de runtime más allá del SDK y zod: `fetch` nativo (Node 20+), caché con `Map`, servidor con `node:http`. `dist/stdio.js` necesita `#!/usr/bin/env node` como primera línea de `src/stdio.ts` (TS lo preserva).

### 2.3 tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022", "lib": ["ES2023"], "module": "NodeNext", "moduleResolution": "NodeNext",
    "outDir": "dist", "rootDir": "src", "declaration": true, "sourceMap": true,
    "strict": true, "noUncheckedIndexedAccess": true, "exactOptionalPropertyTypes": true,
    "esModuleInterop": true, "skipLibCheck": true, "verbatimModuleSyntax": true
  },
  "include": ["src/**/*.ts"]
}
```
`NodeNext` obliga a deep imports con extensión `.js`, que es como el SDK los publica.

### 2.4 Configuración — src/config.ts

```ts
export type Config = {
  baseUrl: string;        // T4F_API_BASE_URL, default "https://tools4foresight.com/api/public/v1"
  apiKey: string;         // T4F_API_KEY (obligatoria)
  timeoutMs: number;      // T4F_TIMEOUT_MS, default 15000
  retries: number;        // T4F_RETRIES, default 2
  cacheTtlMs: number;     // T4F_CACHE_TTL_MS, default 60000
  cacheMaxEntries: number;// default 200
  logLevel: "silent" | "error" | "debug"; // T4F_LOG_LEVEL
};
export function loadConfig(env = process.env): Config; // valida con zod, mensajes en español
```

**Regla de oro del stdio**: `stdout` es el canal JSON-RPC. **Todo log va a `stderr`** (`console.error`). Un `console.log` suelto rompe el protocolo. Va como comentario en `src/stdio.ts` y como regla en `AGENTS.md` y `CONTRIBUTING.md`.

### 2.5 Cliente HTTP — src/client/http-client.ts

```ts
export type RequestOpts = { path: string; query?: Record<string, string|number|boolean|string[]|null|undefined>; signal?: AbortSignal; cache?: boolean };
export class T4FClient {
  constructor(config: Config, deps?: { fetch?: typeof fetch; now?: () => number });
  get<T>(opts: RequestOpts): Promise<T>;
}
```

- `Authorization: Bearer ${apiKey}`, `Accept: application/json`, `User-Agent: mcp-tools4foresight/<version>`.
- **Timeout** con `AbortSignal.timeout(timeoutMs)`, combinado con la señal del caller vía `AbortSignal.any`.
- **Reintentos**: solo en 429, 5xx y errores de red. Backoff exponencial con jitter (`300ms * 2^n ± 30%`), respetando `Retry-After`. **Nunca** se reintenta un 4xx que no sea 429.
- **Errores traducidos para el LLM** (`src/client/errors.ts`) — el mensaje debe decirle qué hacer:

  | status | Mensaje al modelo |
  |---|---|
  | 401 | "La API key de tools4foresight es inválida o falta. Revisa `T4F_API_KEY` en la configuración del servidor MCP. No reintentes." |
  | 404 | "No existe ese id entre el contenido publicado. Usa `list_signals` o `list_themes` para obtener ids válidos." |
  | 429 | "Límite de peticiones alcanzado. Espera unos segundos antes de volver a pedir." |
  | 5xx/red | "tools4foresight no respondió. Ya se reintentó N veces." |

  Se devuelven como `{ content: [...], isError: true }` (error de tool, no excepción de protocolo).
- **Caché** (`src/client/cache.ts`): `Map` + timestamp, TTL por perfil, tope `cacheMaxEntries` con evicción LRU. Clave = `GET ${path}?${queryOrdenada}`. TTLs: taxonomía 10 min, grafo/temas 5 min, señales 1 min, snapshot por id ∞. `T4F_CACHE_TTL_MS=0` la desactiva.

### 2.6 Catálogo de tools MCP

Convención: **nombres en inglés snake_case**, **descripciones en español**. Todas llevan
`annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }`.

Todas devuelven `content: [{ type: 'text', text: <markdown legible> }]` **y** `structuredContent` con el DTO.

| # | Tool | Endpoint | inputSchema (raw shape zod) | Descripción (resumen del texto que ve el LLM) |
|---|---|---|---|---|
| 1 | `list_signals` | `/signals` | `q?, category?[], pestel?[], horizon?, theme_id?, macro_theme_id?, from?, to?, min_vitality?, orphans_only?, limit?, cursor?, sort?` | "Lista señales publicadas (artículos/tweets curados) con filtros. Una *señal* es una pieza de contenido guardada como indicio de futuro. La fecha `likedAt` es **estimada**: preséntala siempre con `~`." |
| 2 | `get_signal` | `/signals/{id}` | `signal_id` | "Ficha completa de una señal: TL;DR, por qué importa, impacto en el desarrollo de la IA y la interacción humana, categoría, PESTEL, vitalidad y tema." |
| 3 | `get_signal_neighbors` | `/signals/{id}/neighbors` | `signal_id, limit?, min_score?` | "Señales semánticamente cercanas. Devuelve `strength` (fuerte/media/débil) y `score` (coseno crudo). **Usa `strength` al redactar para una persona; `score` solo para tu razonamiento. No muestres el porcentaje de similitud al usuario final.**" |
| 4 | `search_signals` | `/signals?q=` | `query, limit?, horizon?, from?, to?` | "Búsqueda de texto sobre título, texto, TL;DR y 'por qué importa'. Para explorar por cercanía conceptual usa `get_signal_neighbors`." |
| 5 | `list_themes` | `/themes` | `status?, horizon?, macro_theme_id?, q?, min_vitality?, sort?, limit?, cursor?` | "Lista los *temas* (clusters semánticos). Un tema es un linaje que persiste entre corridas, acumula historia y puede **morir** (fósil, `status:'dead'`) y **resucitar**. Nada se borra." |
| 6 | `get_theme` | `/themes/{id}` | `theme_id` | "Detalle de un tema con sus cuatro indicadores: velocidad (30d vs 30d previos), densidad (cohesión), conectividad (puentes) y novedad (distancia al centro del mapa)." |
| 7 | `list_theme_signals` | `/themes/{id}/signals` | `theme_id, limit?, cursor?, sort?` | "Las señales que componen un tema, por vitalidad o por fecha." |
| 8 | `get_theme_history` | `/themes/{id}/history` | `theme_id, from?, to?, limit?` | "Serie temporal de un tema: cómo cambiaron tamaño, vitalidad, velocidad y horizonte en cada corrida. Es la tool para '¿esto está creciendo o apagándose?'." |
| 9 | `list_macro_themes` | `/macro-themes` | `horizon?` | "Macro-temas: agrupación de segundo nivel, máximo 5 por horizonte. Se recrean en cada corrida, así que sus ids **no son estables** — no los guardes." |
| 10 | `get_horizons_overview` | `/horizons` | — | "Panorama de los tres horizontes: H1 ya está pasando, H2 en transición, H3 señal débil. Empieza por aquí cuando te pidan 'el estado del mapa'." |
| 11 | `get_horizon` | `/horizons/{key}` | `horizon` (`z.enum(['H1','H2','H3'])`) | "Un horizonte con todos sus temas vivos." |
| 12 | `list_categories` | `/categories` | — | "Catálogo de categorías con conteo. `inCatalog:false` = categoría que propuso el modelo y aún no está en el catálogo curado (es una feature, no un error)." |
| 13 | `list_pestel_dimensions` | `/pestel` | — | "Las seis dimensiones PESTEL con su conteo. Cada señal lleva **máximo 2**." |
| 14 | `get_graph` | `/graph` | `horizon?, min_vitality?, min_score?, limit?` | "El grafo semántico completo (nodos + aristas) de las señales publicadas. Es la vista curada. Para lectura normal usa temas y horizontes." |
| 15 | `list_snapshots` | `/snapshots` | `from?, to?, limit?, cursor?` | "Corridas del grafo. Cada snapshot es una foto completa; con dos o más se ve nacer, crecer y apagarse a los temas." |
| 16 | `get_snapshot` | `/snapshots/{id}` | `snapshot_id, include_members?` | "Una corrida con el estado de todos los temas en ese momento." |
| 17 | `get_corpus_overview` | `/meta` | — | "Resumen del acervo: conteos, rango de fechas, última corrida y las constantes del modelo. **Llama a esta tool primero** si no sabes el tamaño ni la actualidad del corpus." |
| 18 | `explain_foresight_term` | *(local, sin red)* | `term` (`z.enum([...])`, ~17 claves) | "Explica un término del método: señal, tema, vitalidad, fósil, horizonte, velocidad, densidad, conectividad, novedad, puente, macro-tema, PESTEL, snapshot, huérfana." |

**Sobre `outputSchema`**: se declara **solo** en las tools de detalle y taxonomía (2, 6, 10, 12, 13, 17), donde la forma es estable; las listas paginadas se dejan sin `outputSchema` para no subir versión mayor al agregar un campo opcional. Criterio documentado en `docs/TOOLS.md`.

**Convenciones de formato (`src/format/`)**:
- `likedAt` siempre como `~25 ago 2026` (con la virgulilla). Nunca sin ella.
- `tweetCreatedAt` sin virgulilla (es exacta).
- Vitalidad con 2 decimales + etiqueta: `2.31 (viva)` / `0.42 (apagándose)`.
- Estado de tema en español: `vivo` / `fósil`.
- Horizonte con su etiqueta corta de `HORIZON_LABELS`: `H2 · en transición`.
- Cada listado cierra con `Siguiente página: cursor=<...>` si `hasMore`.

### 2.7 Resources MCP — src/resources/index.ts

| URI | Tipo | `list` | Contenido |
|---|---|---|---|
| `foresight://overview` | estático | — | `/meta` renderizado en markdown. La puerta de entrada. |
| `foresight://glossary` | estático | — | `docs/DOMAIN.md` generado desde `src/domain/glossary.ts`. Sin red. |
| `foresight://horizons` | estático | — | Panorama de los 3 horizontes en markdown. |
| `foresight://signal/{id}` | `ResourceTemplate` | `list: undefined` | Ficha de señal en markdown. |
| `foresight://theme/{id}` | `ResourceTemplate` | `list:` devuelve los temas **vivos** | Ficha de tema + sus señales. |
| `foresight://horizon/{key}` | `ResourceTemplate` | `list:` los 3, con `complete: { key: () => ['H1','H2','H3'] }` | Horizonte completo. |
| `foresight://macro-theme/{id}` | `ResourceTemplate` | `list:` los <=15 | Macro-tema con sus temas. |

El segundo argumento de `ResourceTemplate` **exige** la clave `list` aunque sea `undefined`.

### 2.8 Prompts MCP — src/prompts/index.ts

| Nombre | argsSchema | Para qué |
|---|---|---|
| `analizar_horizonte` | `horizonte` (H1/H2/H3) | Llama `get_horizon`, luego `get_theme_history` de los 3 temas con más velocidad, y pide una lectura de qué madura y qué se apaga. |
| `informe_de_tema` | `tema` (nombre o id) | Ficha ejecutiva: qué es, señales clave, trayectoria, con qué temas hace puente. |
| `radar_semanal` | `dias?` | Qué entró, qué cambió de horizonte y qué murió en los últimos N días, usando snapshots. |
| `senales_debiles` | `categoria?` | Recorre H3 buscando temas chicos con novedad alta; pide hipótesis de crecimiento. |
| `comparar_temas` | `tema_a`, `tema_b` | Contrasta indicadores y busca las señales puente. |
| `explorar_desde_senal` | `senal` | Parte de una señal y camina el grafo con `get_signal_neighbors` dos saltos. |

Cada prompt inyecta como primer mensaje un bloque con las reglas del dominio (fechas estimadas, no mostrar %, fósil != borrado).

### 2.9 Entry points

**`src/stdio.ts`**
```ts
#!/usr/bin/env node
// stdout es el canal JSON-RPC. Todo log va a stderr.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { createServer } from './server.js';

const config = loadConfig();           // si falta T4F_API_KEY: error a stderr + exit 1
const server = createServer(config);
await server.connect(new StdioServerTransport());
console.error('mcp-tools4foresight listo (stdio)');
```
`SIGINT`/`SIGTERM` → `await server.close()` → `exit 0`.

**`src/http.ts`** (dev y self-host, `node:http` puro): por request, transport nuevo (stateless, sin `sessionIdGenerator`) + server nuevo. `POST /mcp` → `transport.handleRequest(request)`. `GET /health` → `{ status: 'ok' }`. Pasa `allowedHosts: ['127.0.0.1','localhost']`.

**`api/mcp.ts`** (Vercel Function, web-standard)
```ts
export const config = { runtime: 'nodejs' };   // el SDK usa APIs de Node; no edge
export default async function handler(request: Request): Promise<Response> {
  const auth = checkBearer(request);           // MCP_ACCESS_TOKEN, ver 2.10
  if (auth) return auth;
  const transport = new WebStandardStreamableHTTPServerTransport();  // stateless
  const server = createServer(loadConfig());
  await server.connect(transport);
  return transport.handleRequest(request);
}
```
**Stateless a propósito**: en Vercel cada request puede caer en otra instancia. Sin `sessionIdGenerator` no hay sesión que perder. El precio (sin resumabilidad ni notificaciones server→client fuera del ciclo de la request) no importa aquí: todas las tools son GETs cortos.

`vercel.json`: `{ "functions": { "api/mcp.ts": { "maxDuration": 60, "memory": 1024 } } }`

### 2.10 Seguridad del endpoint HTTP remoto

El MCP remoto **lleva la API key de tools4foresight adentro**. Publicarlo sin auth sería regalar el contenido de paga.
- `api/mcp.ts` exige su **propia** credencial: `Authorization: Bearer <MCP_ACCESS_TOKEN>` (env distinta de `T4F_API_KEY`). Sin ella, 401.
- Si la env `MCP_ACCESS_TOKEN` falta, el handler devuelve **503** (nunca abierto por defecto).
- Alternativa futura anotada, fuera de alcance: OAuth 2.1 con `ProxyOAuthServerProvider`.
- `allowedHosts` en el modo `http.ts` local; en Vercel lo controla la plataforma.

### 2.11 Tests (vitest)

- `http-client.test.ts`: `fetch` inyectado. Éxito; 401 sin reintento; 429 con `Retry-After`; 500 con backoff y agotamiento; timeout aborta; query string con arrays y con `undefined` (que no debe aparecer en la URL).
- `cache.test.ts`: hit dentro del TTL, miss al expirar, evicción LRU, `ttl=0` desactiva.
- `tools.signals.test.ts` / `tools.themes.test.ts`: `McpServer` real + `T4FClient` fake, conectado con `InMemoryTransport` + `Client` del SDK (`@modelcontextprotocol/sdk/inMemory.js`). Verifica mapeo argumentos→query, `structuredContent` conforme al `outputSchema`, y que un 404 devuelve `isError: true` con mensaje accionable.
- `format.test.ts`: el `~` está en toda fecha `likedAt`; el markdown de vecinos **no** contiene `%`; `dead` se renderiza como `fósil`.
- Fixtures JSON en `tests/fixtures/`.

---

## 3. Documentación del repo nuevo

| Archivo | Contenido |
|---|---|
| `README.md` | Qué es, para quién, qué NO hace (no escribe nada). Instalación por `npx`. Bloques de config listos para copiar: **Claude Code** (`claude mcp add`), **Claude Desktop**, **Cursor**, y el modo HTTP remoto. 5-6 ejemplos de conversación real. Tabla de env vars. Enlace a cada doc. |
| `docs/API.md` | Contrato completo de `/api/public/v1`: los 17 endpoints con params, DTOs, ejemplos `curl` y respuesta JSON. Tabla de errores. Versionado y caché. **Es el contrato entre los dos repos**: si `src/client/types.ts` y este doc divergen, este manda. |
| `docs/TOOLS.md` | Una sección por tool: nombre, descripción literal que ve el LLM, input schema tabulado, ejemplo de entrada y salida (markdown + `structuredContent`), y "cuándo usar esta y no aquella". Más resources y prompts. |
| `docs/ARCHITECTURE.md` | Diagrama ASCII `Agente → MCP (stdio\|HTTP) → T4FClient (+caché) → /api/public/v1 → Prisma → Neon`. Decisiones: por qué HTTP y no Postgres directo; un core con tres entry points; stateless en Vercel; cursor compuesto; caché en memoria y no Redis; no SSE. |
| `docs/DOMAIN.md` | Glosario generado desde `src/domain/glossary.ts`: señal, tema, linaje, fósil, resurrección, vitalidad (fórmula), huérfana, horizonte (heurística exacta), velocidad, densidad, conectividad, novedad, puente, macro-tema, snapshot, PESTEL, categoría. Con las constantes reales (30, 1.0, 0.55, 8, 3, 0.3, 5). |
| `docs/DEPLOYMENT.md` | Vercel paso a paso: `vercel link`, env vars, `vercel deploy --prod`. Generar y rotar claves en los dos repos. Prueba de humo con `curl` y con el MCP Inspector. Deuda: rate limit best-effort. |
| `CONTRIBUTING.md` | Setup, `npm test`, regla del `stderr`, checklist de 6 pasos para agregar una tool (DTO → cliente → tool → formato → test → `docs/TOOLS.md` → `CHANGELOG.md`). |
| `SECURITY.md` | **Lista negra explícita**: nunca se exponen `users`, `sessions`, `accounts`, `verifications`, `favorites`, `feedback`, `x_auth_tokens`, `prompt_settings`, `custom_field_definitions`, `liked_item_custom_fields`, nada de Stripe, el vector `embedding` crudo, ni items `pending`/`enrichDiscarded`. Manejo de la API key. Cómo reportar. Nota de que el contenido es de suscripción de pago. |
| `CHANGELOG.md` | Keep a Changelog, `0.1.0`. |
| `LICENSE` | MIT, "Copyright (c) 2026 Frida Rodríguez". El código es MIT; **los datos que sirve no lo son** — nota en README y SECURITY. |
| `AGENTS.md` + `CLAUDE.md` | Reglas para agentes: es solo-lectura, nunca agregar una tool que mute, logs a stderr, toda tool nueva necesita test + entrada en `docs/TOOLS.md`, no inventar campos que la API no devuelve. |
| `.env.example` | `T4F_API_BASE_URL`, `T4F_API_KEY`, `T4F_TIMEOUT_MS`, `T4F_RETRIES`, `T4F_CACHE_TTL_MS`, `T4F_LOG_LEVEL`, `MCP_ACCESS_TOKEN`, `MCP_PORT`. |
| `.mcp.json.example` | Config de ejemplo para stdio local y para HTTP remoto. |
| `.gitignore` | `node_modules`, `dist`, `.env*` (menos `.env.example`), `.vercel`, `*.tsbuildinfo`, `coverage`. |

---

## 4. Olas de trabajo

- **Ola 0**: T0.1 contrato `docs/API.md` (Alta) · T0.2 andamiaje del repo (Baja)
- **Ola 1**: T1.1 auth+envelope+CORS+ratelimit+cursor+fix proxy (Media) · T1.2 DTOs+filtros (Media) · T1.3 glosario+DOMAIN.md (Baja)
- **Ola 2**: T2.1 señales (Alta) · T2.2 temas (Alta) · T2.3 horizontes/taxonomía/meta (Media) · T2.4 grafo/snapshots (Media)
- **Ola 3**: T3.1 cliente HTTP+caché+config (Media) · T3.2 formato (Baja)
- **Ola 4**: T4.1 server+tools señales (Alta) · T4.2 tools temas (Media) · T4.3 tools horizontes/taxonomía/glosario (Baja) · T4.4 tools grafo/snapshots (Media) · T4.5 resources+prompts (Media)
- **Ola 5**: T5.1 stdio (Media) · T5.2 http+vercel (Alta) · T5.3 README+TOOLS.md (Media) · T5.4 resto de docs (Media)
- **Ola 6**: T6.1 verificación E2E · T6.2 auditoría de fuga de datos · T6.3 git init + commit

Ruta crítica: T0.1 → T1.1/T1.2 → T2.* → T4.* → T5.2 → T6.1.

---

## 5. Riesgos y decisiones registradas

1. **Cursor de Prisma con `orderBy` compuesto**: Prisma usa el `cursor` como fila de referencia y aplica el orden completo, así que `(likedAt desc, id desc)` es correcto. Plan B si aparecen saltos: `$queryRaw` con la tupla `(liked_at, id) < (:a, :b)`.
2. **Campos personalizados** (`CustomFieldDefinition` / `LikedItemCustomField`): **no se exponen** en v1. Son el banco de trabajo privado del enriquecimiento, con nombres libres que pueden contener notas internas.
3. **El SDK arrastra `express`, `hono`, `ajv`, `jose`**: el bundle de la función de Vercel será grande. Se mide el cold start en T6.1.
4. **Rate limit en memoria**: no es global. Aceptable hoy, documentado como deuda.
5. **Ids de macro-temas inestables**: se recrean en cada corrida. La descripción de `list_macro_themes` se lo dice al modelo.
6. **`/health` lleva auth**: un health público invitaría a sondeos.
