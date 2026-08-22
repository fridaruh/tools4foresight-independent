import { prisma } from "@/lib/prisma";
import { fetchContentMetadata } from "@/lib/content-fetch";

const MAX_ITEMS_PER_RUN = 15; // concurrente, para no pasarnos del tiempo de ejecucion de la funcion

async function processItem(item: { id: string; contentUrl: string | null }) {
  if (!item.contentUrl) {
    await prisma.likedItem.update({
      where: { id: item.id },
      data: { fetchStatus: "not_applicable", fetchedAt: new Date() },
    });
    return "not_applicable" as const;
  }

  try {
    const content = await fetchContentMetadata(item.contentUrl);
    await prisma.likedItem.update({
      where: { id: item.id },
      data: {
        contentTitle: content.title,
        contentDescription: content.description,
        contentImageUrl: content.imageUrl,
        contentPublishedAt: content.publishedAt,
        fetchedAt: new Date(),
        fetchStatus: "success",
      },
    });
    return "success" as const;
  } catch {
    await prisma.likedItem.update({
      where: { id: item.id },
      data: { fetchedAt: new Date(), fetchStatus: "failed" },
    });
    return "failed" as const;
  }
}

export async function fetchPendingContent() {
  const pending = await prisma.likedItem.findMany({
    where: { fetchStatus: "pending" },
    select: { id: true, contentUrl: true },
    take: MAX_ITEMS_PER_RUN,
  });

  const results = await Promise.all(pending.map(processItem));
  const success = results.filter((r) => r === "success").length;
  const notApplicable = results.filter((r) => r === "not_applicable").length;
  const failed = results.length - success - notApplicable;

  return {
    ok: true as const,
    processed: results.length,
    success,
    failed,
    notApplicable,
    remainingAtLeast: pending.length === MAX_ITEMS_PER_RUN,
  };
}
