import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdminApi } from "@/lib/require-admin";
import { isHorizon } from "@/lib/horizons";

type Body = {
  /** H1 | H2 | H3 fija el horizonte a mano; null vuelve a la sugerencia automatica. */
  horizon?: string | null;
};

// Mismo patron que categorySource: fijar a mano congela el valor y el job deja
// de pisarlo; mandar null devuelve el control a la heuristica.
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireAdminApi();
  if (denied) return denied;

  const { id } = await params;
  const body = (await request.json()) as Body;
  if (!("horizon" in body)) return NextResponse.json({ error: "Nada que actualizar" }, { status: 400 });
  if (body.horizon !== null && !isHorizon(body.horizon)) {
    return NextResponse.json({ error: "horizon inválido" }, { status: 400 });
  }

  const existing = await prisma.semanticCluster.findUnique({
    where: { id },
    select: { horizonSuggested: true },
  });
  if (!existing) return NextResponse.json({ error: "No encontrado" }, { status: 404 });

  const cluster = await prisma.semanticCluster.update({
    where: { id },
    data:
      body.horizon === null
        ? { horizon: existing.horizonSuggested, horizonSource: "auto" }
        : { horizon: body.horizon, horizonSource: "manual" },
    select: { id: true, horizon: true, horizonSuggested: true, horizonSource: true },
  });
  return NextResponse.json({ cluster });
}
