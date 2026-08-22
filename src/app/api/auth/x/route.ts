import { NextResponse } from "next/server";
import { requireUserApi } from "@/lib/require-user";
import { withOwner } from "@/lib/tenant-db";

/**
 * DELETE /api/auth/x
 *
 * Desconecta la cuenta de X del usuario. Borra el token de autenticación pero
 * NO borra los liked_items ya ingestados (para que no pierda el trabajo hecho).
 */
export async function DELETE(request: Request) {
  const userOrResponse = await requireUserApi();
  if (userOrResponse instanceof NextResponse) {
    return userOrResponse;
  }

  const { userId } = userOrResponse;

  try {
    await withOwner(userId, async (tx) => {
      await tx.xAuthToken.deleteMany({
        where: { userId },
      });
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: (error as Error).message },
      { status: 500 },
    );
  }
}
