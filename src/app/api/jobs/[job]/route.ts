import { NextResponse } from "next/server";
import { dispatch, resolveBaseUrl } from "@/lib/jobs/dispatcher";
import { isCronRequest } from "@/lib/cron-auth";
import { JOB_NAMES, type JobName } from "@/lib/jobs/types";

// El dispatcher no hace trabajo: enumera tenants y lanza el fan-out con
// waitUntil. Los 60 s son para que la función siga viva mientras las llamadas
// salen, no para esperar a que terminen (cada `…/run` tiene sus propios 300).
export const maxDuration = 60;

/**
 * `POST /api/jobs/<job>` — la puerta del cron (PLAN §3.11).
 *
 * Un cron de `vercel.json` por etapa pega aquí. Esta ruta NO corre el job:
 * resuelve qué tenants califican y le pega a `/api/jobs/<job>/run?owner=…` una
 * vez por cada uno.
 *
 * Solo acepta `Authorization: Bearer <CRON_SECRET>`, y a propósito no acepta
 * sesión de usuario: despachar es una acción sobre TODOS los tenants. El botón
 * manual de la UI va a `…/run`, que sí acepta sesión y solo puede correr lo
 * suyo.
 */
export async function POST(request: Request, { params }: { params: Promise<{ job: string }> }) {
  const { job } = await params;

  if (!(JOB_NAMES as readonly string[]).includes(job)) {
    return NextResponse.json(
      { ok: false, error: `Job desconocido: ${job}. Válidos: ${JOB_NAMES.join(", ")}` },
      { status: 404 },
    );
  }

  if (!isCronRequest(request)) {
    return NextResponse.json({ ok: false, error: "No autorizado" }, { status: 401 });
  }

  try {
    const result = await dispatch(job as JobName, resolveBaseUrl(request));
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json({ ok: false, error: (error as Error).message }, { status: 500 });
  }
}

// Los crons de Vercel usan GET.
export async function GET(request: Request, ctx: { params: Promise<{ job: string }> }) {
  return POST(request, ctx);
}
