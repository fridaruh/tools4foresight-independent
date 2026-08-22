import { NextResponse } from "next/server";
import { resolveJobRequest } from "@/lib/cron-auth";
import { defaultBudgetMs, runJob } from "@/lib/jobs/runner";
import { JOB_NAMES, type JobName } from "@/lib/jobs/types";

// Es UNA ruta dinámica para los seis jobs, así que `maxDuration` tiene que ser
// el máximo de todos. Lo que de verdad corta cada job es su presupuesto
// (`defaultBudgetMs`, en runner.ts): ingest 100 s, fetch 50 s, el resto 240 s.
export const maxDuration = 300;

/**
 * `POST /api/jobs/<job>/run?owner=<userId>` — una corrida, un tenant.
 *
 * Dos formas de entrar (ver `resolveJobRequest`):
 *   - el dispatcher, con `Authorization: Bearer <CRON_SECRET>` y `?owner=`;
 *   - un usuario con sesión desde la UI, y entonces el owner ES el de su sesión
 *     (un `?owner=` ajeno se rechaza con 403).
 *
 * El HTTP 200/502 es sobre la corrida, no sobre la ruta: `ok: false` con 502
 * significa "el job falló", y el detalle ya quedó en `job_runs`.
 */
export async function POST(request: Request, { params }: { params: Promise<{ job: string }> }) {
  const { job } = await params;

  if (!(JOB_NAMES as readonly string[]).includes(job)) {
    return NextResponse.json(
      { ok: false, error: `Job desconocido: ${job}. Válidos: ${JOB_NAMES.join(", ")}` },
      { status: 404 },
    );
  }

  const auth = await resolveJobRequest(request);
  if (!auth.ok) return auth.response;

  const name = job as JobName;
  const result = await runJob(name, auth.ownerId, {
    trigger: auth.isCron ? "cron" : "manual",
    budgetMs: defaultBudgetMs(name),
  });

  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}

export async function GET(request: Request, ctx: { params: Promise<{ job: string }> }) {
  return POST(request, ctx);
}
