/**
 * GET /api/public/v1/snapshots/{id} — una corrida del grafo del tenant, con el
 * estado de sus temas en ese momento.
 *
 * Caché `static` (3600s) e INMUTABLE: un snapshot es una foto del pasado, nunca
 * cambia una vez tomada. Es el único endpoint de la API pública que puede
 * cachearse una hora entera sin riesgo de servir un dato viejo como si fuera
 * fresco — lo viejo es exactamente lo que se pidió.
 *
 * `includeMembers=true` añade la membresía señal→tema de esa corrida — puede ser
 * de miles de filas, así que el endpoint ENTERO va con el bucket de rate limit
 * reducido (`expensive: true`): la decisión de rate limit se toma antes de mirar
 * los query params, así que no hay forma de aplicarla solo cuando se pide el modo
 * caro.
 *
 * Un id que no exista EN EL BANCO DE QUIEN PREGUNTA responde 404, nunca 403: un
 * 403 confirmaría que el snapshot existe en el banco de OTRO tenant, la misma
 * fuga que la lista negra de `ownerId` en public-dto.ts existe para evitar. El
 * `findFirst({ where: { id, ownerId } })` de abajo hace que "no existe" y "es de
 * otro tenant" sean indistinguibles desde afuera.
 */
import type { NextRequest } from "next/server";
import { withOwner } from "@/lib/tenant-db";
import { PublicApiError } from "@/lib/public-api-auth";
import { handleOptions, ok, withPublicApi } from "@/lib/public-api-response";
import {
  SNAPSHOT_MEMBER_SELECT,
  SNAPSHOT_SUMMARY_SELECT,
  SNAPSHOT_THEME_ROW_SELECT,
  toSnapshotMember,
  toSnapshotSummary,
  toSnapshotThemeRow,
} from "@/lib/public-dto";

export const runtime = "nodejs";

const NOT_FOUND = "No existe un snapshot con ese id en tu banco.";

// Cap duro: pedir la membresía completa de una corrida grande no puede tumbar la
// respuesta. Si se corta, `meta.truncated` lo dice — nunca en silencio.
const MEMBERS_CAP = 5000;

async function handler(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
  { ownerId }: { ownerId: string; keyId: string },
) {
  // Next 16: `params` es una Promise.
  const { id } = await ctx.params;

  const rawInclude = request.nextUrl.searchParams.get("includeMembers");
  if (rawInclude !== null && rawInclude !== "" && rawInclude !== "true" && rawInclude !== "false") {
    throw new PublicApiError(
      "invalid_parameter",
      'El parámetro "includeMembers" debe ser true o false.',
      400,
      "includeMembers",
    );
  }
  const includeMembers = rawInclude === "true";

  // Todo en la misma `withOwner`: lectura pura, sin LLM/HTTP de por medio
  // (CLAUDE.md §2). El `tx` es un cliente pelado, así que `ownerId` se repite a
  // mano en cada `where` como segunda barrera además de RLS (igual que
  // `public-horizons.ts`).
  const result = await withOwner(ownerId, async (tx) => {
    const snapshot = await tx.graphSnapshot.findFirst({
      where: { id, ownerId },
      select: SNAPSHOT_SUMMARY_SELECT,
    });
    if (!snapshot) return null;

    const themes = await tx.graphSnapshotCluster.findMany({
      where: { snapshotId: id, ownerId },
      select: SNAPSHOT_THEME_ROW_SELECT,
      orderBy: [{ vitality: "desc" }, { clusterId: "desc" }],
    });

    if (!includeMembers) {
      return { snapshot, themes, members: undefined, truncated: false };
    }

    const rows = await tx.graphSnapshotMember.findMany({
      where: { snapshotId: id, ownerId },
      select: SNAPSHOT_MEMBER_SELECT,
      orderBy: [{ vitality: "desc" }, { itemId: "desc" }],
      take: MEMBERS_CAP + 1,
    });
    const truncated = rows.length > MEMBERS_CAP;
    const members = (truncated ? rows.slice(0, MEMBERS_CAP) : rows).map(toSnapshotMember);

    return { snapshot, themes, members, truncated };
  });

  if (!result) {
    throw new PublicApiError("not_found", NOT_FOUND, 404);
  }

  const { snapshot, themes, members, truncated } = result;

  return ok(
    {
      ...toSnapshotSummary(snapshot),
      themes: themes.map(toSnapshotThemeRow),
      ...(members ? { members } : {}),
    },
    {
      cache: "static",
      request,
      meta: {
        count: themes.length,
        hasMore: false,
        nextCursor: null,
        ...(truncated ? { truncated: true } : {}),
      },
    },
  );
}

export const GET = withPublicApi(handler, { expensive: true });

export function OPTIONS(request: Request) {
  return handleOptions(request);
}
