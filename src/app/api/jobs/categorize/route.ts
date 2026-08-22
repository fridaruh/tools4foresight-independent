import { NextResponse } from "next/server";
import { categorizePending } from "@/lib/jobs/categorize";
import { classifyPestelPending } from "@/lib/jobs/pestel";
import { isJobRequestAuthorized, unauthorizedJobResponse } from "@/lib/cron-auth";

export const maxDuration = 300;

const SAFETY_MARGIN_MS = 30_000;

export async function POST(request: Request) {
  if (!(await isJobRequestAuthorized(request))) {
    return await unauthorizedJobResponse(request);
  }

  const startedAt = Date.now();

  try {
    const categorization = await categorizePending();

    // PESTEL corre en el mismo endpoint que la categoría (mismo cron, mismo botón
    // manual): con lo que sobre de los 300s, sobre una ventana mucho más chica
    // (últimas 2 semanas), así que casi nunca compite de verdad por tiempo.
    const remainingMs = 300_000 - (Date.now() - startedAt) - SAFETY_MARGIN_MS;
    let pestel;
    try {
      pestel =
        remainingMs > 0
          ? await classifyPestelPending(remainingMs)
          : { ok: false as const, error: "No quedó tiempo en esta corrida para PESTEL." };
    } catch (error) {
      pestel = { ok: false as const, error: (error as Error).message };
    }

    return NextResponse.json(
      { ...categorization, pestel },
      { status: categorization.ok ? 200 : 502 },
    );
  } catch (error) {
    return NextResponse.json({ ok: false, error: (error as Error).message }, { status: 500 });
  }
}

export async function GET(request: Request) {
  return POST(request);
}
