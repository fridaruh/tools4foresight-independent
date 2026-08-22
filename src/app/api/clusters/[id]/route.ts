import { NextRequest, NextResponse } from "next/server";
import { requireUserApi } from "@/lib/require-user";
import { withOwner } from "@/lib/tenant-db";
import { isHorizon } from "@/lib/horizons";

type Body = {
  /** H1 | H2 | H3 fija el horizonte a mano; null vuelve a la sugerencia automatica. */
  horizon?: string | null;
};

// Mismo patron que categorySource: fijar a mano congela el valor y el job deja
// de pisarlo; mandar null devuelve el control a la heuristica.
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUserApi();
  if (user instanceof NextResponse) return user;

  const { id } = await params;
  const body = (await request.json()) as Body;
  if (!("horizon" in body)) return NextResponse.json({ error: "Nada que actualizar" }, { status: 400 });
  if (body.horizon !== null && !isHorizon(body.horizon)) {
    return NextResponse.json({ error: "horizon inválido" }, { status: 400 });
  }

  const result = await withOwner(user.userId, async (tx) => {
    const existing = await tx.semanticCluster.findFirst({
      where: { id, ownerId: user.userId },
      select: { horizonSuggested: true },
    });
    if (!existing) return null;

    await tx.semanticCluster.updateMany({
      where: { id, ownerId: user.userId },
      data:
        body.horizon === null
          ? { horizon: existing.horizonSuggested, horizonSource: "auto" }
          : { horizon: body.horizon, horizonSource: "manual" },
    });

    // Obtener el cluster actualizado
    return tx.semanticCluster.findFirst({
      where: { id, ownerId: user.userId },
      select: { id: true, horizon: true, horizonSuggested: true, horizonSource: true },
    });
  });

  if (!result) return NextResponse.json({ error: "No encontrado" }, { status: 404 });
  return NextResponse.json({ cluster: result });
}
