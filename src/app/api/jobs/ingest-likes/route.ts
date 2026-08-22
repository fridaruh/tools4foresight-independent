import { NextResponse } from "next/server";
import { ingestLikes } from "@/lib/jobs/ingest-likes";
import { isJobRequestAuthorized, unauthorizedJobResponse } from "@/lib/cron-auth";

export async function POST(request: Request) {
  if (!(await isJobRequestAuthorized(request))) {
    return unauthorizedJobResponse(request);
  }
  const result = await ingestLikes();
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}

export async function GET(request: Request) {
  return POST(request);
}
