import { requireUserPage } from "@/lib/require-user";
import { withOwner } from "@/lib/tenant-db";
import { SemanticGraph, type GraphPayload } from "@/components/SemanticGraph";

export const dynamic = "force-dynamic";

export default async function GrafoPage() {
  const { userId } = await requireUserPage();

  const [items, links, clusters, unembedded] = await withOwner(userId, async (tx) => {
    return Promise.all([
      // Solo publicadas (decision de Frida, 2026-08-19): el grafo es sobre la vista
      // curada que ve un miembro, no sobre el catalogo crudo.
      tx.likedItem.findMany({
        where: { publishStatus: "published", embeddedAt: { not: null } },
        select: {
          id: true,
          contentTitle: true,
          tweetText: true,
          category: true,
          tldr: true,
          clusterId: true,
          vitality: true,
        },
      }),
      // El filtro por estado de ambos extremos cubre la ventana entre despublicar
      // una señal y el siguiente recalculo de aristas.
      tx.semanticLink.findMany({
        where: { itemA: { publishStatus: "published" }, itemB: { publishStatus: "published" } },
        select: { itemAId: true, itemBId: true, score: true },
      }),
      // De mayor a menor: el orden asigna la paleta de colores (el tema mas grande
      // recibe el primer color) y ordena la leyenda.
      // Los vivos primero; los muertos van al final de la leyenda, en gris.
      tx.semanticCluster.findMany({
        orderBy: [{ status: "asc" }, { size: "desc" }, { name: "asc" }],
        select: { id: true, name: true, summary: true, size: true, status: true },
      }),
      tx.likedItem.count({ where: { publishStatus: "published", embeddedAt: null } }),
    ]);
  });

  const payload: GraphPayload = {
    nodes: items.map((item) => ({
      id: item.id,
      label: item.contentTitle ?? item.tweetText.slice(0, 90),
      category: item.category,
      tldr: item.tldr,
      clusterId: item.clusterId,
      vitality: item.vitality,
    })),
    links: links.map((link) => ({ source: link.itemAId, target: link.itemBId, score: link.score })),
    clusters,
    // Cada usuario es dueño de su grafo y puede ver el conteo operativo.
    unembedded,
  };

  return (
    <div
      data-section="grafo"
      className="mx-auto flex w-full max-w-[100rem] flex-1 flex-col gap-4 px-4 py-6 sm:px-6 lg:px-10"
    >
      <SemanticGraph payload={payload} />
    </div>
  );
}
