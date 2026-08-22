import { NextResponse } from "next/server";
import { embedPublished } from "@/lib/jobs/embed";
import { resolveJobRequest } from "@/lib/cron-auth";

export const maxDuration = 300;

// No esta en vercel.json: en produccion no hay Ollama al que llamarle (ver el
// comentario en src/lib/jobs/embed.ts). Se invoca local con `ollama serve`
// arriba: curl -X POST localhost:3000/api/jobs/embed -H "Authorization: Bearer $CRON_SECRET"
export async function POST(request: Request) {
  const job = await resolveJobRequest(request);
  if (!job.ok) return job.response;
  try {
    const summary = await embedPublished(job.ownerId);
    return NextResponse.json(summary, { status: summary.ok ? 200 : 502 });
  } catch (error) {
    return NextResponse.json({ ok: false, error: (error as Error).message }, { status: 500 });
  }
}

export async function GET(request: Request) {
  return POST(request);
}
