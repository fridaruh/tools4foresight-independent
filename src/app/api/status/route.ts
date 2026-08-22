import { NextResponse } from "next/server";
import { requireUserApi } from "@/lib/require-user";
import { withOwner } from "@/lib/tenant-db";
import { isXCreditsDepleted } from "@/lib/platform-flags";

/**
 * `GET /api/status` — todo lo que `/conexion` necesita saber del tenant de la
 * sesión, en una sola llamada (PLAN §3.13, §4.2).
 *
 * Antes esto leía `findFirst()` sin owner: con una sola cuenta daba igual, con N
 * tenants devolvía el estado de un desconocido. Ahora todo va por
 * `withOwner(userId)` y lo único global que sale de aquí es
 * `xCreditsDepleted`, que efectivamente es de la plataforma: la X App es una y
 * la comparten todos (PLAN §0).
 */
export async function GET() {
  const user = await requireUserApi();
  if (user instanceof NextResponse) return user;

  const ownerId = user.userId;

  const [tenant, xCreditsDepleted] = await Promise.all([
    withOwner(ownerId, async (tx) => {
      const [token, cursor, quota, likedItemsCount, jobRuns] = await Promise.all([
        tx.xAuthToken.findFirst({
          where: { userId: ownerId },
          select: { xUserId: true, xUsername: true, createdAt: true },
        }),
        tx.ingestionCursor.findFirst({
          where: { userId: ownerId },
          select: {
            lastStatus: true,
            lastError: true,
            lastRunAt: true,
            retryAfter: true,
            backfillReachedWindow: true,
          },
        }),
        tx.userQuota.findFirst({ where: { userId: ownerId } }),
        tx.likedItem.count({ where: { ownerId } }),
        tx.jobRun.findMany({
          where: { ownerId },
          orderBy: { createdAt: "desc" },
          take: 6,
          select: {
            id: true,
            job: true,
            status: true,
            startedAt: true,
            finishedAt: true,
            processed: true,
            remaining: true,
            error: true,
          },
        }),
      ]);
      return { token, cursor, quota, likedItemsCount, jobRuns };
    }),
    isXCreditsDepleted(),
  ]);

  return NextResponse.json({
    xConnected: Boolean(tenant.token),
    xUserId: tenant.token?.xUserId ?? null,
    // Null en tokens conectados antes de que el callback empezara a guardar el
    // @handle (PLAN 4.2): la UI cae al xUserId numérico en ese caso.
    xUsername: tenant.token?.xUsername ?? null,
    xConnectedAt: tenant.token?.createdAt ?? null,

    cursor: {
      lastStatus: tenant.cursor?.lastStatus ?? "idle",
      lastError: tenant.cursor?.lastError ?? null,
      lastRunAt: tenant.cursor?.lastRunAt ?? null,
      retryAfter: tenant.cursor?.retryAfter ?? null,
      backfillReachedWindow: tenant.cursor?.backfillReachedWindow ?? false,
    },

    quota: tenant.quota
      ? {
          xPages: { used: tenant.quota.xPagesUsedToday, limit: tenant.quota.xPagesPerDay },
          analyzeItems: {
            used: tenant.quota.analyzeUsedToday,
            limit: tenant.quota.analyzeItemsPerDay,
          },
          windowResetAt: tenant.quota.windowResetAt,
        }
      : null,

    pipelineEnabled: tenant.quota?.pipelineEnabled ?? false,
    graphDirtyAt: tenant.quota?.graphDirtyAt ?? null,
    lastManualSyncAt: tenant.quota?.lastManualSyncAt ?? null,
    lastGraphRefreshAt: tenant.quota?.lastGraphRefreshAt ?? null,

    likedItemsCount: tenant.likedItemsCount,
    jobRuns: tenant.jobRuns,

    // Flag GLOBAL, no del tenant: la X App es compartida.
    xCreditsDepleted,
  });
}
