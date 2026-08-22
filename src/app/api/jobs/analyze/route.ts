import { NextResponse } from "next/server";
import { analyzePending } from "@/lib/jobs/analyze";
import { isJobRequestAuthorized, unauthorizedJobResponse } from "@/lib/cron-auth";

export const maxDuration = 300;

export async function POST(request: Request) {
  if (!(await isJobRequestAuthorized(request))) {
    return await unauthorizedJobResponse(request);
  }
  try {
    const summary = await analyzePending();
    return NextResponse.json(summary, { status: summary.ok ? 200 : 502 });
  } catch (error) {
    return NextResponse.json({ ok: false, error: (error as Error).message }, { status: 500 });
  }
}

export async function GET(request: Request) {
  return POST(request);
}
