import { NextResponse } from "next/server";
import { requireUserApi } from "@/lib/require-user";
import { claimCooldown, runJob } from "@/lib/jobs/runner";

// Dos jobs de 120 s más el margen para responder.
export const maxDuration = 300;

/** 10 min entre recálculos manuales del grafo (PLAN §3.10). */
const COOLDOWN_MS = 10 * 60 * 1000;

/** Presupuesto de cada etapa. 120 + 120 = 240, deja 60 s de margen. */
const STAGE_BUDGET_MS = 120_000;

/**
 * `POST /api/jobs/graph/now` — "Recalcular mi grafo ahora" (PLAN §3.10).
 *
 * Publicar deja de disparar `refreshGraph` en un `after()`: ahora solo marca
 * `graphDirtyAt` y el cron nocturno lo levanta. Este endpoint es el escape para
 * quien no quiere esperar a mañana.
 *
 * Corre `embed` antes que `graph` a propósito: lo que se acaba de publicar
 * todavía no tiene vector, y sin vector no entra al grafo. Si el embed falla
 * (sin OPENAI_API_KEY, por ejemplo) igual se corre el grafo — la vitalidad y
 * los temas de lo que YA estaba embebido se actualizan de todos modos.
 *
 * Solo sesión: no acepta CRON_SECRET porque no es un job de plataforma, es un
 * botón. El cron equivalente es `POST /api/jobs/graph` (dispatcher).
 */
export async function POST() {
  const user = await requireUserApi();
  if (user instanceof NextResponse) return user;

  const cooldown = await claimCooldown(user.userId, "lastGraphRefreshAt", COOLDOWN_MS);
  if (!cooldown.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: `El grafo se recalculó hace poco. Puedes volver a intentarlo en ${Math.ceil(cooldown.waitSeconds / 60)} min.`,
        retryAt: cooldown.retryAt,
      },
      { status: 429 },
    );
  }

  const embed = await runJob("embed", user.userId, {
    trigger: "manual",
    budgetMs: STAGE_BUDGET_MS,
  });

  const graph = await runJob("graph", user.userId, {
    trigger: "manual",
    budgetMs: STAGE_BUDGET_MS,
  });

  return NextResponse.json({ ok: graph.ok, embed, graph }, { status: graph.ok ? 200 : 502 });
}
