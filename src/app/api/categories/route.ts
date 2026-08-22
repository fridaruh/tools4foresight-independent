import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { CATEGORY_NAMES } from "@/config/categories";
import { getEffectiveRole, requireAccessApi } from "@/lib/require-admin";

export type CategoryOption = { name: string; count: number };

// Las opciones del filtro salen de lo que hay en la DB, no solo del catalogo:
// el modelo puede haber propuesto categorias nuevas (PLAN 3.1) y esas tambien
// tienen que poderse filtrar.
//
// Para un member los conteos se calculan solo sobre lo publicado: son los que
// muestra su vista de Señales, y los totales del catalogo crudo son dato
// interno. Publicar exige categoria (src/lib/publish.ts), asi que para member
// `uncategorized` es siempre 0 y el filtro "Sin categorizar" no aparece.
export async function GET(request: NextRequest) {
  const denied = await requireAccessApi();
  if (denied) return denied;
  const role = await getEffectiveRole();
  // scope=published lo manda el board de /senales tambien para admins, para que
  // los conteos empaten con lo que esa vista realmente lista.
  const publishedOnly =
    role !== "admin" || request.nextUrl.searchParams.get("scope") === "published";
  const grouped = await prisma.likedItem.groupBy({
    by: ["category"],
    where: publishedOnly ? { publishStatus: "published" } : undefined,
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
