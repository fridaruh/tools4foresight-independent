import { NextRequest, NextResponse } from "next/server";
import { requireUserApi } from "@/lib/require-user";
import { withOwner } from "@/lib/tenant-db";

/**
 * `PATCH /api/settings/pipeline` — enciende/apaga `user_quotas.pipeline_enabled`
 * (PLAN 4.2). El dispatcher de crons (Fase 3) solo enumera tenants con el flag en
 * `true`; en `false` el usuario sigue pudiendo correr todo a mano desde los
 * botones, pero el cron nocturno lo salta.
 */
export async function PATCH(request: NextRequest) {
  const user = await requireUserApi();
  if (user instanceof NextResponse) return user;

  const body = (await request.json().catch(() => null)) as { pipelineEnabled?: boolean } | null;
  if (typeof body?.pipelineEnabled !== "boolean") {
    return NextResponse.json({ ok: false, error: "Falta pipelineEnabled" }, { status: 400 });
  }

  const updated = await withOwner(user.userId, (tx) =>
    tx.userQuota.updateMany({
      where: { userId: user.userId },
      data: { pipelineEnabled: body.pipelineEnabled },
    }),
  );

  if (updated.count === 0) {
    return NextResponse.json({ ok: false, error: "No hay cuota para este usuario" }, { status: 404 });
  }

  return NextResponse.json({ ok: true, pipelineEnabled: body.pipelineEnabled });
}
