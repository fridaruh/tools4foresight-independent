import { NextRequest, NextResponse } from "next/server";
import { fetchContentMetadata } from "@/lib/content-fetch";
import { requireUserApi } from "@/lib/require-user";
import { withOwner } from "@/lib/tenant-db";

// Un solo fetch HTTP con timeout corto, pero un sitio lento puede pasarse de
// los 10 s por default.
export const maxDuration = 60;

/**
 * Reintento manual del fetch de contenido sobre un item PROPIO.
 *
 * El job automatico no reintenta indefinidamente los que fallan, asi que este es
 * el escape para los links que fallaron por algo temporal (rate limit, sitio
 * caido). Como el PATCH: si el id es de otro tenant, 404.
 *
 * La lectura y las escrituras van en transacciones separadas a proposito: el
 * fetch de red que va en medio puede tardar segundos y no tiene por que tener
 * una transaccion abierta esperandolo (PLAN §7.4).
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUserApi();
  if (user instanceof NextResponse) return user;

  const ownerId = user.userId;
  const { id } = await params;

  const item = await withOwner(ownerId, (tx) =>
    tx.likedItem.findFirst({
      where: { id, ownerId },
      select: { id: true, contentUrl: true },
    }),
  );

  if (!item) return NextResponse.json({ error: "No encontrado" }, { status: 404 });
  if (!item.contentUrl) {
    return NextResponse.json({ error: "Este item no tiene link externo" }, { status: 400 });
  }

  try {
    const content = await fetchContentMetadata(item.contentUrl);
    const updated = await withOwner(ownerId, async (tx) => {
      await tx.likedItem.updateMany({
        where: { id, ownerId },
        data: {
          contentTitle: content.title,
          contentDescription: content.description,
          contentImageUrl: content.imageUrl,
          contentPublishedAt: content.publishedAt,
          fetchedAt: new Date(),
          fetchStatus: "success",
        },
      });
      return tx.likedItem.findFirst({ where: { id, ownerId } });
    });
    return NextResponse.json({ ok: true, item: updated });
  } catch (error) {
    await withOwner(ownerId, (tx) =>
      tx.likedItem.updateMany({
        where: { id, ownerId },
        data: { fetchedAt: new Date(), fetchStatus: "failed" },
      }),
    );
    return NextResponse.json({ ok: false, error: (error as Error).message }, { status: 502 });
  }
}
