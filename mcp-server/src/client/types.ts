// Espejo exacto de los DTOs de la API pública de tools4foresight (docs/PLAN.md §1.3).
// Archivo solo de tipos: cero runtime, cero imports de valor.
//
// Prioridad de fuentes (verificada campo por campo contra
// x-likes-curator/src/lib/public-dto.ts y los route handlers reales):
// implementación real > docs/API.md > este archivo. `docs/API.md` es el contrato
// nominal entre los dos repos, pero se escribió a mano y tiene puntos que
// divergen de lo que el servidor realmente responde (ver comentarios "DIVERGENCIA"
// en este archivo). Este archivo se creó antes que docs/API.md, así que cualquier
// diferencia restante sin comentar es un desfase pendiente de revisar, no una
// decisión.

export type HorizonKey = 'H1' | 'H2' | 'H3';

// ---------- Envelopes ----------

// DIVERGENCIA vs. docs/API.md §3.1: el documento tipa `ApiMeta` sin `apiVersion`
// (dice que solo vive en el envelope de error) y muestra el `meta` de una
// respuesta de detalle recortado a `{ generatedAt }`. La implementación real de
// `ok()` (`src/lib/public-api-response.ts`) arma SIEMPRE
// `{ apiVersion, nextCursor: null, hasMore: false, count: 1, ...meta, generatedAt }`
// y ningún handler de detalle (`/meta`, `/signals/{id}`, `/themes/{id}`, `/health`)
// pasa overrides que lo recorten — así que `apiVersion`/`nextCursor`/`hasMore`/
// `count` están siempre presentes, también en detalle. Se sigue la implementación.
export type ApiMeta = {
  apiVersion: 'v1';
  nextCursor: string | null;
  hasMore: boolean;
  count: number;
  total?: number;
  generatedAt: string;
  // DIVERGENCIA vs. plan original: no documentada en §1.3, pero confirmada en la
  // implementación real (`/graph` y `/snapshots/{id}?includeMembers=true`). Solo
  // aparece cuando el resultado SÍ se truncó — nunca como `false` explícito — así
  // que se tipa opcional y el cliente no debe asumir su ausencia como "no truncado".
  truncated?: boolean;
};

export type ApiListResponse<T> = {
  data: T[];
  meta: ApiMeta;
};

export type ApiItemResponse<T> = {
  data: T;
  meta: ApiMeta;
};

// ---------- Errores (§1.6) ----------

export type ErrorCode =
  | 'unauthorized'
  | 'invalid_api_key'
  | 'rate_limited'
  | 'not_found'
  | 'invalid_parameter'
  | 'api_disabled'
  | 'internal_error';

export type ApiErrorBody = {
  error: {
    code: ErrorCode;
    message: string;
    param: string | null;
  };
  meta: {
    apiVersion: 'v1';
    generatedAt: string;
  };
};

// ---------- Señal ----------

export type SignalSource = 'x_like' | 'manual';
export type LikedAtSource = 'tweet_date' | 'ordered';
export type ThemeStatus = 'alive' | 'dead';

/**
 * Estado de curaduría de una señal. En el servidor single-tenant era un FILTRO
 * SECRETO (la API solo servía `published` y `publishStatus` estaba en la lista
 * negra de campos que jamás salen). Aquí no: la persona ES la curadora de su
 * banco y ve el 100% de su material, así que el campo pasa a ser un DATO ÚTIL
 * — "esto ya lo revisé" vs. "esto todavía no lo miré".
 *
 * Valores tomados del schema real de la app multi-tenant
 * (`liked_items.publish_status`, default `"pending"`).
 */
export type PublishStatus = 'pending' | 'published';

export type SignalSummaryDTO = {
  id: string;
  source: SignalSource;
  title: string;
  url: string;
  authorHandle: string;
  authorName: string | null;
  /** OJO: estimada. Ver likedAtEstimated/likedAtSource. */
  likedAt: string;
  likedAtEstimated: true;
  likedAtSource: LikedAtSource;
  /**
   * PENDIENTE DE CONFIRMAR contra la implementación real de la API multi-tenant
   * (fase 2 del plan, `src/lib/public-dto.ts` de tools4foresight): el campo está
   * decidido pero el DTO todavía no está escrito. Se tipa opcional para que un
   * servidor que aún no lo mande no rompa el cliente; en cuanto se confirme,
   * quítale el `?`.
   */
  publishStatus?: PublishStatus;
  category: string | null;
  pestel: string[];
  tldr: string | null;
  vitality: number | null;
  theme: { id: string; name: string; status: ThemeStatus; horizon: HorizonKey | null } | null;
};

export type SignalDetailDTO = SignalSummaryDTO & {
  tweetId: string;
  tweetText: string;
  tweetUrl: string;
  tweetCreatedAt: string | null;
  mediaUrls: string[];
  contentUrl: string | null;
  contentTitle: string | null;
  contentDescription: string | null;
  contentImageUrl: string | null;
  contentPublishedAt: string | null;
  categoryConfidence: number | null;
  categoryReasoning: string | null;
  whyMatters: string | null;
  impact: string | null;
  publishedAt: string | null;
  vitalityAt: string | null;
  neighborCount: number;
};

// ---------- Vecino semántico ----------

export type NeighborStrength = 'fuerte' | 'media' | 'debil';

export type NeighborDTO = {
  signal: SignalSummaryDTO;
  score: number;
  strength: NeighborStrength;
};

// ---------- Tema (SemanticCluster) ----------

export type HorizonSource = 'auto' | 'manual';

export type ThemeSummaryDTO = {
  id: string;
  name: string;
  summary: string;
  status: ThemeStatus;
  size: number;
  vitality: number;
  horizon: HorizonKey | null;
  horizonSuggested: HorizonKey | null;
  horizonSource: HorizonSource;
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
    velocityDelta: number;
    density: number | null;
    connectivity: number | null;
    novelty: number | null;
    bridgeThemes: number;
  };
  memberIds: string[];
};

// ---------- Macro-tema ----------

export type MacroThemeDTO = {
  id: string;
  name: string;
  summary: string;
  horizon: HorizonKey;
  themes: ThemeSummaryDTO[];
};

// ---------- Horizonte ----------

export type HorizonDTO = {
  key: HorizonKey;
  labelShort: string;
  labelLong: string;
  themeCount: number;
  signalCount: number;
  vitalitySum: number;
  macroThemes: MacroThemeDTO[];
};

export type HorizonDetailDTO = HorizonDTO & {
  themes: ThemeSummaryDTO[];
};

// ---------- Categoría / PESTEL ----------

export type CategoryDTO = {
  name: string;
  description: string;
  examples: string[];
  position: number;
  isFallback: boolean;
  signalCount: number;
  inCatalog: boolean;
};

export type PestelDTO = {
  key: string;
  letter: string;
  label: string;
  signalCount: number;
};

// ---------- Snapshot ----------

export type SnapshotTrigger = 'embed' | 'cron' | 'publish' | 'manual';

export type SnapshotSummaryDTO = {
  id: string;
  takenAt: string;
  trigger: SnapshotTrigger;
  nodes: number;
  links: number;
  themesAlive: number;
  themesDead: number;
  orphans: number;
};

export type SnapshotThemeRowDTO = {
  themeId: string;
  name: string;
  size: number;
  status: string;
  vitality: number;
  velocity30d: number;
  density: number | null;
  connectivity: number | null;
  novelty: number | null;
  horizon: HorizonKey | null;
};

// DIVERGENCIA vs. docs/API.md §5 (que documenta `signalId`): el route handler real
// (`src/app/api/public/v1/snapshots/[id]/route.ts` en x-likes-curator) mapea
// `graph_snapshot_members` a `{ itemId, themeId, vitality }`. Se sigue la
// implementación, que es la que realmente responde por la red.
export type SnapshotMemberDTO = {
  itemId: string;
  /** null = señal huérfana en esa corrida. */
  themeId: string | null;
  vitality: number;
};

export type SnapshotDetailDTO = SnapshotSummaryDTO & {
  themes: SnapshotThemeRowDTO[];
  /** Solo con ?includeMembers=true. Ausente (no `[]`) si no se pidió. */
  members?: SnapshotMemberDTO[];
};

// ---------- Historial de tema ----------

export type ThemeHistoryPointDTO = SnapshotThemeRowDTO & {
  takenAt: string;
  trigger: SnapshotTrigger;
};

export type ThemeHistoryDTO = {
  themeId: string;
  points: ThemeHistoryPointDTO[];
};

// ---------- Grafo ----------

export type GraphDTO = {
  nodes: {
    id: string;
    title: string;
    vitality: number | null;
    themeId: string | null;
    category: string | null;
    horizon: HorizonKey | null;
  }[];
  edges: { a: string; b: string; score: number; strength: NeighborStrength }[];
  stats: { nodes: number; edges: number; themesAlive: number; themesDead: number; orphans: number };
};

// ---------- Meta ----------

export type MetaDTO = {
  apiVersion: 'v1';
  generatedAt: string;
  counts: {
    /**
     * PENDIENTE DE CONFIRMAR: el nombre viene del contrato v1 single-tenant,
     * donde solo existían señales publicadas. En multi-tenant no hay filtro por
     * `publishStatus`, así que este conteo debería ser el TOTAL del banco. Si la
     * API acaba renombrándolo (`signals`), se cambia aquí y en `docs/API.md`.
     */
    publishedSignals: number;
    themesAlive: number;
    themesDead: number;
    macroThemes: number;
    links: number;
    categories: number;
    snapshots: number;
  };
  lastGraphRunAt: string | null;
  dateRange: { earliestLikedAt: string | null; latestLikedAt: string | null };
  domain: {
    halfLifeDays: number;
    orphanHalfLifeDays: number;
    deadThreshold: number;
    linkThreshold: number;
    minThemeSize: number;
    maxMacroPerHorizon: number;
  };
};

// ---------- Health ----------

// DIVERGENCIA vs. docs/API.md §5 (que documenta `db: "ok" | "error"`): el route
// handler real (`src/app/api/public/v1/health/route.ts`) usa el literal `"down"`,
// no `"error"`. Se tipan los literales exactos que emite la implementación en vez
// de `string` suelto: así un cliente que compara contra `'error'` falla en
// compilación en vez de en producción.
export type HealthDTO = {
  status: 'ok' | 'degraded';
  apiVersion: 'v1';
  db: 'ok' | 'down';
  uptimeCheckedAt: string;
};
