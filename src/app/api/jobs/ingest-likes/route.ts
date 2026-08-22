import { NextResponse } from "next/server";
import { ingestLikes } from "@/lib/jobs/ingest-likes";
import { resolveJobRequest } from "@/lib/cron-auth";

// Varias páginas de X por corrida (cupo de backfill hasta xBackfillPages) más
// el refresh de token si hace falta: el default de 10s de Vercel no alcanza.
export const maxDuration = 120;

export async function POST(request: Request) {
  const job = await resolveJobRequest(request);
  if (!job.ok) return job.response;
  const result = await ingestLikes(job.ownerId);
  // "disabled" (pipelineEnabled=false) no es un error: el tenant simplemente
  // no tiene la ingesta prendida. "ok" solo aparece cuando no hubo excepción
  // (incluye rate_limited / error_credits_depleted, que son resultados
  // manejados, no crashes).
  const isSuccess = "status" in result && result.status === "disabled" ? true : "ok" in result && result.ok;
  return NextResponse.json(result, { status: isSuccess ? 200 : 502 });
}

export async function GET(request: Request) {
  return POST(request);
}
