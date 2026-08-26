/**
 * #4 `GET /api/public/v1/signals/{id}` — ficha completa de una señal del banco.
 *
 * Un id que no existe EN EL BANCO DE QUIEN PREGUNTA devuelve 404, nunca 403.
 * En el origen (single-tenant) esa regla evitaba confirmar que había contenido
 * sin publicar detrás del id, frente a un lector ajeno al acervo. Aquí no hay
 * lectores ajenos ni estado "sin publicar" oculto (el dueño ve su banco entero),
 * pero el mismo 404 sigue siendo obligatorio por una razón distinta: un 403
 * confirmaría que el id SÍ existe, solo que en el banco de OTRO tenant —y eso es
 * exactamente el tipo de fuga entre bancos que `ownerId` en la lista negra de
 * public-dto.ts existe para evitar. El 404 no distingue "no existe" de "es de
 * otro tenant", y esa indistinción es la garantía.
 */
import type { NextRequest } from "next/server";
import { withOwner } from "@/lib/tenant-db";
import { PublicApiError } from "@/lib/public-api-auth";
import { handleOptions, ok, withPublicApi } from "@/lib/public-api-response";
import { SIGNAL_DETAIL_SELECT, toSignalDetail } from "@/lib/public-dto";

export const runtime = "nodejs";

const NOT_FOUND = "No existe una señal con ese id en tu banco.";

async function handler(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
  { ownerId }: { ownerId: string; keyId: string },
) {
  // Next 16: `params` es una Promise.
  const { id } = await ctx.params;

  // Búsqueda de la señal y conteo de vecinos en la misma transacción: es lectura
  // pura (sin LLM/HTTP de por medio, CLAUDE.md §2) y el segundo query depende de
  // que el primero haya confirmado que la señal es de este tenant.
  const result = await withOwner(ownerId, async (tx) => {
    const item = await tx.likedItem.findFirst({
      where: { id },
      select: SIGNAL_DETAIL_SELECT,
    });
    if (!item) return null;

    // Vecinos: aristas de `semantic_links` con un extremo en esta señal. El job
    // de grafo solo las crea entre señales publicadas (ver public-dto.ts), y el
    // otro extremo ya quedó acotado a este tenant por RLS —a diferencia del
    // origen, aquí no hace falta volver a exigir "publicado" en el `where`: no
    // hay lector ajeno al que ocultarle un vecino sin publicar.
    const neighborCount = await tx.semanticLink.count({
      where: { OR: [{ itemAId: id }, { itemBId: id }] },
    });

    return { item, neighborCount };
  });

  if (!result) {
    throw new PublicApiError("not_found", NOT_FOUND, 404);
  }

  return ok(toSignalDetail(result.item, result.neighborCount), { cache: "short", request });
}

export const GET = withPublicApi(handler);

export function OPTIONS(request: Request) {
  return handleOptions(request);
}
