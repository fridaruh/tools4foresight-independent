import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const [cursor, connected, likedItemsCount] = await Promise.all([
    prisma.ingestionCursor.findFirst(),
    prisma.xAuthToken.findFirst({ select: { xUserId: true } }),
    prisma.likedItem.count(),
  ]);

  return NextResponse.json({
    xConnected: Boolean(connected),
    lastRunAt: cursor?.lastRunAt ?? null,
    lastStatus: cursor?.lastStatus ?? "idle",
    lastError: cursor?.lastError ?? null,
    likedItemsCount,
  });
}
