/**
 * #7 `GET /api/public/v1/themes/{id}` — detalle de un tema con sus indicadores.
 *
 * `memberIds` sale de `lastMemberIds` y no de la relación `items`: cuando un tema
 * muere, sus señales pierden el `clusterId` que le apuntaba, así que consultar la
 * relación devolvería vacío para todo fósil. `lastMemberIds` conserva la última
 * membresía conocida — es lo que permite que un tema muerto siga siendo legible.
 *
 * Un id que no existe EN EL BANCO DE QUIEN PREGUNTA devuelve 404, nunca 403. En el
 * origen (single-tenant) esa regla evitaba confirmar que había contenido sin
 * publicar detrás del id, frente a un lector ajeno al acervo. Aquí no hay lectores
 * ajenos ni "sin publicar" oculto (el dueño ve su banco entero, PLAN_MCP §0.2),
 * pero el mismo 404 sigue siendo obligatorio por una razón distinta: un 403
 * confirmaría que el id SÍ existe, solo que en el banco de OTRO tenant — y esa es
 * exactamente la fuga entre bancos que la lista negra de `ownerId` en
 * public-dto.ts existe para evitar. El 404 no distingue "no existe" de "es de
 * otro tenant", y esa indistinción es la garantía.
 */
import type { NextRequest } from "next/server";
import { withOwner } from "@/lib/tenant-db";
import { PublicApiError } from "@/lib/public-api-auth";
import { handleOptions, ok, withPublicApi } from "@/lib/public-api-response";
import { THEME_DETAIL_SELECT, toThemeDetail } from "@/lib/public-dto";

// Prisma con @prisma/adapter-pg no corre en edge. Obligatorio en toda la API pública.
export const runtime = "nodejs";

const NOT_FOUND = "No existe un tema con ese id en tu banco.";

async function handler(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
  { ownerId }: { ownerId: string; keyId: string },
) {
  // Next 16: `params` es una Promise.
  const { id } = await ctx.params;

  // Cluster y su membresía vigente en la misma transacción: el segundo query
  // depende de que el primero haya confirmado que el tema es de este tenant, y es
  // lectura pura (sin LLM/HTTP de por medio, CLAUDE.md §2).
  const result = await withOwner(ownerId, async (tx) => {
    const cluster = await tx.semanticCluster.findFirst({
      where: { id },
      select: THEME_DETAIL_SELECT,
    });
    if (!cluster) return null;

    // `lastMemberIds` es la membresía de la ÚLTIMA corrida del grafo: puede
    // quedar desfasada si una señal se borró entre corridas. En el origen este
    // campo se cruzaba contra `publishStatus` (una señal despublicada seguía
    // listada ahí, y `/signals/{id}` respondía 404 con ella). Aquí no hay tal
    // cruce: el banco entero es visible para su dueño, así que cualquier id de
    // `lastMemberIds` que siga existiendo resuelve. `existingMemberIds` cubre
    // solo el caso "la señal se borró entre corridas", no el de publicación.
    const existing = await tx.likedItem.findMany({
      where: { id: { in: cluster.lastMemberIds } },
      select: { id: true },
    });

    return { cluster, existingMemberIds: existing.map((row) => row.id) };
  });

  if (!result) {
    throw new PublicApiError("not_found", NOT_FOUND, 404);
  }

  return ok(toThemeDetail(result.cluster, result.existingMemberIds), { cache: "graph", request });
}

export const GET = withPublicApi(handler);

export function OPTIONS(request: Request) {
  return handleOptions(request);
}
