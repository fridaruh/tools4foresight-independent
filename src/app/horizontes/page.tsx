import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/require-admin";
import { HorizontesBoard, type HorizonteCluster, type HorizontesPayload } from "@/components/HorizontesBoard";

export const dynamic = "force-dynamic";

// Pestaña 04 (admin y member): los temas del grafo leidos como tendencias — horizonte
// (H1/H2/H3) sugerido por la heuristica y corregible a mano, indicadores de
// seguimiento, temas muertos y exports CSV. Todo viene precalculado por
// refreshGraph (src/lib/jobs/graph.ts); esta pagina solo lee. Un member ve lo
// mismo que el admin salvo que no puede fijar horizontes ni ve avisos de jobs.
// Fuera del render por la regla del compilador de React (mismo patron que
// usuarios/page.tsx); con force-dynamic corre en cada request igual.
function historySince(): Date {
  return new Date(Date.now() - 90 * 86_400_000);
}

export default async function HorizontesPage() {
  const { role, hasAccess } = await getAccess();
  if (role === null) redirect("/login?from=%2Fhorizontes");
  // Member sin suscripcion vigente: a pagar (Fase 4), como en /senales.
  if (!hasAccess) redirect("/suscripcion");
  const canEdit = role === "admin";
  const since = historySince();

  const [clusters, snapshots, history, orphans, unembedded] = await Promise.all([
    prisma.semanticCluster.findMany({
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
      },
    }),
    prisma.graphSnapshot.findMany({
      orderBy: { takenAt: "desc" },
      take: 30,
      select: { id: true, takenAt: true, trigger: true, nodes: true, clustersAlive: true, clustersDead: true, orphans: true },
    }),
    // Ultimos 30 puntos por tema para la chispa de vitalidad.
    prisma.graphSnapshotCluster.findMany({
      where: { snapshot: { takenAt: { gte: since } } },
      orderBy: { snapshot: { takenAt: "asc" } },
      select: { clusterId: true, vitality: true, snapshot: { select: { takenAt: true } } },
    }),
    prisma.likedItem.count({ where: { publishStatus: "published", embeddedAt: { not: null }, clusterId: null } }),
    prisma.likedItem.count({ where: { publishStatus: "published", embeddedAt: null } }),
  ]);

  const series = new Map<string, { at: string; vitality: number }[]>();
  for (const row of history) {
    const list = series.get(row.clusterId) ?? [];
    list.push({ at: row.snapshot.takenAt.toISOString(), vitality: row.vitality });
    series.set(row.clusterId, list);
  }

  const payload: HorizontesPayload = {
    clusters: clusters.map(
      (c): HorizonteCluster => ({
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

  return (
    <div
      data-section={canEdit ? "horizontes" : "horizontes-member"}
      className="mx-auto flex w-full max-w-[90rem] flex-1 flex-col gap-8 px-4 py-8 sm:px-6 lg:px-10"
    >
      <HorizontesBoard payload={payload} canEdit={canEdit} />
    </div>
  );
}
