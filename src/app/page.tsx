import Link from "next/link";
import { StatusBanner } from "@/components/StatusBanner";
import { LikedItemsBoard } from "@/components/LikedItemsBoard";
import { buildWhere, filtersFromSearchParams } from "@/lib/liked-items-query";
import { toBoardItem } from "@/lib/board-item";
import { getSessionUser } from "@/lib/require-user";
import { withOwner } from "@/lib/tenant-db";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 60;

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await getSessionUser();

  // Sin sesión: landing mínima (PLAN 4.1).
  if (!user) {
    return <Landing />;
  }

  // Con sesión: cockpit de catálogo del usuario. Toda lectura de tenant va dentro
  // de withOwner — fuera de eso, RLS devuelve 0 filas y el catálogo se vería
  // vacío para cualquiera (ver src/lib/tenant-db.ts).
  const ownerId = user.userId;

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    if (typeof value === "string") params.set(key, value);
  }
  const filters = filtersFromSearchParams(params);
  const where = { ...buildWhere(filters), ownerId };

  const { items, total, allTotal, xConnected, cursor } = await withOwner(ownerId, async (tx) => {
    const [items, total, allTotal, xToken, cursor] = await Promise.all([
      tx.likedItem.findMany({
        where,
        orderBy: [{ likedAt: "desc" }, { tweetId: "desc" }],
        take: PAGE_SIZE,
      }),
      tx.likedItem.count({ where }),
      tx.likedItem.count({ where: { ownerId } }),
      tx.xAuthToken.findFirst({ where: { userId: ownerId }, select: { id: true } }),
      tx.ingestionCursor.findFirst({
        where: { userId: ownerId },
        select: { lastStatus: true, lastError: true },
      }),
    ]);
    return { items, total, allTotal, xConnected: Boolean(xToken), cursor };
  });

  if (!xConnected) {
    return (
      <EmptyCockpit
        title="Conecta tu cuenta de X para empezar"
        body="Tu catálogo se llena con lo que le das like en X. Conéctala desde Sistema y la primera ingesta trae tu historial."
        ctaHref="/conexion"
        ctaLabel="Ir a Sistema"
      />
    );
  }

  if (allTotal === 0) {
    return (
      <EmptyCockpit
        title="Todavía no hay likes sincronizados"
        body="Tu primera ingesta corre a las 06:00 UTC, o dispárala ahora mismo desde Sistema."
        ctaHref="/conexion"
        ctaLabel="Ir a Sistema"
      />
    );
  }

  return (
    <div
      data-section="likes"
      className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-6 py-8 sm:px-10"
    >
      <header>
        <h1 className="section-title text-ink">Tu catálogo</h1>
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

/** Estado vacío del cockpit (sin X conectada, o conectada pero sin items todavía). */
function EmptyCockpit({
  title,
  body,
  ctaHref,
  ctaLabel,
}: {
  title: string;
  body: string;
  ctaHref: string;
  ctaLabel: string;
}) {
  return (
    <div
      data-section="likes"
      className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-6 py-8 sm:px-10"
    >
      <header>
        <h1 className="section-title text-ink">Tu catálogo</h1>
      </header>
      <div className="focus-frame flex flex-col items-center gap-3 bg-surface-1 px-6 py-20 text-center">
        <p className="section-heading text-ink">{title}</p>
        <p className="max-w-sm text-sm text-ink-subtle">{body}</p>
        <Link
          href={ctaHref}
          className="label-mono mt-2 border border-ink bg-ink px-4 py-2 text-brand-white transition-colors duration-150 hover:border-brand-orange hover:bg-brand-orange"
        >
          {ctaLabel}
        </Link>
      </div>
    </div>
  );
}

/** Landing pública (sin sesión): qué es, en dos líneas, y las dos puertas de entrada. */
function Landing() {
  return (
    <div
      data-section="landing"
      className="landing-grid flex flex-1 flex-col items-center justify-center gap-8 px-6 py-24 text-center"
    >
      <div className="flex flex-col items-center gap-4">
        <h1 className="section-title text-ink">Tools 4 Foresight</h1>
        <p className="max-w-md text-base leading-relaxed text-ink-subtle">
          Conecta tu cuenta de X y convierte tus likes en un banco de señales categorizado, con
          análisis de impacto y un grafo de temas — no solo el link guardado.
        </p>
      </div>
      <div className="flex gap-3">
        <Link
          href="/login"
          className="label-mono border border-ink bg-ink px-6 py-2.5 text-brand-white transition-colors duration-150 hover:border-brand-orange hover:bg-brand-orange"
        >
          Entrar
        </Link>
        <Link
          href="/registro"
          className="label-mono border border-ink px-6 py-2.5 text-ink transition-colors duration-150 hover:border-brand-orange hover:text-brand-orange"
        >
          Crear cuenta
        </Link>
      </div>
    </div>
  );
}
