// Job de fetch de contenido (PLAN 3.3): trae título/descripción del enlace de cada
// like, por tenant.
//
// Patrón obligatorio (ver src/lib/jobs/types.ts y tenant-db.ts): leer el lote dentro
// de un `withOwner` corto, hacer las llamadas de red FUERA de cualquier transacción
// (un fetch a un dominio ajeno puede tardar hasta FETCH_TIMEOUT_MS = 8s cada uno, y
// con 15 en paralelo eso es más de lo que el pooler de Neon tolera con una tx
// abierta), y escribir el resultado en otro `withOwner` corto al final.
import { fetchContentMetadata, type FetchedContent } from "@/lib/content-fetch";
import { withOwner } from "@/lib/tenant-db";
import { budgetExceeded, type JobFn, type JobResult } from "@/lib/jobs/types";

const MAX_ITEMS_PER_RUN = 15;

/** Máximo de fetches en vuelo al mismo host a la vez (PLAN 3.3): no golpear un mismo dominio. */
const MAX_CONCURRENT_PER_HOST = 3;

type PendingItem = { id: string; contentUrl: string | null };

type FetchOutcome =
  | { id: string; status: "not_applicable" }
  | { id: string; status: "success"; data: FetchedContent }
  | { id: string; status: "failed" };

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid-url";
  }
}

async function fetchOne(item: PendingItem): Promise<FetchOutcome> {
  if (!item.contentUrl) return { id: item.id, status: "not_applicable" };
  try {
    const data = await fetchContentMetadata(item.contentUrl);
    return { id: item.id, status: "success", data };
  } catch {
    return { id: item.id, status: "failed" };
  }
}

/**
 * Corre `fetchOne` sobre todos los items a la vez, pero nunca deja más de
 * `MAX_CONCURRENT_PER_HOST` peticiones en vuelo hacia el mismo host. Dominios
 * distintos no se bloquean entre sí.
 */
async function fetchAllWithHostLimit(items: PendingItem[]): Promise<FetchOutcome[]> {
  const active = new Map<string, number>();
  const waiting = new Map<string, Array<() => void>>();

  function acquire(host: string): Promise<void> {
    const count = active.get(host) ?? 0;
    if (count < MAX_CONCURRENT_PER_HOST) {
      active.set(host, count + 1);
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const queue = waiting.get(host) ?? [];
      queue.push(resolve);
      waiting.set(host, queue);
    });
  }

  function release(host: string): void {
    const queue = waiting.get(host);
    if (queue && queue.length > 0) {
      const next = queue.shift();
      next?.(); // el que espera hereda el cupo, no se decrementa `active`
      return;
    }
    active.set(host, Math.max(0, (active.get(host) ?? 1) - 1));
  }

  return Promise.all(
    items.map(async (item) => {
      if (!item.contentUrl) return fetchOne(item);
      const host = hostOf(item.contentUrl);
      await acquire(host);
      try {
        return await fetchOne(item);
      } finally {
        release(host);
      }
    }),
  );
}

export const runFetch: JobFn = async (ctx) => {
  const pending = await withOwner(ctx.ownerId, (tx) =>
    tx.likedItem.findMany({
      where: { ownerId: ctx.ownerId, fetchStatus: "pending" },
      select: { id: true, contentUrl: true },
      take: MAX_ITEMS_PER_RUN,
    }),
  );

  if (pending.length === 0) {
    return { ok: true, processed: 0, remaining: 0, stoppedOnBudget: false };
  }

  if (budgetExceeded(ctx)) {
    return { ok: true, processed: 0, remaining: pending.length, stoppedOnBudget: true };
  }

  const outcomes = await fetchAllWithHostLimit(pending);

  await withOwner(ctx.ownerId, (tx) =>
    Promise.all(
      outcomes.map((outcome) => {
        if (outcome.status === "not_applicable") {
          return tx.likedItem.updateMany({
            where: { id: outcome.id, ownerId: ctx.ownerId },
            data: { fetchStatus: "not_applicable", fetchedAt: new Date() },
          });
        }
        if (outcome.status === "success") {
          return tx.likedItem.updateMany({
            where: { id: outcome.id, ownerId: ctx.ownerId },
            data: {
              contentTitle: outcome.data.title,
              contentDescription: outcome.data.description,
              contentImageUrl: outcome.data.imageUrl,
              contentPublishedAt: outcome.data.publishedAt,
              fetchedAt: new Date(),
              fetchStatus: "success",
            },
          });
        }
        return tx.likedItem.updateMany({
          where: { id: outcome.id, ownerId: ctx.ownerId },
          data: { fetchedAt: new Date(), fetchStatus: "failed" },
        });
      }),
    ),
  );

  const remaining = await withOwner(ctx.ownerId, (tx) =>
    tx.likedItem.count({ where: { ownerId: ctx.ownerId, fetchStatus: "pending" } }),
  );

  const success = outcomes.filter((o) => o.status === "success").length;
  const notApplicable = outcomes.filter((o) => o.status === "not_applicable").length;
  const failed = outcomes.length - success - notApplicable;

  const result: JobResult = {
    ok: true,
    processed: outcomes.length,
    remaining,
    stoppedOnBudget: false,
    details: { success, failed, notApplicable },
  };
  return result;
};

/**
 * @deprecated Reemplazado por `runFetch` (JobFn por tenant, PLAN 3.3). Este wrapper
 * solo existe para que las rutas que todavía no migraron sigan compilando mientras
 * se actualizan; llamarlo es un error de programación, no un fallback válido — no
 * hay forma segura de "traer contenido pendiente de todos los tenants a la vez" sin
 * romper el aislamiento por owner_id.
 */
export async function fetchPendingContent(): Promise<never> {
  throw new Error(
    "fetchPendingContent() esta deprecado: usa runFetch(ctx) por tenant (ver src/lib/jobs/types.ts).",
  );
}
