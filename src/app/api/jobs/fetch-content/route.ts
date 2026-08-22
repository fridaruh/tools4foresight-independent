import { NextResponse } from "next/server";
import { fetchPendingContent } from "@/lib/jobs/fetch-content";
import { isJobRequestAuthorized, unauthorizedJobResponse } from "@/lib/cron-auth";

export const maxDuration = 60;

export async function POST(request: Request) {
  if (!(await isJobRequestAuthorized(request))) {
    return unauthorizedJobResponse(request);
  }
  try {
    const summary = await fetchPendingContent();
    return NextResponse.json(summary);
  } catch (error) {
    return NextResponse.json({ ok: false, error: (error as Error).message }, { status: 500 });
  }
}

export async function GET(request: Request) {
  return POST(request);
}
