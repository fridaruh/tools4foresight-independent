/**
 * Grafo semántico POR TENANT (PLAN §3.9).
 *
 * Rehace todo lo derivado de los embeddings de UN owner: aristas → temas con
 * linaje → vitalidad → indicadores → horizonte → snapshot. No embebe nada (eso es
 * src/lib/jobs/embed.ts); el bautizo de temas nuevos o cambiados va al chat de
 * ollama.com con la key global de la plataforma.
 *
 * ── Aislamiento ──────────────────────────────────────────────────────────────
 * Este archivo es el que más SQL crudo tiene del proyecto, y el SQL crudo NO pasa
 * por la extensión de Prisma que inyecta `ownerId`. Dos reglas, sin excepción:
 *   1. Todo corre dentro de `withOwner(ownerId, …)`, que fija `app.owner_id` LOCAL
 *      a la transacción (única forma que funciona con el pooler de Neon).
 *   2. Además, CADA query lleva su `owner_id = $1` explícito. RLS es la red de
 *      seguridad, no el filtro: si mañana alguien corre esto con bypass, el SQL
 *      sigue siendo de un solo tenant.
 * El "centroide global" de la novedad es el centroide DEL TENANT, y los cuantiles
 * de horizonte se calculan sobre los temas vivos DEL TENANT.
 *
 * ── Forma de la corrida ──────────────────────────────────────────────────────
 *   Fase A (tx de lectura): recomputeLinks + leer items, aristas y linajes.
 *   Fase B (SIN tx):        detectar comunidades, emparejar linajes y BAUTIZAR
 *                           con Ollama — son decenas de segundos de red y no
 *                           tienen por qué ocupar una conexión del pooler.
 *   Fase C (tx de escritura): crear/actualizar temas, vitalidad, indicadores
 *                           (pgvector), horizontes, snapshot y `graphDirtyAt=null`.
 * Ambas transacciones piden 120 s de timeout: la fase C hace un UPDATE por tema
 * más dos queries de pgvector por tema, y con catálogos grandes los 30 s por
 * defecto no alcanzan.
 */
import {
  MIN_CLUSTER_SIZE,
  detectCommunities,
  groupClusters,
  membersHash,
  nameCluster,
  type GraphEdge,
  type GraphNode,
  type MacroInput,
} from "@/lib/jobs/clusters";
import type { HorizonKey } from "@/lib/horizons";
import { budgetExceeded, type JobFn, type JobResult } from "@/lib/jobs/types";
import { withOwner, type TenantTx } from "@/lib/tenant-db";

// Umbral de similitud coseno para que un par de señales sea arista, y cuantos
// vecinos como maximo aporta cada señal. Ajustables por env sin tocar codigo:
// subir el umbral limpia el grafo, bajarlo lo conecta mas.
const LINK_THRESHOLD = Number(process.env.SEMANTIC_LINK_THRESHOLD ?? "0.55");
const LINK_TOP_K = Number(process.env.SEMANTIC_LINK_TOP_K ?? "8");

// --- Vitalidad (decision de Frida, 2026-08-20) ---
// Una señal pierde la mitad de su vitalidad cada HALF_LIFE_DAYS sin continuidad.
// Las huerfanas (sin tema) decaen al doble de velocidad: si nada llego a
// acompañarlas, fueron ruido; si algo llega, renacen como tema.
const HALF_LIFE_DAYS = Number(process.env.GRAPH_HALF_LIFE_DAYS ?? "30");
const ORPHAN_HALF_LIFE_DAYS = HALF_LIFE_DAYS / 2;
// Un tema con menos vitalidad que una sola señal fresca esta muerto. Reversible:
// se recalcula en cada corrida, asi que si llegan señales nuevas resucita.
const DEAD_THRESHOLD = 1.0;
// Solapamiento minimo (Jaccard sobre ids) para decir "esta comunidad es el mismo
// tema que aquel linaje". Por debajo, el tema viejo muere y nace uno nuevo.
const LINEAGE_JACCARD = 0.3;
// Tope de macro-temas por columna de horizonte en /horizontes (decisión de
// Frida, 2026-08-23): 3 horizontes × 5 = 15 macro-temas como mucho, en vez de
// mostrar sueltos los N temas finos que arme el grafo.
const MAX_MACRO_PER_HORIZON = 5;

/** Tope de las dos transacciones del job (ver cabecera). */
const TX_TIMEOUT_MS = 120_000;

/** Margen mínimo para arrancar una corrida completa desde `runGraph`. Por debajo
 *  ni se intenta: media corrida no sirve de nada y deja temas sin snapshot. */
const MIN_BUDGET_MS = 45_000;

export type GraphTrigger = "embed" | "cron" | "publish" | "manual";
/** Alias histórico; la fuente de verdad de los horizontes es src/lib/horizons.ts. */
export type Horizon = HorizonKey;

type Item = {
  id: string;
  title: string;
  tldr: string | null;
  likedAt: Date;
};

type ClusterRow = {
  id: string;
  name: string;
  summary: string;
  membersHash: string;
  status: string;
  lastMemberIds: string[];
  horizon: string | null;
  horizonSource: string;
  revivedCount: number;
};

type ClusterStats = {
  id: string;
  members: string[];
  size: number;
  vitality: number;
  lastSignalAt: Date | null;
  velocity30d: number;
  velocityPrev30d: number;
  density: number | null;
  connectivity: number | null;
  novelty: number | null;
  bridgeClusters: number;
};

/** Una comunidad ya emparejada con su linaje y (si hacía falta) bautizada. */
type PlannedCluster = {
  members: string[];
  hash: string;
  prev: ClusterRow | null;
  /** null = la membresía no cambió, se reusa el nombre del linaje tal cual. */
  title: { name: string; summary: string } | null;
};

type ResolvedCluster = {
  clusterId: string;
  members: string[];
  hash: string;
  existing: ClusterRow | null;
};

export type GraphSummary = {
  ok: boolean;
  trigger: GraphTrigger;
  snapshotId: string;
  nodes: number;
  links: number;
  clusters: number;
  named: number;
  reused: number;
  alive: number;
  dead: number;
  died: number;
  revived: number;
  orphans: number;
  macroGroups: number;
  clusterErrors?: string[];
};

// ---------------------------------------------------------------------------
// Punto de entrada del job (contrato de src/lib/jobs/types.ts)
// ---------------------------------------------------------------------------

/** `chain` (lo dispara /api/sync) es, para efectos del snapshot, una corrida
 *  manual: la pidió una persona. */
function graphTrigger(trigger: "cron" | "manual" | "chain"): GraphTrigger {
  return trigger === "chain" ? "manual" : trigger;
}

/**
 * Corre el grafo completo del tenant. No es incremental ni reanudable: o entra
 * entera o no entra, así que el presupuesto se evalúa una sola vez al principio.
 */
export const runGraph: JobFn = async (ctx): Promise<JobResult> => {
  if (budgetExceeded(ctx, MIN_BUDGET_MS)) {
    return { ok: true, processed: 0, remaining: 1, stoppedOnBudget: true };
  }

  try {
    const summary = await refreshGraph(ctx.ownerId, graphTrigger(ctx.trigger));
    return {
      ok: summary.ok,
      processed: summary.nodes,
      remaining: 0,
      stoppedOnBudget: false,
      ...(summary.clusterErrors ? { error: summary.clusterErrors[0] } : {}),
      details: { ...summary },
    };
  } catch (error) {
    return {
      ok: false,
      processed: 0,
      remaining: 1,
      stoppedOnBudget: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

// ---------------------------------------------------------------------------
// refreshGraph: el trabajo de verdad
// ---------------------------------------------------------------------------

/**
 * Interna al job: la llama `runGraph`. Sigue exportada porque `/api/jobs/graph`
 * y el PATCH de publicar todavía la usan mientras aterrizan las tareas 3.10 y
 * 3.11; cuando esas pasen a `runGraph(ctx)`, deja de exportarse.
 *
 * Es idempotente: correrla dos veces seguidas produce dos snapshots iguales salvo
 * la fecha.
 */
export async function refreshGraph(ownerId: string, trigger: GraphTrigger): Promise<GraphSummary> {
  const now = new Date();

  // ── Fase A: aristas + lectura ─────────────────────────────────────────────
  const read = await withOwner(
    ownerId,
    async (tx) => {
      const links = await recomputeLinks(tx, ownerId);

      // Secuencial y no Promise.all: dentro de una transacción interactiva todo
      // va por la misma conexión, así que el paralelismo no compra nada y sí
      // complica el diagnóstico cuando una de las tres falla.
      const rawItems = await tx.likedItem.findMany({
        where: { ownerId, publishStatus: "published", embeddedAt: { not: null } },
        select: { id: true, contentTitle: true, tweetText: true, tldr: true, likedAt: true },
      });
      const rawLinks = await tx.semanticLink.findMany({
        where: {
          ownerId,
          itemA: { ownerId, publishStatus: "published" },
          itemB: { ownerId, publishStatus: "published" },
        },
        select: { itemAId: true, itemBId: true, score: true },
      });
      const existing = await tx.semanticCluster.findMany({
        where: { ownerId },
        select: {
          id: true,
          name: true,
          summary: true,
          membersHash: true,
          status: true,
          lastMemberIds: true,
          horizon: true,
          horizonSource: true,
          revivedCount: true,
        },
      });

      return { links, rawItems, rawLinks, existing };
    },
    { timeoutMs: TX_TIMEOUT_MS },
  );

  const items: Item[] = read.rawItems.map((i) => ({
    id: i.id,
    title: i.contentTitle ?? i.tweetText.slice(0, 90),
    tldr: i.tldr,
    likedAt: i.likedAt,
  }));
  const itemById = new Map(items.map((i) => [i.id, i]));
  const edges: GraphEdge[] = read.rawLinks.map((l) => ({
    a: l.itemAId,
    b: l.itemBId,
    score: l.score,
  }));
  const existing = read.existing;

  // ── Fase B: comunidades, linajes y bautizo (fuera de transacción) ─────────
  const communities = detectCommunities(
    items.map((i) => i.id),
    edges,
  ).filter((members) => members.length >= MIN_CLUSTER_SIZE);

  const matches = matchLineages(communities, existing);

  const errors: string[] = [];
  let named = 0;
  let reused = 0;
  const planned: PlannedCluster[] = [];

  for (let i = 0; i < communities.length; i += 1) {
    const members = communities[i];
    const hash = membersHash(members);
    const prev = matches[i];

    // Cache por hash de membresía: si el tema es el mismo, no se vuelve a pagar
    // una llamada al modelo.
    if (prev && prev.membersHash === hash && prev.summary !== "") {
      reused += 1;
      planned.push({ members, hash, prev, title: null });
      continue;
    }

    const nodes: GraphNode[] = members
      .map((id) => itemById.get(id))
      .filter((n): n is Item => Boolean(n))
      .map((n) => ({ id: n.id, title: n.title, tldr: n.tldr }));

    let title: { name: string; summary: string };
    try {
      title = await nameCluster(nodes);
      named += 1;
    } catch (error) {
      // Un bautizo que falla no tumba la corrida: el tema entra (o sigue) con
      // nombre provisional y summary vacio, y la siguiente corrida lo reintenta.
      errors.push(error instanceof Error ? error.message : String(error));
      title = prev
        ? { name: prev.name, summary: "" }
        : { name: `Tema de ${members.length} señales`, summary: "" };
    }
    planned.push({ members, hash, prev, title });
  }

  // ── Fase C: escritura ─────────────────────────────────────────────────────
  const written = await withOwner(
    ownerId,
    async (tx) => {
      // 1. Materializar los temas (crear los nuevos, renombrar los que cambiaron).
      const resolved: ResolvedCluster[] = [];
      const resolvedNames = new Map<string, { name: string; summary: string }>();
      for (const p of planned) {
        if (p.title === null && p.prev) {
          resolved.push({ clusterId: p.prev.id, members: p.members, hash: p.hash, existing: p.prev });
          resolvedNames.set(p.prev.id, { name: p.prev.name, summary: p.prev.summary });
          continue;
        }
        if (p.prev) {
          await tx.semanticCluster.updateMany({
            where: { id: p.prev.id, ownerId },
            data: { name: p.title!.name, summary: p.title!.summary },
          });
          resolved.push({ clusterId: p.prev.id, members: p.members, hash: p.hash, existing: p.prev });
          resolvedNames.set(p.prev.id, { name: p.title!.name, summary: p.title!.summary });
        } else {
          const created = await tx.semanticCluster.create({
            data: {
              ownerId,
              name: p.title!.name,
              summary: p.title!.summary,
              membersHash: p.hash,
              size: p.members.length,
            },
            select: { id: true },
          });
          resolved.push({ clusterId: created.id, members: p.members, hash: p.hash, existing: null });
          resolvedNames.set(created.id, { name: p.title!.name, summary: p.title!.summary });
        }
      }

      // 2. Vitalidad por señal (puro, sin base).
      const clusterOfItem = new Map<string, string>();
      for (const r of resolved) for (const id of r.members) clusterOfItem.set(id, r.clusterId);
      const vitality = computeVitality(items, edges, clusterOfItem, now);

      // 3. Indicadores por tema (density/novelty salen de pgvector, acotados al tenant).
      const stats: ClusterStats[] = [];
      for (const r of resolved) {
        stats.push(
          await clusterStats(tx, ownerId, r.clusterId, r.members, itemById, edges, clusterOfItem, vitality, now),
        );
      }

      // 4. Horizonte sugerido sobre los temas VIVOS DE ESTE TENANT.
      const suggested = suggestHorizons(stats.filter((s) => s.vitality >= DEAD_THRESHOLD));

      // 5. Armar updates y filas de snapshot.
      const resolvedIds = new Set(resolved.map((r) => r.clusterId));
      const orphanIds = items.filter((i) => !clusterOfItem.has(i.id)).map((i) => i.id);
      const clusterUpdates: { id: string; data: Record<string, unknown> }[] = [];
      const snapshotClusters: {
        clusterId: string;
        name: string;
        size: number;
        status: string;
        vitality: number;
        velocity30d: number;
        density: number | null;
        connectivity: number | null;
        novelty: number | null;
        horizon: string | null;
        horizonSuggested: string | null;
      }[] = [];
      let alive = 0;
      let dead = 0;
      let revived = 0;
      let died = 0;
      const clustersByHorizon = new Map<string, MacroInput[]>();

      for (const r of resolved) {
        const s = stats.find((x) => x.id === r.clusterId)!;
        const prev = r.existing;
        const isAlive = s.vitality >= DEAD_THRESHOLD;
        const wasAlive = prev ? prev.status === "alive" : true;
        const horizonSuggested = isAlive ? (suggested.get(r.clusterId) ?? null) : null;
        const horizon = prev && prev.horizonSource === "manual" ? prev.horizon : horizonSuggested;
        if (isAlive) alive += 1;
        else dead += 1;
        if (prev && !wasAlive && isAlive) revived += 1;
        if (prev && wasAlive && !isAlive) died += 1;

        if (isAlive && horizon) {
          const bucket = clustersByHorizon.get(horizon) ?? [];
          const named = resolvedNames.get(r.clusterId);
          bucket.push({ id: r.clusterId, name: named?.name ?? "", summary: named?.summary ?? "", size: s.size });
          clustersByHorizon.set(horizon, bucket);
        }

        clusterUpdates.push({
          id: r.clusterId,
          data: {
            membersHash: r.hash,
            size: s.size,
            lastMemberIds: [...r.members].sort(),
            status: isAlive ? "alive" : "dead",
            vitality: s.vitality,
            lastSignalAt: s.lastSignalAt,
            diedAt: isAlive ? null : wasAlive || !prev ? now : undefined,
            revivedCount: prev && !wasAlive && isAlive ? prev.revivedCount + 1 : undefined,
            horizon,
            horizonSuggested,
            velocity30d: s.velocity30d,
            velocityPrev30d: s.velocityPrev30d,
            density: s.density,
            connectivity: s.connectivity,
            novelty: s.novelty,
            bridgeClusters: s.bridgeClusters,
          },
        });
        snapshotClusters.push({
          clusterId: r.clusterId,
          name: prev && prev.membersHash === r.hash ? prev.name : "",
          size: s.size,
          status: isAlive ? "alive" : "dead",
          vitality: s.vitality,
          velocity30d: s.velocity30d,
          density: s.density,
          connectivity: s.connectivity,
          novelty: s.novelty,
          horizon,
          horizonSuggested,
        });
      }

      // Linajes que no aparecieron esta corrida: fosiles. Conservan su ultima
      // membresia y su vitalidad sigue decayendo con la de esas señales.
      for (const prev of existing) {
        if (resolvedIds.has(prev.id)) continue;
        const fossilVitality = prev.lastMemberIds.reduce((sum, id) => sum + (vitality.get(id) ?? 0), 0);
        const wasAlive = prev.status === "alive";
        if (wasAlive) died += 1;
        dead += 1;
        clusterUpdates.push({
          id: prev.id,
          data: {
            status: "dead",
            vitality: fossilVitality,
            diedAt: wasAlive ? now : undefined,
            horizonSuggested: null,
            horizon: prev.horizonSource === "manual" ? prev.horizon : null,
          },
        });
        snapshotClusters.push({
          clusterId: prev.id,
          name: prev.name,
          size: 0,
          status: "dead",
          vitality: fossilVitality,
          velocity30d: 0,
          density: null,
          connectivity: null,
          novelty: null,
          horizon: prev.horizonSource === "manual" ? prev.horizon : null,
          horizonSuggested: null,
        });
      }

      // 6. Escribir membresías, vitalidad, temas y snapshot.
      await tx.likedItem.updateMany({
        data: { clusterId: null },
        where: { ownerId, clusterId: { not: null } },
      });
      for (const r of resolved) {
        await tx.likedItem.updateMany({
          data: { clusterId: r.clusterId },
          where: { ownerId, id: { in: r.members } },
        });
      }

      // Vitalidad de todas las señales del grafo en un solo UPDATE.
      const vitIds = items.map((i) => i.id);
      const vitVals = vitIds.map((id) => vitality.get(id) ?? 0);
      if (vitIds.length > 0) {
        await tx.$executeRaw`
          UPDATE liked_items AS i
          SET vitality = v.vit, vitality_at = ${now}
          FROM unnest(${vitIds}::text[], ${vitVals}::float8[]) AS v(id, vit)
          WHERE i.id = v.id AND i.owner_id = ${ownerId}`;
      }

      for (const u of clusterUpdates) {
        await tx.semanticCluster.updateMany({
          where: { id: u.id, ownerId },
          data: u.data as Parameters<typeof tx.semanticCluster.updateMany>[0]["data"],
        });
      }

      const snap = await tx.graphSnapshot.create({
        data: {
          ownerId,
          takenAt: now,
          trigger,
          nodes: items.length,
          links: read.links,
          clustersAlive: alive,
          clustersDead: dead,
          orphans: orphanIds.length,
        },
        select: { id: true },
      });

      // El nombre vacio marca "tomalo del tema" (se acaba de bautizar en esta corrida).
      const names = new Map(
        (await tx.semanticCluster.findMany({ where: { ownerId }, select: { id: true, name: true } })).map(
          (c) => [c.id, c.name] as const,
        ),
      );
      await tx.graphSnapshotCluster.createMany({
        data: snapshotClusters.map((c) => ({
          ...c,
          ownerId,
          snapshotId: snap.id,
          name: c.name || (names.get(c.clusterId) ?? ""),
        })),
      });
      await tx.graphSnapshotMember.createMany({
        data: items.map((i) => ({
          ownerId,
          snapshotId: snap.id,
          itemId: i.id,
          clusterId: clusterOfItem.get(i.id) ?? null,
          vitality: vitality.get(i.id) ?? 0,
        })),
      });

      // El grafo de este tenant ya está al día: se apaga la marca de sucio que
      // pusieron el job de embeddings o el PATCH de publicar (PLAN §3.10).
      await tx.userQuota.updateMany({ where: { userId: ownerId }, data: { graphDirtyAt: null } });

      return {
        snapshotId: snap.id,
        clusters: resolved.length,
        alive,
        dead,
        died,
        revived,
        orphans: orphanIds.length,
        clustersByHorizon,
      };
    },
    { timeoutMs: TX_TIMEOUT_MS },
  );

  // ── Fase D: macro-temas (fuera de tx — llamadas a Ollama) ─────────────────
  const macroErrors: string[] = [];
  let macroGroups = 0;
  try {
    macroGroups = await rebuildMacroClusters(ownerId, written.clustersByHorizon);
  } catch (error) {
    // Un macro-tema mal armado no invalida la corrida del grafo: /horizontes
    // cae de vuelta a mostrar los temas finos sueltos hasta la próxima corrida.
    macroErrors.push(error instanceof Error ? error.message : String(error));
  }

  return {
    ok: errors.length === 0,
    trigger,
    snapshotId: written.snapshotId,
    nodes: items.length,
    links: read.links,
    clusters: written.clusters,
    named,
    reused,
    alive: written.alive,
    dead: written.dead,
    died: written.died,
    revived: written.revived,
    orphans: written.orphans,
    macroGroups,
    ...(errors.length > 0 || macroErrors.length > 0
      ? { clusterErrors: [...errors, ...macroErrors].slice(0, 3) }
      : {}),
  };
}

/**
 * Reconstruye los macro-temas del tenant DESDE CERO en cada corrida: sin linaje
 * propio, a diferencia de `SemanticCluster` (PLAN Horizontes, 2026-08-23). Por
 * cada horizonte con más de `MAX_MACRO_PER_HORIZON` temas vivos, se agrupan con
 * Ollama (`groupClusters`); con menos, cada tema fino es su propio macro-tema de
 * 1 (sin llamar al modelo). Devuelve cuántos macro-temas quedaron.
 *
 * Borrar los `MacroCluster` viejos primero y crear los nuevos después dentro de
 * la MISMA transacción evita un estado a medias — y el `onDelete: SetNull` del
 * lado de `SemanticCluster.macroClusterId` limpia solo las referencias viejas.
 */
async function rebuildMacroClusters(
  ownerId: string,
  clustersByHorizon: Map<string, MacroInput[]>,
): Promise<number> {
  const groupsByHorizon = new Map<string, Awaited<ReturnType<typeof groupClusters>>>();
  for (const [horizon, clusters] of clustersByHorizon) {
    if (clusters.length === 0) continue;
    groupsByHorizon.set(horizon, await groupClusters(clusters, MAX_MACRO_PER_HORIZON));
  }

  return withOwner(ownerId, async (tx) => {
    await tx.macroCluster.deleteMany({ where: { ownerId } });

    let total = 0;
    for (const [horizon, groups] of groupsByHorizon) {
      for (const group of groups) {
        if (group.memberIds.length === 0) continue;
        const created = await tx.macroCluster.create({
          data: { ownerId, name: group.name, summary: group.summary, horizon },
          select: { id: true },
        });
        await tx.semanticCluster.updateMany({
          where: { id: { in: group.memberIds }, ownerId },
          data: { macroClusterId: created.id },
        });
        total += 1;
      }
    }
    return total;
  });
}

/**
 * Rehace `semantic_links` DEL TENANT: por cada señal publicada con embedding, sus
 * LINK_TOP_K vecinas mas cercanas por coseno, cortadas en LINK_THRESHOLD. El par
 * va ordenado (LEAST/GREATEST) y el GROUP BY deduplica A→B y B→A. Completo y no
 * por item: con cientos de señales el pairwise en Postgres es instantaneo y evita
 * el bug sutil de borrar por item los enlaces que otro item habia creado.
 *
 * Los DOS lados del LATERAL filtran `owner_id`: sin eso, el vecino más cercano de
 * una señal de A podría ser una señal de B (RLS lo taparía, pero el plan de
 * ejecución y el resultado dependerían de una barrera que este SQL no debería
 * necesitar). Es interna a propósito — solo `refreshGraph` la llama, y siempre
 * dentro de `withOwner`.
 */
async function recomputeLinks(tx: TenantTx, ownerId: string): Promise<number> {
  await tx.$executeRaw`DELETE FROM semantic_links WHERE owner_id = ${ownerId}`;
  return tx.$executeRaw`
    INSERT INTO semantic_links (id, owner_id, item_a_id, item_b_id, score)
    SELECT gen_random_uuid()::text, ${ownerId}, pair.a, pair.b, MAX(pair.score)
    FROM (
      SELECT LEAST(src.id, n.id) AS a, GREATEST(src.id, n.id) AS b, n.score
      FROM liked_items src
      CROSS JOIN LATERAL (
        SELECT other.id, 1 - (other.embedding <=> src.embedding) AS score
        FROM liked_items other
        WHERE other.owner_id = ${ownerId}
          AND other.id <> src.id
          AND other.embedding IS NOT NULL
          AND other.publish_status = 'published'
        ORDER BY other.embedding <=> src.embedding
        LIMIT ${LINK_TOP_K}
      ) n
      WHERE src.owner_id = ${ownerId}
        AND src.embedding IS NOT NULL
        AND src.publish_status = 'published'
        AND n.score >= ${LINK_THRESHOLD}
    ) pair
    GROUP BY pair.a, pair.b`;
}

/**
 * Empareja cada comunidad nueva con el linaje existente que mas se le parece
 * (Jaccard sobre ids de miembros), greedy de mayor a menor solapamiento y sin
 * repetir linaje. Devuelve, por indice de comunidad, el linaje o null.
 */
export function matchLineages(communities: string[][], existing: ClusterRow[]): (ClusterRow | null)[] {
  const pairs: { c: number; e: number; j: number }[] = [];
  communities.forEach((members, c) => {
    const set = new Set(members);
    existing.forEach((row, e) => {
      if (row.lastMemberIds.length === 0) return;
      let inter = 0;
      for (const id of row.lastMemberIds) if (set.has(id)) inter += 1;
      const union = set.size + row.lastMemberIds.length - inter;
      const j = union === 0 ? 0 : inter / union;
      if (j >= LINEAGE_JACCARD) pairs.push({ c, e, j });
    });
  });
  pairs.sort((a, b) => b.j - a.j);
  const result: (ClusterRow | null)[] = communities.map(() => null);
  const usedE = new Set<number>();
  for (const { c, e } of pairs) {
    if (result[c] || usedE.has(e)) continue;
    result[c] = existing[e];
    usedE.add(e);
  }
  return result;
}

/**
 * vitalidad(i) = max( propia(i), max_j propia(j)·score(i,j) ): una señal vieja
 * con vecinas recientes sigue viva; lo que muere es lo viejo sin continuidad.
 */
export function computeVitality(
  items: Item[],
  edges: GraphEdge[],
  clusterOfItem: Map<string, string>,
  now: Date,
): Map<string, number> {
  const own = new Map<string, number>();
  for (const item of items) {
    const days = Math.max(0, (now.getTime() - item.likedAt.getTime()) / 86_400_000);
    const halfLife = clusterOfItem.has(item.id) ? HALF_LIFE_DAYS : ORPHAN_HALF_LIFE_DAYS;
    own.set(item.id, Math.pow(0.5, days / halfLife));
  }
  const result = new Map(own);
  for (const edge of edges) {
    const a = own.get(edge.a);
    const b = own.get(edge.b);
    if (a === undefined || b === undefined) continue;
    result.set(edge.a, Math.max(result.get(edge.a)!, b * edge.score));
    result.set(edge.b, Math.max(result.get(edge.b)!, a * edge.score));
  }
  return result;
}

async function clusterStats(
  tx: TenantTx,
  ownerId: string,
  clusterId: string,
  members: string[],
  itemById: Map<string, Item>,
  edges: GraphEdge[],
  clusterOfItem: Map<string, string>,
  vitality: Map<string, number>,
  now: Date,
): Promise<ClusterStats> {
  const memberSet = new Set(members);
  const d30 = now.getTime() - 30 * 86_400_000;
  const d60 = now.getTime() - 60 * 86_400_000;
  let velocity30d = 0;
  let velocityPrev30d = 0;
  let lastSignalAt: Date | null = null;
  let sumVitality = 0;
  for (const id of members) {
    const item = itemById.get(id);
    if (!item) continue;
    const t = item.likedAt.getTime();
    if (t >= d30) velocity30d += 1;
    else if (t >= d60) velocityPrev30d += 1;
    if (!lastSignalAt || item.likedAt > lastSignalAt) lastSignalAt = item.likedAt;
    sumVitality += vitality.get(id) ?? 0;
  }

  let total = 0;
  let outgoing = 0;
  const bridges = new Set<string>();
  for (const edge of edges) {
    const aIn = memberSet.has(edge.a);
    const bIn = memberSet.has(edge.b);
    if (!aIn && !bIn) continue;
    total += 1;
    if (aIn && bIn) continue;
    outgoing += 1;
    const other = clusterOfItem.get(aIn ? edge.b : edge.a);
    if (other && other !== clusterId) bridges.add(other);
  }

  // Cohesion y novedad con pgvector: media de similitud de los miembros a su
  // centroide, y distancia del centroide del tema al centroide de TODO EL GRAFO
  // DEL TENANT (el "centroide global" de antes era el de la tabla entera, o sea
  // el de todos los usuarios juntos — el bug que arregla la tarea 3.9).
  const rows = await tx.$queryRaw<{ density: number | null; novelty: number | null }[]>`
    WITH c AS (
      SELECT avg(embedding) AS centroid FROM liked_items
      WHERE owner_id = ${ownerId} AND id = ANY(${members}::text[])
    ), g AS (
      SELECT avg(embedding) AS centroid FROM liked_items
      WHERE owner_id = ${ownerId} AND publish_status = 'published' AND embedding IS NOT NULL
    )
    SELECT
      (
        SELECT avg(1 - (i.embedding <=> c.centroid))
        FROM liked_items i, c
        WHERE i.owner_id = ${ownerId} AND i.id = ANY(${members}::text[])
      ) AS density,
      (SELECT c.centroid <=> g.centroid FROM c, g) AS novelty`;
  const row = rows[0] ?? { density: null, novelty: null };

  return {
    id: clusterId,
    members,
    size: members.length,
    vitality: sumVitality,
    lastSignalAt,
    velocity30d,
    velocityPrev30d,
    density: row.density === null ? null : Number(row.density),
    connectivity: total === 0 ? null : outgoing / total,
    novelty: row.novelty === null ? null : Number(row.novelty),
    bridgeClusters: bridges.size,
  };
}

/**
 * Heuristica v1 (PLANS/TOOLS4FORESIGHT_HORIZONTES_PLAN.md). Se sugiere a nivel
 * tema; el usuario confirma o corrige desde la pestaña Horizontes. Los cuantiles
 * salen de los temas vivos que se le pasan, que siempre son los de UN tenant.
 *   H1 ya esta pasando: grande, vivo y cerca del centro del grafo.
 *   H3 señal debil: chico, con poca vitalidad o lejos del resto.
 *   H2 transicion: lo demas.
 */
export function suggestHorizons(alive: ClusterStats[]): Map<string, HorizonKey> {
  const novelties = alive
    .map((s) => s.novelty)
    .filter((n): n is number => n !== null)
    .sort((a, b) => a - b);
  const median = quantile(novelties, 0.5);
  const p75 = quantile(novelties, 0.75);
  const result = new Map<string, HorizonKey>();
  for (const s of alive) {
    const nov = s.novelty ?? median ?? 0;
    if (s.size < 5 || s.vitality < 1.5 || (p75 !== null && nov > p75)) {
      result.set(s.id, "H3");
    } else if (s.size >= 8 && s.vitality >= 3 && (median === null || nov <= median)) {
      result.set(s.id, "H1");
    } else {
      result.set(s.id, "H2");
    }
  }
  return result;
}

function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
