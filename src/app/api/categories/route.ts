import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { CATEGORY_NAMES } from "@/config/categories";
import { requireUserApi } from "@/lib/require-user";

export type CategoryOption = { name: string; count: number };

// Las opciones del filtro salen de lo que hay en la DB, no solo del catalogo:
// el modelo puede haber propuesto categorias nuevas (PLAN 3.1) y esas tambien
// tienen que poderse filtrar.
//
// Los conteos son siempre del catalogo del usuario de la sesion. `scope=published`
// los recorta a lo publicado, como filtro de UI (ya no como regla de acceso).
// TODO(fase4): el orden de las opciones debe salir de la tabla `categories` del
// tenant, no de CATEGORY_NAMES (la plantilla generica).
export async function GET(request: NextRequest) {
  const user = await requireUserApi();
  if (user instanceof NextResponse) return user;

  const publishedOnly = request.nextUrl.searchParams.get("scope") === "published";
  const grouped = await prisma.likedItem.groupBy({
    by: ["category"],
    where: {
      ownerId: user.userId,
      ...(publishedOnly ? { publishStatus: "published" } : {}),
    },
    _count: { _all: true },
  });

  const options: CategoryOption[] = [];
  let uncategorized = 0;

  for (const row of grouped) {
    if (row.category === null) {
      uncategorized = row._count._all;
      continue;
    }
    options.push({ name: row.category, count: row._count._all });
  }

  // Primero las del catalogo en su orden definido, luego las propuestas por el
  // modelo ordenadas por volumen.
  options.sort((a, b) => {
    const ai = CATEGORY_NAMES.indexOf(a.name);
    const bi = CATEGORY_NAMES.indexOf(b.name);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return b.count - a.count;
  });

  return NextResponse.json({ options, uncategorized });
}
