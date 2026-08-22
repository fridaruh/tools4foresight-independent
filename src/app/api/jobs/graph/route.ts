import { NextResponse } from "next/server";
import { refreshGraph } from "@/lib/jobs/graph";
import { resolveJobRequest } from "@/lib/cron-auth";

export const maxDuration = 300;

// Cron diario (vercel.json): rehace aristas, temas, vitalidad, indicadores,
// horizontes y toma un snapshot. A diferencia de /api/jobs/embed, SI corre en
// Vercel porque no embebe nada — solo usa los embeddings que ya existen. Asi el
// decaimiento de las señales avanza un dia cada dia, aunque nadie publique.
export async function POST(request: Request) {
  const job = await resolveJobRequest(request);
  if (!job.ok) return job.response;
  try {
    const summary = await refreshGraph(job.ownerId, job.isCron ? "cron" : "manual");
    return NextResponse.json(summary, { status: summary.ok ? 200 : 502 });
  } catch (error) {
    return NextResponse.json({ ok: false, error: (error as Error).message }, { status: 500 });
  }
}

export async function GET(request: Request) {
  return POST(request);
}
