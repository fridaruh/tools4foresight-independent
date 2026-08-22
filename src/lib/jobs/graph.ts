import { prisma } from "@/lib/prisma";
import {
  MIN_CLUSTER_SIZE,
  detectCommunities,
  membersHash,
  nameCluster,
  type GraphEdge,
  type GraphNode,
} from "@/lib/jobs/clusters";

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

export type GraphTrigger = "embed" | "cron" | "publish" | "manual";
export type Horizon = "H1" | "H2" | "H3";

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

/**
 * Rehace TODO lo derivado del grafo semantico a partir de los embeddings que ya
 * existen: aristas → temas con linaje → vitalidad → indicadores → horizonte →
 * snapshot. No necesita Ollama local (no embebe nada); el bautizo de temas nuevos
 * o cambiados va al chat de ollama.com como siempre.
 *
 * Lo llaman el job de embeddings (local), el cron diario /api/jobs/graph (Vercel,
 * para que el decaimiento avance aunque nadie publique) y el PATCH que publica o
 * despublica una señal. Es idempotente: correrlo dos veces seguidas produce dos
 * snapshots iguales salvo la fecha.
 */
export async function refreshGraph(trigger: GraphTrigger) {
  const now = new Date();
  const links = await recomputeLinks();

  const [rawItems, rawLinks, existing] = await Promise.all([
    prisma.likedItem.findMany({
      where: { publishStatus: "published", embeddedAt: { not: null } },
      select: { id: true, contentTitle: true, tweetText: true, tldr: true, likedAt: true },
    }),
    prisma.semanticLink.findMany({
      where: { itemA: { publishStatus: "published" }, itemB: { publishStatus: "published" } },
      select: { itemAId: true, itemBId: true, score: true },
    }),
    prisma.semanticCluster.findMany({
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
    }),
  ]);

  const items: Item[] = rawItems.map((i) => ({
    id: i.id,
    title: i.contentTitle ?? i.tweetText.slice(0, 90),
    tldr: i.tldr,
    likedAt: i.likedAt,
  }));
  const itemById = new Map(items.map((i) => [i.id, i]));
  const edges: GraphEdge[] = rawLinks.map((l) => ({ a: l.itemAId, b: l.itemBId, score: l.score }));

  // 1. Comunidades de esta corrida.
  const communities = detectCommunities(
    items.map((i) => i.id),
    edges,
  ).filter((members) => members.length >= MIN_CLUSTER_SIZE);

  // 2. Emparejar con linajes existentes por solapamiento de miembros.
  const matches = matchLineages(communities, existing);

  // 3. Bautizo: solo temas nuevos o cuya membresia cambio.
  const errors: string[] = [];
  let named = 0;
  let reused = 0;
  const resolved: { clusterId: string; members: string[]; hash: string; existing: ClusterRow | null }[] = [];
  for (let i = 0; i < communities.length; i += 1) {
    const members = communities[i];
    const hash = membersHash(members);
    const prev = matches[i];
    if (prev && prev.membersHash === hash && prev.summary !== "") {
      reused += 1;
      resolved.push({ clusterId: prev.id, members, hash, existing: prev });
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
      title = prev ? { name: prev.name, summary: "" } : { name: `Tema de ${members.length} señales`, summary: "" };
    }
    if (prev) {
      await prisma.semanticCluster.update({
        where: { id: prev.id },
        data: { name: title.name, summary: title.summary },
      });
      resolved.push({ clusterId: prev.id, members, hash, existing: prev });
    } else {
      const created = await prisma.semanticCluster.create({
        data: { name: title.name, summary: title.summary, membersHash: hash, size: members.length },
      });
      resolved.push({ clusterId: created.id, members, hash, existing: null });
    }
  }

  // 4. Vitalidad por señal.
  const clusterOfItem = new Map<string, string>();
  for (const r of resolved) for (const id of r.members) clusterOfItem.set(id, r.clusterId);
  const vitality = computeVitality(items, edges, clusterOfItem, now);

  // 5. Indicadores por tema.
  const stats: ClusterStats[] = [];
  for (const r of resolved) {
    stats.push(await clusterStats(r.clusterId, r.members, itemById, edges, clusterOfItem, vitality, now));
  }

  // 6. Horizonte sugerido (sobre los temas vivos de esta corrida).
  const suggested = suggestHorizons(stats.filter((s) => s.vitality >= DEAD_THRESHOLD));

  // 7. Escribir temas (detectados y no detectados), señales y snapshot.
  const resolvedIds = new Set(resolved.map((r) => r.clusterId));
  const orphanIds = items.filter((i) => !clusterOfItem.has(i.id)).map((i) => i.id);
  const clusterUpdates: { id: string; data: Parameters<typeof prisma.semanticCluster.update>[0]["data"] }[] = [];
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

  const vitIds = items.map((i) => i.id);
  const vitVals = vitIds.map((id) => vitality.get(id) ?? 0);

  const snapshot = await prisma.$transaction(async (tx) => {
    await tx.likedItem.updateMany({ data: { clusterId: null }, where: { clusterId: { not: null } } });
    for (const r of resolved) {
      await tx.likedItem.updateMany({ data: { clusterId: r.clusterId }, where: { id: { in: r.members } } });
    }
    // Vitalidad de todas las señales del grafo en un solo UPDATE.
    await tx.$executeRaw`
      UPDATE liked_items AS i
      SET vitality = v.vit, vitality_at = ${now}
      FROM unnest(${vitIds}::text[], ${vitVals}::float8[]) AS v(id, vit)
      WHERE i.id = v.id`;
    for (const u of clusterUpdates) await tx.semanticCluster.update({ where: { id: u.id }, data: u.data });

    const snap = await tx.graphSnapshot.create({
      data: {
        takenAt: now,
        trigger,
        nodes: items.length,
        links,
        clustersAlive: alive,
        clustersDead: dead,
        orphans: orphanIds.length,
      },
    });
    // El nombre vacio marca "tomalo del tema" (se acaba de bautizar en esta corrida).
    const names = new Map(
      (await tx.semanticCluster.findMany({ select: { id: true, name: true } })).map((c) => [c.id, c.name]),
    );
    await tx.graphSnapshotCluster.createMany({
      data: snapshotClusters.map((c) => ({
        ...c,
        snapshotId: snap.id,
        name: c.name || (names.get(c.clusterId) ?? ""),
      })),
    });
    await tx.graphSnapshotMember.createMany({
      data: items.map((i) => ({
        snapshotId: snap.id,
        itemId: i.id,
        clusterId: clusterOfItem.get(i.id) ?? null,
        vitality: vitality.get(i.id) ?? 0,
      })),
    });
    return snap;
  }, { timeout: 120_000, maxWait: 10_000 });

  return {
    ok: errors.length === 0,
    trigger,
    snapshotId: snapshot.id,
    nodes: items.length,
    links,
    clusters: resolved.length,
    named,
    reused,
    alive,
    dead,
    died,
    revived,
    orphans: orphanIds.length,
    ...(errors.length > 0 ? { clusterErrors: errors.slice(0, 3) } : {}),
  };
}

/** Rehace semantic_links: por cada señal publicada con embedding, sus LINK_TOP_K
 *  vecinas mas cercanas por coseno, cortadas en LINK_THRESHOLD. El par va
 *  ordenado (LEAST/GREATEST) y el GROUP BY deduplica A→B y B→A. Completo, no por
 *  item: con cientos de señales el pairwise en Postgres es instantaneo y evita el
 *  bug sutil de borrar por item los enlaces que otro item habia creado. */
export async function recomputeLinks(): Promise<number> {
  const [, inserted] = await prisma.$transaction([
    prisma.$executeRaw`DELETE FROM semantic_links`,
    prisma.$executeRaw`
      INSERT INTO semantic_links (id, item_a_id, item_b_id, score)
      SELECT gen_random_uuid()::text, pair.a, pair.b, MAX(pair.score)
      FROM (
        SELECT LEAST(src.id, n.id) AS a, GREATEST(src.id, n.id) AS b, n.score
        FROM liked_items src
        CROSS JOIN LATERAL (
          SELECT other.id, 1 - (other.embedding <=> src.embedding) AS score
          FROM liked_items other
          WHERE other.id <> src.id
            AND other.embedding IS NOT NULL
            AND other.publish_status = 'published'
          ORDER BY other.embedding <=> src.embedding
          LIMIT ${LINK_TOP_K}
        ) n
        WHERE src.embedding IS NOT NULL
          AND src.publish_status = 'published'
          AND n.score >= ${LINK_THRESHOLD}
      ) pair
      GROUP BY pair.a, pair.b`,
  ]);
  return inserted;
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
  // centroide, y distancia del centroide del tema al centroide de todo el grafo.
  const rows = await prisma.$queryRaw<{ density: number | null; novelty: number | null }[]>`
    WITH c AS (
      SELECT avg(embedding) AS centroid FROM liked_items WHERE id = ANY(${members}::text[])
    ), g AS (
      SELECT avg(embedding) AS centroid FROM liked_items
      WHERE publish_status = 'published' AND embedding IS NOT NULL
    )
    SELECT
      (SELECT avg(1 - (i.embedding <=> c.centroid)) FROM liked_items i, c WHERE i.id = ANY(${members}::text[])) AS density,
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
 * tema; Frida confirma o corrige desde la pestaña Horizontes.
 *   H1 ya esta pasando: grande, vivo y cerca del centro del grafo.
 *   H3 señal debil: chico, con poca vitalidad o lejos del resto.
 *   H2 transicion: lo demas.
 */
export function suggestHorizons(alive: ClusterStats[]): Map<string, Horizon> {
  const novelties = alive.map((s) => s.novelty).filter((n): n is number => n !== null).sort((a, b) => a - b);
  const median = quantile(novelties, 0.5);
  const p75 = quantile(novelties, 0.75);
  const result = new Map<string, Horizon>();
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
