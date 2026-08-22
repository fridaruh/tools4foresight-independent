import { NextRequest, NextResponse } from "next/server";
import { withOwner } from "@/lib/tenant-db";
import { buildWhere, filtersFromSearchParams } from "@/lib/liked-items-query";
import { toBoardItem } from "@/lib/board-item";
import { InvalidLinkError, manualItemInput, normalizeLinkUrl } from "@/lib/manual-link";
import { requireUserApi } from "@/lib/require-user";

const DEFAULT_LIMIT = 60;

export async function GET(request: NextRequest) {
  const user = await requireUserApi();
  if (user instanceof NextResponse) return user;

  const searchParams = request.nextUrl.searchParams;
  const filters = filtersFromSearchParams(searchParams);
  const limit = Math.min(Number(searchParams.get("limit")) || DEFAULT_LIMIT, 100);
  const offset = Math.max(Number(searchParams.get("offset")) || 0, 0);

  // Ya no hay recorte por rol: cada usuario es dueño de su banco y lo ve completo.
  // El alcance lo pone el ownerId. `scope=published` sigue existiendo como filtro
  // opcional de la UI, no como regla de seguridad.
  const where = buildWhere(filters);
  where.ownerId = user.userId;
  if (searchParams.get("scope") === "published") {
    where.publishStatus = "published";
  }

  // Paginacion por offset y no por cursor: el orden es por `likedAt`, que tiene
  // empates (varios items historicos comparten fecha), y un cursor sobre un campo
  // no unico se salta filas.
  const [items, total] = await withOwner(user.userId, (tx) =>
    Promise.all([
      tx.likedItem.findMany({
        where,
        orderBy: [{ likedAt: "desc" }, { tweetId: "desc" }],
        take: limit,
        skip: offset,
      }),
      tx.likedItem.count({ where }),
    ]),
  );

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
  const user = await requireUserApi();
  if (user instanceof NextResponse) return user;

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
  const result = await withOwner(user.userId, async (tx) => {
    const existing = await tx.likedItem.findFirst({
      where: { ownerId: user.userId, OR: [{ contentUrl: url }, { tweetUrl: url }] },
      include: { customFields: true },
    });
    if (existing) return { status: 409 as const, item: existing };

    const item = await tx.likedItem.create({
      data: manualItemInput(url, user.userId),
      include: { customFields: true },
    });
    return { status: 201 as const, item };
  });

  if (result.status === 409) {
    return NextResponse.json(
      { error: "Ese enlace ya está en el catálogo.", item: toBoardItem(result.item) },
      { status: 409 },
    );
  }
  return NextResponse.json({ item: toBoardItem(result.item) }, { status: 201 });
}
