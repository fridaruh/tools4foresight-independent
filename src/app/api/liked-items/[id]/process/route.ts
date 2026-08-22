import { NextRequest, NextResponse } from "next/server";
import { processSingleItem } from "@/lib/jobs/process-item";
import { requireAdminApi } from "@/lib/require-admin";

// Tres llamadas al modelo (categoria + impacto + por que importa) con 90s de timeout
// cada una. El default de 10s no alcanza ni para la primera.
export const maxDuration = 300;

/**
 * Corre la cadena completa sobre un solo item. Lo usa el formulario de enlaces
 * manuales de la pantalla de enriquecimiento, y sirve tambien para reprocesar a mano
 * un item que quedo a medias.
 */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireAdminApi();
  if (denied) return denied;

  const { id } = await params;
  const result = await processSingleItem(id);

  if (!result.ok) return NextResponse.json(result, { status: 404 });
  return NextResponse.json(result);
}
