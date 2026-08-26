/**
 * Frontera de seguridad de la API pública (/api/public/v1/**) y del MCP remoto.
 *
 * Regla de oro: **si un campo no está tipado aquí, no sale por la API**. Los route
 * handlers nunca deben pasar un `LikedItem`/`SemanticCluster`/... de Prisma tal cual
 * a `NextResponse.json`; siempre pasan por un `select` explícito de este archivo y
 * luego por el mapper correspondiente. Así una migración que agrega una columna
 * nueva no se cuela sola en el JSON: hay que decidir a mano si entra al DTO.
 *
 * Este archivo decide QUÉ COLUMNAS salen. Qué FILAS salen no se decide aquí ni en
 * `public-query.ts`: lo decide el tenant, vía `withOwner(ownerId, …)` (RLS) o
 * `tenantClient(ownerId)`. Son dos preguntas separadas y conviene que sigan
 * viviendo en dos sitios separados.
 *
 * --- LISTA NEGRA (nunca se mapea, y por qué) -------------------------------------
 * - `ownerId`              -> EL campo prohibido de este repo. Es el identificador
 *                              del tenant: filtrarlo, en cualquier DTO de cualquier
 *                              modelo, permitiría a quien recolecte respuestas
 *                              correlacionar bancos entre sí (saber que dos señales
 *                              vistas por dos caminos distintos son de la misma
 *                              persona, o contar cuántas personas hay). Quien lee
 *                              la API ya sabe de quién es el banco: es el suyo, se
 *                              lo dice su propia clave. El id no le agrega nada y
 *                              sí abre esa puerta. Ningún `select` de este archivo
 *                              lo pide, ningún mapper lo copia.
 * - `embedding`            -> vector(1536) de pgvector (OpenAI text-embedding-3-small);
 *                              no tiene sentido fuera de la DB y filtrarlo sería
 *                              regalar el material embebido en forma reconstruible.
 * - `embeddingHash`/`embeddedAt` -> detalle interno de invalidación del job de embeddings.
 * - `enrichDiscarded`      -> estado de la mesa de trabajo interna del usuario
 *                              ("esto lo tiré de la tabla de enriquecimiento"), no
 *                              es un dato de foresight.
 * - `likeRank`             -> orden crudo de ingesta de X, sin valor para un lector.
 * - `detectedAt`           -> timestamp de infraestructura (cuándo lo vio el poller),
 *                              no del dominio; `likedAt`/`tweetCreatedAt` ya cubren
 *                              "cuándo pasó" para quien consume la API.
 * - `*Source` (tldrSource, impactSource, whyMattersSource, categorySource,
 *   pestelSource, tagsSource) -> "auto" vs "manual" es un detalle editorial del
 *                              pipeline, no información de foresight. La única
 *                              excepción es `likedAtSource`, que SÍ se expone
 *                              porque califica un dato que ya se expone y que es
 *                              una estimación (ver `SignalSummaryDTO.likedAt`).
 * - `*GeneratedAt` (tldrGeneratedAt, impactGeneratedAt, whyMattersGeneratedAt,
 *   tagsGeneratedAt, categorizedAt) -> procedencia del pipeline, misma familia que
 *                              los `*Source`: dicen cuándo corrió un job, no cuándo
 *                              pasó algo en el mundo.
 * - `fetchStatus`/`fetchedAt` -> estado del scraper de metadata del link, ruido de
 *                              infraestructura.
 * - `membersHash`          -> hash interno de linaje de `SemanticCluster`.
 * - `createdAt`/`updatedAt` -> metadatos de fila, no de dominio (ya existe `likedAt`,
 *                              `firstSeenAt`, `takenAt`, etc. para lo que importa).
 * - Todo lo de `users`/`sessions`/`accounts`/`api_keys`/`user_quotas`/`usage_events`
 *                          -> la API pública es de *contenido*: nunca de cuentas,
 *                              credenciales, cuotas ni consumo.
 * -----------------------------------------------------------------------------------
 *
 * --- LO QUE SÍ SALE Y EN EL ORIGEN NO SALÍA ----------------------------------------
 * - `publishStatus` (`published` | `pending`): en el repo de origen la API pública
 *   servía el acervo de una persona a lectores ajenos, y `publishStatus` era el
 *   mecanismo de scope — exponerlo insinuaba que había material "pending" detrás de
 *   una puerta. Aquí la persona ES la curadora de su propio banco y lo ve completo
 *   (PLAN_MCP §0.2): ya no hay puerta que insinuar. El campo deja de ser un secreto
 *   y pasa a ser un dato útil para su agente — "esto ya lo revisé" vs "esto sigue en
 *   la bandeja" —, y encima es filtrable (`?publishStatus=` en `public-query.ts`).
 * - `tags` (String[]): etiquetas libres de 3 a 5 palabras que genera el pipeline por
 *   señal. Es contenido curado, del mismo tipo que `category`/`pestel`, y es
 *   justo lo que un agente necesita para filtrar sin leer el texto entero. Sus dos
 *   acompañantes, `tagsSource` y `tagsGeneratedAt`, NO salen: son procedencia del
 *   pipeline, la misma familia que los `*Source` que la lista negra ya prohíbe.
 * -----------------------------------------------------------------------------------
 *
 * `Decimal` de Prisma se convierte con `.toNumber()` (cuidado: puede ser `null`).
 * `Date` se convierte a ISO string; `null` se preserva como `null`, nunca `""`.
 */
import type { Prisma } from "@/generated/prisma/client";
import { HORIZON_LABELS, isHorizon, type HorizonKey } from "@/lib/horizons";
import { normalizePestel, type PestelDimension } from "@/config/pestel";
import { MIN_CLUSTER_SIZE } from "@/lib/jobs/clusters";

export const PUBLIC_API_VERSION = "v1" as const;

// ---------------------------------------------------------------------------------
// Constantes de dominio. Se duplican aquí -no se importan- porque en
// `src/lib/jobs/graph.ts` son `const` privadas del módulo; leemos los mismos env
// vars con los mismos defaults para que `/meta` reporte exactamente lo que la
// última corrida del grafo usó, sin tocar ni exportar nada de jobs/graph.ts.
// `MIN_CLUSTER_SIZE` sí está exportado (jobs/clusters.ts) y por eso se importa.
// ---------------------------------------------------------------------------------
const HALF_LIFE_DAYS = Number(process.env.GRAPH_HALF_LIFE_DAYS ?? "30");
const ORPHAN_HALF_LIFE_DAYS = HALF_LIFE_DAYS / 2;
const DEAD_THRESHOLD = 1.0;
const LINK_THRESHOLD = Number(process.env.SEMANTIC_LINK_THRESHOLD ?? "0.55");
// No exportada desde jobs/graph.ts; mismo valor que allá (5 macro-temas por horizonte).
const MAX_MACRO_PER_HORIZON = 5;

// ================================= Helpers puros ==================================

/**
 * Tramos de fuerza de una similitud coseno, por encima del `LINK_THRESHOLD` (0.55)
 * que ya filtra qué pares llegan a ser arista. Bordes inclusivos hacia arriba:
 * exactamente 0.75 es "fuerte", exactamente 0.65 es "media".
 */
export function scoreStrength(score: number): "fuerte" | "media" | "debil" {
  if (score >= 0.75) return "fuerte";
  if (score >= 0.65) return "media";
  return "debil";
}

/**
 * `contentTitle` si existe (no vacío tras trim); si no, los primeros 120 caracteres
 * de `tweetText`, cortando en el último espacio para no partir una palabra a la
 * mitad, con `…` al final. Si `tweetText` ya cabe en 120 caracteres, se devuelve tal
 * cual (sin agregar el `…`, porque no se cortó nada).
 */
export function deriveTitle(contentTitle: string | null, tweetText: string): string {
  const trimmedTitle = contentTitle?.trim();
  if (trimmedTitle) return trimmedTitle;
  return truncateAtWord(tweetText, 120);
}

function truncateAtWord(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const slice = text.slice(0, maxLength);
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace > 0 ? slice.slice(0, lastSpace) : slice;
  return `${cut.trimEnd()}…`;
}

// Narrowing defensivo de columnas `String` (no enums reales en Postgres) a los
// literales que el dominio documenta. Si algún día llega un valor fuera de lo
// esperado (dato corrupto, migración a medias) cae al valor más conservador en vez
// de reventar la respuesta.
function toSignalSource(value: string): "x_like" | "manual" {
  return value === "manual" ? "manual" : "x_like";
}
function toLikedAtSource(value: string): "tweet_date" | "ordered" {
  return value === "ordered" ? "ordered" : "tweet_date";
}
/**
 * `liked_items.publish_status` es `String` con default `'pending'`. Cualquier cosa
 * distinta de `'published'` se reporta como `pending`: el valor conservador aquí es
 * "todavía no lo revisé", no al revés.
 */
function toPublishStatus(value: string): PublishStatus {
  return value === "published" ? "published" : "pending";
}
function toThemeStatus(value: string): "alive" | "dead" {
  return value === "dead" ? "dead" : "alive";
}
function toHorizonSource(value: string): "auto" | "manual" {
  return value === "manual" ? "manual" : "auto";
}
function toHorizonKeyOrNull(value: string | null | undefined): HorizonKey | null {
  return isHorizon(value) ? value : null;
}
// `macro_clusters.horizon` no es nullable en el schema; el fallback es puramente
// defensivo y no debería dispararse nunca en datos sanos.
function toHorizonKeyStrict(value: string): HorizonKey {
  return isHorizon(value) ? value : "H3";
}
const SNAPSHOT_TRIGGERS = ["embed", "cron", "publish", "manual"] as const;
type SnapshotTrigger = (typeof SNAPSHOT_TRIGGERS)[number];
function toSnapshotTrigger(value: string): SnapshotTrigger {
  return (SNAPSHOT_TRIGGERS as readonly string[]).includes(value) ? (value as SnapshotTrigger) : "manual";
}
function decimalToNumberOrNull(value: Prisma.Decimal | null): number | null {
  return value === null ? null : value.toNumber();
}
function dateToIsoOrNull(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

// =================================== Señal =========================================

/** Los dos estados de `liked_items.publish_status`. Ver el bloque de cabecera. */
export type PublishStatus = "published" | "pending";

export type SignalSummaryDTO = {
  id: string;
  source: "x_like" | "manual";
  title: string;
  url: string;
  authorHandle: string;
  authorName: string | null;
  /** OJO: estimada. Ver `likedAtEstimated`/`likedAtSource`. */
  likedAt: string;
  likedAtEstimated: true;
  likedAtSource: "tweet_date" | "ordered";
  category: string | null;
  pestel: string[];
  /** Etiquetas libres generadas por el pipeline (3–5). Vacío si aún no se generaron. */
  tags: string[];
  tldr: string | null;
  vitality: number | null;
  /** `published` = ya revisada y en el grafo; `pending` = sigue en la bandeja. */
  publishStatus: PublishStatus;
  theme: { id: string; name: string; status: "alive" | "dead"; horizon: HorizonKey | null } | null;
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

/** Select mínimo para armar un `SignalSummaryDTO`. Explícito a propósito: así
 *  `embedding`, `ownerId` (y cualquier columna nueva) no pueden colarse nunca por
 *  accidente. */
export const SIGNAL_SUMMARY_SELECT = {
  id: true,
  source: true,
  tweetText: true,
  tweetUrl: true,
  contentUrl: true,
  contentTitle: true,
  authorHandle: true,
  authorName: true,
  likedAt: true,
  likedAtSource: true,
  category: true,
  pestel: true,
  tags: true,
  tldr: true,
  vitality: true,
  publishStatus: true,
  cluster: {
    select: {
      id: true,
      name: true,
      status: true,
      horizon: true,
    },
  },
} satisfies Prisma.LikedItemSelect;

/** Superset de `SIGNAL_SUMMARY_SELECT` con las columnas que solo salen en detalle. */
export const SIGNAL_DETAIL_SELECT = {
  ...SIGNAL_SUMMARY_SELECT,
  tweetId: true,
  tweetCreatedAt: true,
  mediaUrls: true,
  contentDescription: true,
  contentImageUrl: true,
  contentPublishedAt: true,
  categoryConfidence: true,
  categoryReasoning: true,
  whyMatters: true,
  impact: true,
  publishedAt: true,
  vitalityAt: true,
} satisfies Prisma.LikedItemSelect;

type SignalSummaryRow = Prisma.LikedItemGetPayload<{ select: typeof SIGNAL_SUMMARY_SELECT }>;
type SignalDetailRow = Prisma.LikedItemGetPayload<{ select: typeof SIGNAL_DETAIL_SELECT }>;

export function toSignalSummary(item: SignalSummaryRow): SignalSummaryDTO {
  return {
    id: item.id,
    source: toSignalSource(item.source),
    title: deriveTitle(item.contentTitle, item.tweetText),
    url: item.contentUrl ?? item.tweetUrl,
    authorHandle: item.authorHandle,
    authorName: item.authorName,
    likedAt: item.likedAt.toISOString(),
    likedAtEstimated: true,
    likedAtSource: toLikedAtSource(item.likedAtSource),
    category: item.category,
    pestel: normalizePestel(item.pestel),
    tags: item.tags,
    tldr: item.tldr,
    vitality: item.vitality,
    publishStatus: toPublishStatus(item.publishStatus),
    theme: item.cluster
      ? {
          id: item.cluster.id,
          name: item.cluster.name,
          status: toThemeStatus(item.cluster.status),
          horizon: toHorizonKeyOrNull(item.cluster.horizon),
        }
      : null,
  };
}

/** `neighborCount` no sale de ningún `select`: lo cuenta el route handler aparte
 *  (`semanticLink` del tenant con un extremo en esta señal) y lo pasa aquí. */
export function toSignalDetail(item: SignalDetailRow, neighborCount: number): SignalDetailDTO {
  return {
    ...toSignalSummary(item),
    tweetId: item.tweetId,
    tweetText: item.tweetText,
    tweetUrl: item.tweetUrl,
    tweetCreatedAt: dateToIsoOrNull(item.tweetCreatedAt),
    mediaUrls: item.mediaUrls,
    contentUrl: item.contentUrl,
    contentTitle: item.contentTitle,
    contentDescription: item.contentDescription,
    contentImageUrl: item.contentImageUrl,
    contentPublishedAt: dateToIsoOrNull(item.contentPublishedAt),
    categoryConfidence: decimalToNumberOrNull(item.categoryConfidence),
    categoryReasoning: item.categoryReasoning,
    whyMatters: item.whyMatters,
    impact: item.impact,
    publishedAt: dateToIsoOrNull(item.publishedAt),
    vitalityAt: dateToIsoOrNull(item.vitalityAt),
    neighborCount,
  };
}

// ============================= Vecino semántico =====================================

export type NeighborDTO = {
  signal: SignalSummaryDTO;
  score: number;
  strength: "fuerte" | "media" | "debil";
};

/** `otherSignal` ya es "el otro lado" del par (el route handler normaliza cuál de
 *  `itemA`/`itemB` no es la señal consultada antes de llamar aquí). */
export function toNeighbor(otherSignal: SignalSummaryRow, score: number): NeighborDTO {
  return {
    signal: toSignalSummary(otherSignal),
    score,
    strength: scoreStrength(score),
  };
}

// ============================ Tema (SemanticCluster) =================================

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
    velocityDelta: number;
    density: number | null;
    connectivity: number | null;
    novelty: number | null;
    bridgeThemes: number;
  };
  memberIds: string[];
};

export const THEME_SELECT = {
  id: true,
  name: true,
  summary: true,
  status: true,
  size: true,
  vitality: true,
  horizon: true,
  horizonSuggested: true,
  horizonSource: true,
  lastSignalAt: true,
  macroCluster: { select: { id: true, name: true } },
} satisfies Prisma.SemanticClusterSelect;

export const THEME_DETAIL_SELECT = {
  ...THEME_SELECT,
  firstSeenAt: true,
  diedAt: true,
  revivedCount: true,
  velocity30d: true,
  velocityPrev30d: true,
  density: true,
  connectivity: true,
  novelty: true,
  bridgeClusters: true,
  lastMemberIds: true,
} satisfies Prisma.SemanticClusterSelect;

type ThemeSummaryRow = Prisma.SemanticClusterGetPayload<{ select: typeof THEME_SELECT }>;
type ThemeDetailRow = Prisma.SemanticClusterGetPayload<{ select: typeof THEME_DETAIL_SELECT }>;

export function toThemeSummary(cluster: ThemeSummaryRow): ThemeSummaryDTO {
  return {
    id: cluster.id,
    name: cluster.name,
    summary: cluster.summary,
    status: toThemeStatus(cluster.status),
    size: cluster.size,
    vitality: cluster.vitality,
    horizon: toHorizonKeyOrNull(cluster.horizon),
    horizonSuggested: toHorizonKeyOrNull(cluster.horizonSuggested),
    horizonSource: toHorizonSource(cluster.horizonSource),
    macroTheme: cluster.macroCluster ? { id: cluster.macroCluster.id, name: cluster.macroCluster.name } : null,
    lastSignalAt: dateToIsoOrNull(cluster.lastSignalAt),
  };
}

/**
 * `memberIds` sale de `lastMemberIds`: la membresía de la ÚLTIMA corrida del grafo.
 *
 * En el origen este campo se cruzaba contra `publishStatus` antes de devolverlo,
 * porque una señal despublicada seguía listada ahí y `/signals/{id}` respondía 404
 * con ella — el contrato se rompía. Aquí no hay tal cruce: el banco entero es
 * visible para su dueño, así que cualquier id de `lastMemberIds` resuelve. Sí puede
 * quedar desfasado (una señal borrada entre corridas), y por eso el parámetro
 * `existingMemberIds` sigue existiendo: el route handler que quiera garantizar que
 * cada id resuelve puede pasar la lista ya verificada.
 */
export function toThemeDetail(cluster: ThemeDetailRow, existingMemberIds?: string[]): ThemeDetailDTO {
  return {
    ...toThemeSummary(cluster),
    firstSeenAt: cluster.firstSeenAt.toISOString(),
    diedAt: dateToIsoOrNull(cluster.diedAt),
    revivedCount: cluster.revivedCount,
    indicators: {
      velocity30d: cluster.velocity30d,
      velocityPrev30d: cluster.velocityPrev30d,
      // Derivado a propósito: que el agente no tenga que restar dos campos.
      velocityDelta: cluster.velocity30d - cluster.velocityPrev30d,
      density: cluster.density,
      connectivity: cluster.connectivity,
      novelty: cluster.novelty,
      bridgeThemes: cluster.bridgeClusters,
    },
    memberIds: existingMemberIds ?? cluster.lastMemberIds,
  };
}

// ================================= Macro-tema ========================================

export type MacroThemeDTO = {
  id: string;
  name: string;
  summary: string;
  horizon: HorizonKey;
  themes: ThemeSummaryDTO[];
};

export const MACRO_THEME_SELECT = {
  id: true,
  name: true,
  summary: true,
  horizon: true,
  clusters: { select: THEME_SELECT },
} satisfies Prisma.MacroClusterSelect;

type MacroThemeRow = Prisma.MacroClusterGetPayload<{ select: typeof MACRO_THEME_SELECT }>;

export function toMacroTheme(macro: MacroThemeRow): MacroThemeDTO {
  return {
    id: macro.id,
    name: macro.name,
    summary: macro.summary,
    horizon: toHorizonKeyStrict(macro.horizon),
    themes: macro.clusters.map(toThemeSummary),
  };
}

// =================================== Horizonte =======================================

export type HorizonDTO = {
  key: HorizonKey;
  labelShort: string;
  labelLong: string;
  themeCount: number;
  signalCount: number;
  vitalitySum: number;
  macroThemes: MacroThemeDTO[];
};

/** No hay un `select` de Prisma para un horizonte: es una agregación (conteos sobre
 *  `semantic_clusters` agrupado por `horizon`) que arma `public-horizons.ts`. Este
 *  mapper solo le pone las etiquetas de `HORIZON_LABELS` encima. */
export type HorizonAggregateInput = {
  key: HorizonKey;
  themeCount: number;
  signalCount: number;
  vitalitySum: number;
  macroThemes: MacroThemeDTO[];
};

export function toHorizon(input: HorizonAggregateInput): HorizonDTO {
  const labels = HORIZON_LABELS[input.key];
  return {
    key: input.key,
    labelShort: labels.short,
    labelLong: labels.long,
    themeCount: input.themeCount,
    signalCount: input.signalCount,
    vitalitySum: input.vitalitySum,
    macroThemes: input.macroThemes,
  };
}

// ============================== Categoría / PESTEL ====================================

export type CategoryDTO = {
  name: string;
  description: string;
  examples: string[];
  position: number;
  isFallback: boolean;
  signalCount: number;
  inCatalog: boolean;
};

/** Igual que arriba: `Category` de Prisma trae `id`/`ownerId`/`createdAt`/`updatedAt`
 *  que no son del DTO — `ownerId` muy en particular. El caller (getCategoriesOverview
 *  + conteos) arma este input a mano; el mapper es la barrera que evita que esas
 *  columnas de sobra se cuelen. */
export function toCategory(input: CategoryDTO): CategoryDTO {
  return {
    name: input.name,
    description: input.description,
    examples: input.examples,
    position: input.position,
    isFallback: input.isFallback,
    signalCount: input.signalCount,
    inCatalog: input.inCatalog,
  };
}

export type PestelDTO = { key: string; letter: string; label: string; signalCount: number };

export function toPestel(dimension: PestelDimension, signalCount: number): PestelDTO {
  return {
    key: dimension.key,
    letter: dimension.letter,
    label: dimension.label,
    signalCount,
  };
}

// =================================== Snapshot =========================================

export type SnapshotSummaryDTO = {
  id: string;
  takenAt: string;
  trigger: "embed" | "cron" | "publish" | "manual";
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

export const SNAPSHOT_SUMMARY_SELECT = {
  id: true,
  takenAt: true,
  trigger: true,
  nodes: true,
  links: true,
  clustersAlive: true,
  clustersDead: true,
  orphans: true,
} satisfies Prisma.GraphSnapshotSelect;

/** `graph_snapshot_clusters` tiene además `horizonSuggested` en este schema; se deja
 *  fuera a propósito: la serie histórica es para ver cómo evolucionó un tema, y la
 *  sugerencia de la heurística en cada corrida es ruido del pipeline, no historia. */
export const SNAPSHOT_THEME_ROW_SELECT = {
  clusterId: true,
  name: true,
  size: true,
  status: true,
  vitality: true,
  velocity30d: true,
  density: true,
  connectivity: true,
  novelty: true,
  horizon: true,
} satisfies Prisma.GraphSnapshotClusterSelect;

type SnapshotSummaryRow = Prisma.GraphSnapshotGetPayload<{ select: typeof SNAPSHOT_SUMMARY_SELECT }>;
type SnapshotThemeRowRow = Prisma.GraphSnapshotClusterGetPayload<{ select: typeof SNAPSHOT_THEME_ROW_SELECT }>;

export function toSnapshotSummary(snapshot: SnapshotSummaryRow): SnapshotSummaryDTO {
  return {
    id: snapshot.id,
    takenAt: snapshot.takenAt.toISOString(),
    trigger: toSnapshotTrigger(snapshot.trigger),
    nodes: snapshot.nodes,
    links: snapshot.links,
    themesAlive: snapshot.clustersAlive,
    themesDead: snapshot.clustersDead,
    orphans: snapshot.orphans,
  };
}

export function toSnapshotThemeRow(row: SnapshotThemeRowRow): SnapshotThemeRowDTO {
  return {
    themeId: row.clusterId,
    name: row.name,
    size: row.size,
    status: row.status,
    vitality: row.vitality,
    velocity30d: row.velocity30d,
    density: row.density,
    connectivity: row.connectivity,
    novelty: row.novelty,
    horizon: toHorizonKeyOrNull(row.horizon),
  };
}

/**
 * Membresía señal→tema de un snapshot (`graph_snapshot_members`). Es el `?includeMembers`
 * de `/snapshots/[id]`, y por eso ese endpoint va con el bucket de rate limit caro.
 * `ownerId`/`snapshotId` no viajan: el primero está prohibido, el segundo ya lo sabe
 * quien pidió el snapshot.
 */
export type SnapshotMemberDTO = { signalId: string; themeId: string | null; vitality: number };

export const SNAPSHOT_MEMBER_SELECT = {
  itemId: true,
  clusterId: true,
  vitality: true,
} satisfies Prisma.GraphSnapshotMemberSelect;

type SnapshotMemberRow = Prisma.GraphSnapshotMemberGetPayload<{ select: typeof SNAPSHOT_MEMBER_SELECT }>;

export function toSnapshotMember(row: SnapshotMemberRow): SnapshotMemberDTO {
  return { signalId: row.itemId, themeId: row.clusterId, vitality: row.vitality };
}

// ===================================== Grafo ==========================================

export type GraphNodeDTO = {
  id: string;
  title: string;
  vitality: number | null;
  themeId: string | null;
  category: string | null;
  horizon: HorizonKey | null;
};

export type GraphEdgeDTO = { a: string; b: string; score: number; strength: "fuerte" | "media" | "debil" };

export type GraphDTO = {
  nodes: GraphNodeDTO[];
  edges: GraphEdgeDTO[];
  stats: { nodes: number; edges: number; themesAlive: number; themesDead: number; orphans: number };
};

/** Nodos = señales del tenant con `embeddedAt != null` (el route handler pone ese
 *  filtro, no este archivo). El `select` nunca toca `embedding` ni `ownerId`: aquí
 *  solo viaja `vitality`/`clusterId`/`category` y el horizonte del tema, si tiene. */
export const GRAPH_NODE_SELECT = {
  id: true,
  contentTitle: true,
  tweetText: true,
  vitality: true,
  clusterId: true,
  category: true,
  cluster: { select: { horizon: true } },
} satisfies Prisma.LikedItemSelect;

/** Aristas = `semantic_links` del tenant. El job de grafo solo las crea entre señales
 *  publicadas, así que no hace falta volver a filtrarlo aquí ni en el handler. */
export const GRAPH_EDGE_SELECT = {
  itemAId: true,
  itemBId: true,
  score: true,
} satisfies Prisma.SemanticLinkSelect;

type GraphNodeRow = Prisma.LikedItemGetPayload<{ select: typeof GRAPH_NODE_SELECT }>;
type GraphEdgeRow = Prisma.SemanticLinkGetPayload<{ select: typeof GRAPH_EDGE_SELECT }>;

export function toGraphNode(item: GraphNodeRow): GraphNodeDTO {
  return {
    id: item.id,
    title: deriveTitle(item.contentTitle, item.tweetText),
    vitality: item.vitality,
    themeId: item.clusterId,
    category: item.category,
    horizon: item.cluster ? toHorizonKeyOrNull(item.cluster.horizon) : null,
  };
}

export function toGraphEdge(link: GraphEdgeRow): GraphEdgeDTO {
  return {
    a: link.itemAId,
    b: link.itemBId,
    score: link.score,
    strength: scoreStrength(link.score),
  };
}

// ===================================== Meta ============================================

/**
 * `/meta` describe EL BANCO DE QUIEN PREGUNTA, no la plataforma: los conteos salen
 * de `withOwner(ownerId, …)` como todo lo demás. En el origen `counts` solo tenía
 * `publishedSignals` (era el único material visible); aquí se reporta el total del
 * banco y, aparte, cuánto de eso ya está publicado — que es justo la información
 * que un agente necesita para saber si vale la pena filtrar por `publishStatus`.
 */
export type MetaDTO = {
  apiVersion: "v1";
  generatedAt: string;
  counts: {
    /** Todas las señales del banco, publicadas o no. */
    signals: number;
    /** Subconjunto de `signals` con `publishStatus = 'published'` (las que entran al grafo). */
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

export type MetaInput = {
  counts: MetaDTO["counts"];
  lastGraphRunAt: Date | null;
  dateRange: { earliestLikedAt: Date | null; latestLikedAt: Date | null };
};

export function toMeta(input: MetaInput): MetaDTO {
  return {
    apiVersion: PUBLIC_API_VERSION,
    generatedAt: new Date().toISOString(),
    counts: input.counts,
    lastGraphRunAt: dateToIsoOrNull(input.lastGraphRunAt),
    dateRange: {
      earliestLikedAt: dateToIsoOrNull(input.dateRange.earliestLikedAt),
      latestLikedAt: dateToIsoOrNull(input.dateRange.latestLikedAt),
    },
    domain: {
      halfLifeDays: HALF_LIFE_DAYS,
      orphanHalfLifeDays: ORPHAN_HALF_LIFE_DAYS,
      deadThreshold: DEAD_THRESHOLD,
      linkThreshold: LINK_THRESHOLD,
      minThemeSize: MIN_CLUSTER_SIZE,
      maxMacroPerHorizon: MAX_MACRO_PER_HORIZON,
    },
  };
}
