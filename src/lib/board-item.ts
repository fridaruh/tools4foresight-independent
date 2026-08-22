import type { LikedItem } from "@/generated/prisma/client";

/**
 * Forma de un item tal como lo consumen los componentes de cliente.
 *
 * No se pasa el registro de Prisma tal cual: `categoryConfidence` es un `Decimal`
 * (una clase, no un objeto plano) y React no lo puede serializar de un Server
 * Component a un Client Component. Ademas los items que llegan por `fetch` traen
 * las fechas como string ISO, asi que aqui se usa ese mismo formato en las dos
 * rutas y los componentes no tienen que adivinar cual les toco.
 */
export type BoardItem = {
  id: string;
  /** 'x_like' | 'manual' — ver el comentario de `source` en schema.prisma. */
  source: string;
  tweetId: string;
  authorHandle: string;
  authorName: string | null;
  tweetText: string;
  tweetUrl: string;
  mediaUrls: string[];
  tweetCreatedAt: string | null;
  likedAt: string;
  likedAtSource: string;
  contentUrl: string | null;
  contentTitle: string | null;
  contentDescription: string | null;
  contentImageUrl: string | null;
  contentPublishedAt: string | null;
  fetchedAt: string | null;
  fetchStatus: string;
  category: string | null;
  categorySource: string;
  categoryReasoning: string | null;
  // Textos de analisis, para el preview del catalogo. El popup los muestra; las
  // tarjetas y filas no, asi que la lista no se encarece visualmente.
  tldr: string | null;
  impact: string | null;
  whyMatters: string | null;
};

/** Un enlace que Frida pego a mano, no un like traido de X. */
export function isManualItem(item: { source: string }): boolean {
  return item.source === "manual";
}

/**
 * En un like el "autor" es una cuenta de X y lleva arroba; en un enlace manual es el
 * dominio del sitio, donde el arroba se leeria como un handle que no existe.
 */
export function authorLabel(item: Pick<BoardItem, "source" | "authorHandle">): string {
  return isManualItem(item) ? item.authorHandle : `@${item.authorHandle}`;
}

export function toBoardItem(item: LikedItem): BoardItem {
  return {
    id: item.id,
    source: item.source,
    tweetId: item.tweetId,
    authorHandle: item.authorHandle,
    authorName: item.authorName,
    tweetText: item.tweetText,
    tweetUrl: item.tweetUrl,
    mediaUrls: item.mediaUrls,
    tweetCreatedAt: item.tweetCreatedAt?.toISOString() ?? null,
    likedAt: item.likedAt.toISOString(),
    likedAtSource: item.likedAtSource,
    contentUrl: item.contentUrl,
    contentTitle: item.contentTitle,
    contentDescription: item.contentDescription,
    contentImageUrl: item.contentImageUrl,
    contentPublishedAt: item.contentPublishedAt?.toISOString() ?? null,
    fetchedAt: item.fetchedAt?.toISOString() ?? null,
    fetchStatus: item.fetchStatus,
    category: item.category,
    categorySource: item.categorySource,
    categoryReasoning: item.categoryReasoning,
    tldr: item.tldr,
    impact: item.impact,
    whyMatters: item.whyMatters,
  };
}
