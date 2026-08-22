import { prisma } from "@/lib/prisma";
import { StatusBanner } from "@/components/StatusBanner";
import { LikedItemsBoard } from "@/components/LikedItemsBoard";
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
  const role = await getEffectiveRole();

  // Sin sesión: landing mínima
  if (role === null) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-6 px-6 text-center">
        <h1 className="text-4xl font-bold">tools4foresight</h1>
        <p className="text-lg text-gray-600">Conecta tu cuenta de X y construye tu propio banco de señales</p>
        <div className="flex gap-4">
          <a href="/login" className="rounded bg-blue-500 px-6 py-2 text-white hover:bg-blue-600">
            Entrar
          </a>
          <a href="/registro" className="rounded border border-blue-500 px-6 py-2 text-blue-500 hover:bg-blue-50">
            Registrarse
          </a>
        </div>
      </main>
    );
  }

  // Con sesión: cockpit de catálogo
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
