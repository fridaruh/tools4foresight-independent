import { NextResponse } from "next/server";
import { ingestLikes } from "@/lib/jobs/ingest-likes";
import { fetchPendingContent } from "@/lib/jobs/fetch-content";
import { categorizePending } from "@/lib/jobs/categorize";
import { analyzePending } from "@/lib/jobs/analyze";
import { requireAdminApi } from "@/lib/require-admin";

export const maxDuration = 300;

/** Margen que se le deja a la funcion para responder antes de que Vercel la corte. */
const SAFETY_MARGIN_MS = 30_000;

// Un solo endpoint para el boton de sync manual de la UI: corre ingesta + fetch
// de contenido + categorizacion en la misma llamada, para no exponer 3 botones
// al usuario final.
export async function POST() {
  const denied = await requireAdminApi();
  if (denied) return denied;

  const startedAt = Date.now();
  const ingestion = await ingestLikes();
  const content = await fetchPendingContent();

  const budgetLeft = () => 300_000 - (Date.now() - startedAt) - SAFETY_MARGIN_MS;

  // La categorizacion se lleva el tiempo que sobre de los 300s, no su presupuesto
  // completo: aqui ya corrieron la ingesta y el fetch de contenido antes.
  //
  // Depende ademas de una API key que puede no estar configurada; que falte no debe
  // romper el sync de likes, que es lo principal del boton.
  let categorization;
  try {
    const remainingMs = budgetLeft();
    categorization =
      remainingMs > 0
        ? await categorizePending(remainingMs)
        : { ok: false as const, error: "No quedó tiempo en esta corrida para categorizar." };
  } catch (error) {
    categorization = { ok: false as const, error: (error as Error).message };
  }

  // El analisis va al final porque es el mas caro (dos llamadas al modelo por item) y
  // el unico que es incremental por diseño: lo que no alcance en esta corrida lo
  // levanta el cron o el boton de la pantalla de enriquecimiento.
  let analysis;
  try {
    const remainingMs = budgetLeft();
    analysis =
      remainingMs > 0
        ? await analyzePending(remainingMs)
        : { ok: false as const, error: "No quedó tiempo en esta corrida para analizar." };
  } catch (error) {
    analysis = { ok: false as const, error: (error as Error).message };
  }

  return NextResponse.json({ ingestion, content, categorization, analysis });
}
