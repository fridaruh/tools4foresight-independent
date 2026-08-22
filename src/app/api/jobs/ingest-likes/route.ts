import { NextResponse } from "next/server";
import { ingestLikes } from "@/lib/jobs/ingest-likes";
import { resolveJobRequest } from "@/lib/cron-auth";

export async function POST(request: Request) {
  const job = await resolveJobRequest(request);
  if (!job.ok) return job.response;
  const result = await ingestLikes(job.ownerId);
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}

export async function GET(request: Request) {
  return POST(request);
}
