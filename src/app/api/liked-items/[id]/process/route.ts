import { NextRequest, NextResponse } from "next/server";
import { processSingleItem } from "@/lib/jobs/process-item";
import { requireUserApi } from "@/lib/require-user";

// Varias llamadas al modelo en cadena (categoria, PESTEL, TL;DR, impacto, por
// que importa) con 90 s de timeout cada una. El default de 10 s no alcanza ni
// para la primera.
export const maxDuration = 300;

/**
 * Corre la cadena completa sobre un solo item PROPIO. Lo usa el formulario de
 * enlaces manuales de la pantalla de enriquecimiento, y sirve tambien para
 * reprocesar a mano un item que quedo a medias.
 *
 * El owner sale de la sesion, nunca del body: `processSingleItem` filtra por
 * `(id, ownerId)` y devuelve "No encontrado" si el item es de otro tenant.
 */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUserApi();
  if (user instanceof NextResponse) return user;

  const { id } = await params;
  const result = await processSingleItem(user.userId, id);

  if (!result.ok) return NextResponse.json(result, { status: 404 });
  return NextResponse.json(result);
}
