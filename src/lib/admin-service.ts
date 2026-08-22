/**
 * Lógica del panel `/admin` (PLAN Fase 5, tarea 5.1), extraída de la página y de
 * las routes para poder probarla sin HTTP (ver scripts/qa-admin.ts) y para que
 * ninguna de las dos reimplemente las mismas queries.
 *
 * Todas las funciones reciben `tx` (un `TenantTx`, ver src/lib/tenant-db.ts): el
 * caller es responsable de abrir la transacción — siempre con
 * `withPlatformBypass`, nunca con `withOwner`, porque leer "todos los tenants" es
 * por definición cross-tenant (es uno de los tres usos legítimos que documenta
 * tenant-db.ts).
 *
 * Sin N+1: la vista de tenants sale de un puñado de queries agregadas
 * (`groupBy` sobre `liked_items` y `usage_events`, `findMany` con `distinct`
 * sobre `job_runs`) más UNA lectura de `users`, nunca una consulta por tenant.
 */
import type { TenantTx } from "@/lib/tenant-db";

export class AdminServiceError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "AdminServiceError";
    this.status = status;
  }
}

/** Cuánto para atrás cuenta "actividad reciente" / "uso reciente". */
const ACTIVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const USAGE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export type TenantUsageBreakdown = {
  /** UsageEvent kind=x_page: páginas de X leídas en los últimos 30 días. */
  xPageCalls: number;
  /** UsageEvent kind=ollama_call: llamadas a Ollama (categorizar/PESTEL/analizar). */
  ollamaCalls: number;
  /** UsageEvent kind=anthropic_call: foresight, BYOK. */
  anthropic: { calls: number; tokensIn: number; tokensOut: number };
  /** UsageEvent kind=openai_embed: embeddings del grafo. */
  openaiEmbed: { calls: number; tokensIn: number; tokensOut: number };
};

export type TenantLastJobRun = {
  job: string;
  status: string;
  at: Date;
} | null;

export type AdminTenantRow = {
  userId: string;
  name: string;
  email: string;
  role: string;
  createdAt: Date;
  xConnected: boolean;
  xUsername: string | null;
  itemsTotal: number;
  itemsPublished: number;
  lastJobRun: TenantLastJobRun;
  pipelineEnabled: boolean;
  quota: {
    xPagesPerDay: number;
    xBackfillPages: number;
    xBackfillMonths: number;
    analyzeItemsPerDay: number;
  } | null;
  usage30d: TenantUsageBreakdown;
};

export type AdminTotals = {
  tenants: number;
  /** Tenants con al menos un JobRun status=ok en los últimos 7 días. */
  active7d: number;
  /** Suma de UsageEvent kind=x_page, units, de hoy (00:00 UTC en adelante). */
  xPagesToday: number;
  /** Suma de tokens (in+out) de UsageEvent kind=anthropic_call, últimos 30 días. */
  anthropicTokens30d: number;
  /** Suma de tokens (in+out) de UsageEvent kind=openai_embed, últimos 30 días. */
  openaiTokens30d: number;
};

export type AdminOverview = {
  totals: AdminTotals;
  tenants: AdminTenantRow[];
};

function emptyUsage(): TenantUsageBreakdown {
  return {
    xPageCalls: 0,
    ollamaCalls: 0,
    anthropic: { calls: 0, tokensIn: 0, tokensOut: 0 },
    openaiEmbed: { calls: 0, tokensIn: 0, tokensOut: 0 },
  };
}

function todayStartUtc(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * Todo lo que pinta `/admin`: la lista de tenants con su uso agregado y los
 * totales de cabecera. Una sola pasada de queries agregadas — nada por tenant.
 */
export async function getAdminOverview(tx: TenantTx): Promise<AdminOverview> {
  const now = new Date();
  const activeCutoff = new Date(now.getTime() - ACTIVE_WINDOW_MS);
  const usageCutoff = new Date(now.getTime() - USAGE_WINDOW_MS);
  const todayStart = todayStartUtc();

  const [
    users,
    itemCounts,
    publishedCounts,
    lastJobRuns,
    activeOwners,
    usage30d,
    xPagesTodayAgg,
  ] = await Promise.all([
    tx.user.findMany({
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        createdAt: true,
        xAuthToken: { select: { xUsername: true } },
        quota: {
          select: {
            xPagesPerDay: true,
            xBackfillPages: true,
            xBackfillMonths: true,
            analyzeItemsPerDay: true,
            pipelineEnabled: true,
          },
        },
      },
    }),
    tx.likedItem.groupBy({ by: ["ownerId"], _count: { _all: true } }),
    tx.likedItem.groupBy({
      by: ["ownerId"],
      where: { publishStatus: "published" },
      _count: { _all: true },
    }),
    // Un `findMany` con `distinct` sobre `ownerId`, ordenado por `startedAt`
    // desc, devuelve la primera fila que ve por owner en ese orden: el JobRun
    // más reciente de cada tenant, sin una query por tenant.
    tx.jobRun.findMany({
      distinct: ["ownerId"],
      orderBy: [{ startedAt: "desc" }, { createdAt: "desc" }],
      select: { ownerId: true, job: true, status: true, startedAt: true, createdAt: true },
    }),
    tx.jobRun.findMany({
      where: { status: "ok", startedAt: { gte: activeCutoff } },
      distinct: ["ownerId"],
      select: { ownerId: true },
    }),
    tx.usageEvent.groupBy({
      by: ["userId", "kind"],
      where: { createdAt: { gte: usageCutoff } },
      _count: { _all: true },
      _sum: { tokensIn: true, tokensOut: true },
    }),
    tx.usageEvent.aggregate({
      where: { kind: "x_page", createdAt: { gte: todayStart } },
      _sum: { units: true },
    }),
  ]);

  const itemsByOwner = new Map(itemCounts.map((r) => [r.ownerId, r._count._all]));
  const publishedByOwner = new Map(publishedCounts.map((r) => [r.ownerId, r._count._all]));
  const lastJobRunByOwner = new Map(
    lastJobRuns.map((r) => [r.ownerId, { job: r.job, status: r.status, at: r.startedAt ?? r.createdAt }]),
  );
  const activeOwnerIds = new Set(activeOwners.map((r) => r.ownerId));

  const usageByOwner = new Map<string, TenantUsageBreakdown>();
  let anthropicTokens30d = 0;
  let openaiTokens30d = 0;
  for (const row of usage30d) {
    const usage = usageByOwner.get(row.userId) ?? emptyUsage();
    const count = row._count._all;
    const tokensIn = row._sum.tokensIn ?? 0;
    const tokensOut = row._sum.tokensOut ?? 0;

    if (row.kind === "x_page") usage.xPageCalls += count;
    else if (row.kind === "ollama_call") usage.ollamaCalls += count;
    else if (row.kind === "anthropic_call") {
      usage.anthropic.calls += count;
      usage.anthropic.tokensIn += tokensIn;
      usage.anthropic.tokensOut += tokensOut;
      anthropicTokens30d += tokensIn + tokensOut;
    } else if (row.kind === "openai_embed") {
      usage.openaiEmbed.calls += count;
      usage.openaiEmbed.tokensIn += tokensIn;
      usage.openaiEmbed.tokensOut += tokensOut;
      openaiTokens30d += tokensIn + tokensOut;
    }
    usageByOwner.set(row.userId, usage);
  }

  const tenants: AdminTenantRow[] = users.map((u) => ({
    userId: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    createdAt: u.createdAt,
    xConnected: u.xAuthToken !== null,
    xUsername: u.xAuthToken?.xUsername ?? null,
    itemsTotal: itemsByOwner.get(u.id) ?? 0,
    itemsPublished: publishedByOwner.get(u.id) ?? 0,
    lastJobRun: lastJobRunByOwner.get(u.id) ?? null,
    pipelineEnabled: u.quota?.pipelineEnabled ?? false,
    quota: u.quota
      ? {
          xPagesPerDay: u.quota.xPagesPerDay,
          xBackfillPages: u.quota.xBackfillPages,
          xBackfillMonths: u.quota.xBackfillMonths,
          analyzeItemsPerDay: u.quota.analyzeItemsPerDay,
        }
      : null,
    usage30d: usageByOwner.get(u.id) ?? emptyUsage(),
  }));

  const totals: AdminTotals = {
    tenants: users.length,
    active7d: activeOwnerIds.size,
    xPagesToday: xPagesTodayAgg._sum.units ?? 0,
    anthropicTokens30d,
    openaiTokens30d,
  };

  return { totals, tenants };
}

export type TenantQuotaPatch = Partial<{
  xPagesPerDay: number;
  xBackfillPages: number;
  xBackfillMonths: number;
  analyzeItemsPerDay: number;
  pipelineEnabled: boolean;
}>;

function isFiniteNonNegativeInt(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && Number.isInteger(n) && n >= 0;
}

/** Valida el body de `PATCH /api/admin/tenants/[id]` y descarta lo que no cuadra. */
export function parseTenantQuotaPatch(body: unknown): TenantQuotaPatch {
  const b = (body ?? {}) as Record<string, unknown>;
  const patch: TenantQuotaPatch = {};

  if (b.xPagesPerDay !== undefined) {
    if (!isFiniteNonNegativeInt(b.xPagesPerDay)) {
      throw new AdminServiceError("xPagesPerDay debe ser un entero ≥ 0", 400);
    }
    patch.xPagesPerDay = b.xPagesPerDay;
  }
  if (b.xBackfillPages !== undefined) {
    if (!isFiniteNonNegativeInt(b.xBackfillPages)) {
      throw new AdminServiceError("xBackfillPages debe ser un entero ≥ 0", 400);
    }
    patch.xBackfillPages = b.xBackfillPages;
  }
  if (b.xBackfillMonths !== undefined) {
    if (!isFiniteNonNegativeInt(b.xBackfillMonths)) {
      throw new AdminServiceError("xBackfillMonths debe ser un entero ≥ 0", 400);
    }
    patch.xBackfillMonths = b.xBackfillMonths;
  }
  if (b.analyzeItemsPerDay !== undefined) {
    if (!isFiniteNonNegativeInt(b.analyzeItemsPerDay)) {
      throw new AdminServiceError("analyzeItemsPerDay debe ser un entero ≥ 0", 400);
    }
    patch.analyzeItemsPerDay = b.analyzeItemsPerDay;
  }
  if (b.pipelineEnabled !== undefined) {
    if (typeof b.pipelineEnabled !== "boolean") {
      throw new AdminServiceError("pipelineEnabled debe ser boolean", 400);
    }
    patch.pipelineEnabled = b.pipelineEnabled;
  }

  if (Object.keys(patch).length === 0) {
    throw new AdminServiceError("Nada que actualizar", 400);
  }

  return patch;
}

/**
 * Edita la `UserQuota` de un tenant desde el panel de plataforma. 404 si el
 * tenant no existe o todavía no tiene fila de cuota (no debería pasar:
 * `seedTenant` la crea al alta, pero una cuenta sembrada a mano podría no
 * tenerla).
 */
export async function updateTenantQuota(
  tx: TenantTx,
  userId: string,
  patch: TenantQuotaPatch,
): Promise<AdminTenantRow["quota"] & { pipelineEnabled: boolean }> {
  const updated = await tx.userQuota.updateMany({ where: { userId }, data: patch });
  if (updated.count === 0) {
    throw new AdminServiceError("No hay cuota para este tenant", 404);
  }
  const quota = await tx.userQuota.findUnique({ where: { userId } });
  if (!quota) throw new AdminServiceError("No hay cuota para este tenant", 404);

  return {
    xPagesPerDay: quota.xPagesPerDay,
    xBackfillPages: quota.xBackfillPages,
    xBackfillMonths: quota.xBackfillMonths,
    analyzeItemsPerDay: quota.analyzeItemsPerDay,
    pipelineEnabled: quota.pipelineEnabled,
  };
}
