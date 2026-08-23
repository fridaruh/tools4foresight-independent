import { requireUserPage } from "@/lib/require-user";
import { withOwner } from "@/lib/tenant-db";
import { HorizontesBoard, type HorizonteCluster, type HorizontesPayload } from "@/components/HorizontesBoard";
import { MacroHorizonBoard, type MacroTheme } from "@/components/MacroHorizonBoard";
import { isHorizon, type HorizonKey } from "@/lib/horizons";

export const dynamic = "force-dynamic";

function historySince(): Date {
  return new Date(Date.now() - 90 * 86_400_000);
}

export default async function HorizontesPage() {
  const { userId } = await requireUserPage();
  const since = historySince();

  const [clusters, macroClusters, snapshots, history, orphans, unembedded] = await withOwner(userId, async (tx) => {
    return Promise.all([
      tx.semanticCluster.findMany({
        orderBy: [{ vitality: "desc" }, { name: "asc" }],
        select: {
          id: true,
          name: true,
          summary: true,
          size: true,
          status: true,
          vitality: true,
          horizon: true,
          horizonSuggested: true,
          horizonSource: true,
          velocity30d: true,
          velocityPrev30d: true,
          density: true,
          connectivity: true,
          bridgeClusters: true,
          novelty: true,
          firstSeenAt: true,
          lastSignalAt: true,
          diedAt: true,
          revivedCount: true,
          macroClusterId: true,
        },
      }),
      tx.macroCluster.findMany({
        select: { id: true, name: true, summary: true, horizon: true },
      }),
      tx.graphSnapshot.findMany({
        orderBy: { takenAt: "desc" },
        take: 30,
        select: { id: true, takenAt: true, trigger: true, nodes: true, clustersAlive: true, clustersDead: true, orphans: true },
      }),
      // Ultimos 30 puntos por tema para la chispa de vitalidad.
      tx.graphSnapshotCluster.findMany({
        where: { snapshot: { takenAt: { gte: since } } },
        orderBy: { snapshot: { takenAt: "asc" } },
        select: { clusterId: true, vitality: true, snapshot: { select: { takenAt: true } } },
      }),
      tx.likedItem.count({ where: { publishStatus: "published", embeddedAt: { not: null }, clusterId: null } }),
      tx.likedItem.count({ where: { publishStatus: "published", embeddedAt: null } }),
    ]);
  });

  const series = new Map<string, { at: string; vitality: number }[]>();
  for (const row of history) {
    const list = series.get(row.clusterId) ?? [];
    list.push({ at: row.snapshot.takenAt.toISOString(), vitality: row.vitality });
    series.set(row.clusterId, list);
  }

  const payload: HorizontesPayload = {
    clusters: clusters.map(
      ({ macroClusterId: _macroClusterId, ...c }): HorizonteCluster => ({
        ...c,
        firstSeenAt: c.firstSeenAt.toISOString(),
        lastSignalAt: c.lastSignalAt?.toISOString() ?? null,
        diedAt: c.diedAt?.toISOString() ?? null,
        series: series.get(c.id) ?? [],
      }),
    ),
    snapshots: snapshots.map((s) => ({ ...s, takenAt: s.takenAt.toISOString() })),
    orphans,
    unembedded,
  };

  // Macro-temas: agregado (señales, cuántos temas finos agrupa) por macro-tema,
  // sumando los `SemanticCluster` vivos que lo referencian.
  const macroAgg = new Map<string, { size: number; count: number }>();
  for (const c of clusters) {
    if (!c.macroClusterId) continue;
    const agg = macroAgg.get(c.macroClusterId) ?? { size: 0, count: 0 };
    agg.size += c.size;
    agg.count += 1;
    macroAgg.set(c.macroClusterId, agg);
  }
  const macroThemes: MacroTheme[] = macroClusters.filter((m) => isHorizon(m.horizon)).map((m) => {
    const agg = macroAgg.get(m.id) ?? { size: 0, count: 0 };
    return {
      id: m.id,
      name: m.name,
      summary: m.summary,
      horizon: m.horizon as HorizonKey,
      size: agg.size,
      clusterCount: agg.count,
    };
  });

  return (
    <div
      data-section="horizontes"
      className="mx-auto flex w-full max-w-[90rem] flex-1 flex-col gap-8 px-4 py-8 sm:px-6 lg:px-10"
    >
      <MacroHorizonBoard themes={macroThemes} />
      <HorizontesBoard payload={payload} canEdit={true} />
    </div>
  );
}
