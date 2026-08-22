import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { fetchContentMetadata } from "@/lib/content-fetch";
import { requireAdminApi } from "@/lib/require-admin";

// Reintento manual del fetch de contenido (PLAN fase 4). El job automatico no
// reintenta indefinidamente los que fallan, asi que este es el escape para los
// links que fallaron por algo temporal (rate limit, sitio caido).
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await requireAdminApi();
  if (denied) return denied;

  const { id } = await params;
  const item = await prisma.likedItem.findUnique({
    where: { id },
    select: { id: true, contentUrl: true },
  });

  if (!item) return NextResponse.json({ error: "No encontrado" }, { status: 404 });
  if (!item.contentUrl) {
    return NextResponse.json({ error: "Este item no tiene link externo" }, { status: 400 });
  }

  try {
    const content = await fetchContentMetadata(item.contentUrl);
    const updated = await prisma.likedItem.update({
      where: { id },
      data: {
        contentTitle: content.title,
        contentDescription: content.description,
        contentImageUrl: content.imageUrl,
        contentPublishedAt: content.publishedAt,
        fetchedAt: new Date(),
        fetchStatus: "success",
      },
    });
    return NextResponse.json({ ok: true, item: updated });
  } catch (error) {
    await prisma.likedItem.update({
      where: { id },
      data: { fetchedAt: new Date(), fetchStatus: "failed" },
    });
    return NextResponse.json(
      { ok: false, error: (error as Error).message },
      { status: 502 },
    );
  }
}
