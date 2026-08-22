import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { buildWhere, filtersFromSearchParams } from "@/lib/liked-items-query";
import { toBoardItem } from "@/lib/board-item";
import { InvalidLinkError, manualItemInput, normalizeLinkUrl } from "@/lib/manual-link";
import { getEffectiveRole, requireSessionApi, requireAdminApi } from "@/lib/require-admin";

const DEFAULT_LIMIT = 60;

export async function GET(request: NextRequest) {
  const denied = await requireSessionApi();
  if (denied) return denied;

  const searchParams = request.nextUrl.searchParams;
  const filters = filtersFromSearchParams(searchParams);
  const limit = Math.min(Number(searchParams.get("limit")) || DEFAULT_LIMIT, 100);
  const offset = Math.max(Number(searchParams.get("offset")) || 0, 0);

  // El proxy solo valida que haya sesion; el alcance va por rol. Un member ve
  // unicamente lo publicado — sin esto, cualquier cuenta (y con signup abierto,
  // cualquiera) podria jalar el catalogo crudo completo por la API. scope=published
  // lo manda ademas el board de /senales para que un admin parado ahi vea lo
  // mismo que ve un member.
  const role = await getEffectiveRole();
  const where = buildWhere(filters);
  if (role !== "admin" || searchParams.get("scope") === "published") {
    where.publishStatus = "published";
  }

  // Paginacion por offset y no por cursor: el orden es por `likedAt`, que tiene
  // empates (varios items historicos comparten fecha), y un cursor sobre un campo
  // no unico se salta filas.
  const [items, total] = await Promise.all([
    prisma.likedItem.findMany({
      where,
      orderBy: [{ likedAt: "desc" }, { tweetId: "desc" }],
      take: limit,
      skip: offset,
    }),
    prisma.likedItem.count({ where }),
  ]);

  return NextResponse.json({
    // Misma forma que la primera pagina renderizada en el servidor (ver BoardItem):
    // el cliente no tiene que distinguir de donde vino cada item.
    items: items.map(toBoardItem),
    total,
    nextOffset: offset + items.length < total ? offset + items.length : null,
  });
}

/**
 * Agregar un enlace a mano (no viene de X). Solo crea la fila y devuelve; el fetch de
 * contenido y el analisis los corre despues `POST /api/liked-items/[id]/process`,
 * porque juntos tardan mas de lo que un formulario debe quedarse esperando.
 */
export async function POST(request: NextRequest) {
  const denied = await requireAdminApi();
  if (denied) return denied;

  const { url: rawUrl } = (await request.json()) as { url?: string };

  let url: string;
  try {
    url = normalizeLinkUrl(rawUrl ?? "");
  } catch (error) {
    if (error instanceof InvalidLinkError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

  // Se busca por las dos columnas: un enlace que ya llego por un like de X vive en
  // `contentUrl`, y uno agregado a mano en las dos. Agregarlo otra vez duplicaria la
  // fila en el catalogo sin que nada mas lo impida (el unique es sobre `tweetId`).
  const existing = await prisma.likedItem.findFirst({
    where: { OR: [{ contentUrl: url }, { tweetUrl: url }] },
    include: { customFields: true },
  });
  if (existing) {
    return NextResponse.json(
      { error: "Ese enlace ya está en el catálogo.", item: toBoardItem(existing) },
      { status: 409 },
    );
  }

  const item = await prisma.likedItem.create({
    data: manualItemInput(url),
    include: { customFields: true },
  });

  return NextResponse.json({ item: toBoardItem(item) }, { status: 201 });
}
