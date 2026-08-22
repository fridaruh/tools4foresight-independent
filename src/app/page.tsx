import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { StatusBanner } from "@/components/StatusBanner";
import { LikedItemsBoard } from "@/components/LikedItemsBoard";
import { LandingPage } from "@/components/LandingPage";
import { buildWhere, filtersFromSearchParams } from "@/lib/liked-items-query";
import { toBoardItem } from "@/lib/board-item";
import { getEffectiveRole } from "@/lib/require-admin";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 60;

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // "/" es la landing para anonimos, el home de member (redirige a su tab 01,
  // las tarjetas por categoria) y el cockpit de admin — segun el rol, no una
  // ruta separada (Fase 5 del plan).
  const role = await getEffectiveRole();
  if (role === "member") redirect("/categorias");
  if (role === null) return <LandingPage />;

  // Los filtros viven en la URL, asi que la primera pagina se resuelve ya filtrada
  // en el servidor: recargar una vista filtrada no parpadea con la lista completa.
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    if (typeof value === "string") params.set(key, value);
  }
  const filters = filtersFromSearchParams(params);
  const where = buildWhere(filters);

  const [items, total, allTotal, cursor] = await Promise.all([
    prisma.likedItem.findMany({
      where,
      orderBy: [{ likedAt: "desc" }, { tweetId: "desc" }],
      take: PAGE_SIZE,
    }),
    prisma.likedItem.count({ where }),
    // El encabezado cuenta todo lo guardado, no lo filtrado: el conteo del filtro
    // ya lo muestra la barra de filtros.
    prisma.likedItem.count(),
    prisma.ingestionCursor.findFirst(),
  ]);

  return (
    <div
      data-section="likes"
      className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-6 py-8 sm:px-10"
    >
      <header>
        <h1 className="section-title text-ink">Tus likes de X</h1>
        <p className="text-sm text-ink-subtle">{allTotal} guardados hasta ahora</p>
      </header>

      {cursor && <StatusBanner lastStatus={cursor.lastStatus} lastError={cursor.lastError} />}

      <LikedItemsBoard
        initialItems={items.map(toBoardItem)}
        initialTotal={total}
        initialNextOffset={items.length < total ? items.length : null}
        initialFilters={filters}
      />
    </div>
  );
}
