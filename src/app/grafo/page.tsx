import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { getAccess } from "@/lib/require-admin";
import { SemanticGraph, type GraphPayload } from "@/components/SemanticGraph";

export const dynamic = "force-dynamic";

// Pestaña 03 (admin y member): el mapa de enlaces semanticos entre señales
// publicadas. Los nodos, aristas y temas ya viven precalculados en Postgres (los
// escribe el job de embeddings, src/lib/jobs/embed.ts); esta pagina solo los lee,
// asi que abrir el grafo no llama a ningun modelo. Un member ve el mismo grafo
// que el admin; solo se le ocultan los avisos internos de jobs (sin embeber).
export default async function GrafoPage() {
  const { role, hasAccess } = await getAccess();
  if (role === null) redirect("/login?from=%2Fgrafo");
  // Member sin suscripcion vigente: a pagar (Fase 4), como en /senales.
  if (!hasAccess) redirect("/suscripcion");
  const isAdmin = role === "admin";

  const [items, links, clusters, unembedded] = await Promise.all([
    // Solo publicadas (decision de Frida, 2026-08-19): el grafo es sobre la vista
    // curada que ve un miembro, no sobre el catalogo crudo.
    prisma.likedItem.findMany({
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
    prisma.semanticLink.findMany({
      where: { itemA: { publishStatus: "published" }, itemB: { publishStatus: "published" } },
      select: { itemAId: true, itemBId: true, score: true },
    }),
    // De mayor a menor: el orden asigna la paleta de colores (el tema mas grande
    // recibe el primer color) y ordena la leyenda.
    // Los vivos primero; los muertos van al final de la leyenda, en gris.
    prisma.semanticCluster.findMany({
      orderBy: [{ status: "asc" }, { size: "desc" }, { name: "asc" }],
      select: { id: true, name: true, summary: true, size: true, status: true },
    }),
    prisma.likedItem.count({ where: { publishStatus: "published", embeddedAt: null } }),
  ]);

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
    // El conteo de "sin embeber" es una instruccion operativa (correr el job):
    // solo tiene sentido para el admin.
    unembedded: isAdmin ? unembedded : 0,
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
