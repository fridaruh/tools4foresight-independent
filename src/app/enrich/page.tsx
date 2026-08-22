import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { EnrichTable, type EnrichRow } from "@/components/EnrichTable";
import { EnrichFiltersBar } from "@/components/EnrichFiltersBar";
import { RunJobButton } from "@/components/RunJobButton";
import { toBoardItem } from "@/lib/board-item";
import { buildWhere, filtersFromSearchParams } from "@/lib/liked-items-query";
import { ANALYSIS_WINDOW } from "@/lib/jobs/analyze";
import { requireAdminPage } from "@/lib/require-admin";
import { isPublishStatus, type PublishStatus } from "@/lib/publish";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

// Pantalla 2 (PLAN seccion 6): tabla editable tipo hoja de calculo. Se pagina de
// verdad en vez de traer los ~4k items: la fila tiene inputs y renderizarlas todas
// deja el navegador inservible.
export default async function EnrichPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdminPage();

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    if (typeof value === "string") params.set(key, value);
  }
  const filters = filtersFromSearchParams(params);
  // Descartar saca el item de esta tabla, no del catalogo: la pantalla de likes lo
  // sigue mostrando. `?descartados=1` es la vista para revisarlos y devolverlos.
  const discardedView = params.get("descartados") === "1";
  // Por default se ve la cola de revision (pendientes): lo descartado (que ahora
  // incluye lo "no relevante", unificado con la lista de descartados) no aparece
  // hasta que se entra a "Ver descartados".
  const estadoParam = params.get("estado");
  const publishFilter: PublishStatus = isPublishStatus(estadoParam) ? estadoParam : "pending";
  const where = {
    ...buildWhere(filters),
    enrichDiscarded: discardedView,
    // El filtro de estado editorial es de la cola de trabajo activa; los descartados
    // se ven completos sin importar su publishStatus, igual que antes de Fase 2.
    ...(discardedView ? {} : { publishStatus: publishFilter }),
  };
  const page = Math.max(Number(params.get("page")) || 1, 1);
  const offset = (page - 1) * PAGE_SIZE;

  const [items, total, definitions, grouped, discardedCount, statusCounts] = await Promise.all([
    prisma.likedItem.findMany({
      where,
      orderBy: [{ likedAt: "desc" }, { tweetId: "desc" }],
      take: PAGE_SIZE,
      skip: offset,
      include: { customFields: true },
    }),
    prisma.likedItem.count({ where }),
    prisma.customFieldDefinition.findMany({ orderBy: [{ position: "asc" }, { createdAt: "asc" }] }),
    prisma.likedItem.groupBy({ by: ["category"], _count: { _all: true } }),
    prisma.likedItem.count({ where: { enrichDiscarded: true } }),
    prisma.likedItem.groupBy({
      by: ["publishStatus"],
      where: { enrichDiscarded: discardedView },
      _count: { _all: true },
    }),
  ]);

  const countByStatus = Object.fromEntries(statusCounts.map((row) => [row.publishStatus, row._count._all]));

  const rows: EnrichRow[] = items.map((item) => ({
    id: item.id,
    category: item.category,
    categorySource: item.categorySource,
    pestel: item.pestel,
    tldr: item.tldr,
    whyMatters: item.whyMatters,
    impact: item.impact,
    foresight: item.foresight,
    publishStatus: item.publishStatus as EnrichRow["publishStatus"],
    customFields: Object.fromEntries(
      item.customFields.map((field) => [field.fieldKey, field.fieldValue ?? ""]),
    ),
    item: toBoardItem(item),
  }));

  const categories = grouped
    .map((row) => row.category)
    .filter((name): name is string => name !== null)
    .sort();

  const lastPage = Math.max(Math.ceil(total / PAGE_SIZE), 1);
  const pageHref = (n: number) => {
    const next = new URLSearchParams(params);
    next.set("page", String(n));
    return `/enrich?${next}`;
  };

  // Cambiar de vista siempre vuelve a la pagina 1: la numeracion no es la misma entre
  // los descartados y el resto.
  const viewHref = (discarded: boolean) => {
    const next = new URLSearchParams(params);
    next.delete("page");
    if (discarded) next.set("descartados", "1");
    else next.delete("descartados");
    const query = next.toString();
    return query ? `/enrich?${query}` : "/enrich";
  };

  const estadoHref = (estado: "pending" | "published") => {
    const next = new URLSearchParams(params);
    next.delete("page");
    if (estado === "pending") next.delete("estado");
    else next.set("estado", estado);
    const query = next.toString();
    return query ? `/enrich?${query}` : "/enrich";
  };

  const ESTADO_LABEL: Record<string, string> = {
    pending: "Pendientes",
    published: "Publicadas",
  };

  return (
    <div
      data-section="enrich"
      className="mx-auto flex w-full max-w-[100rem] flex-1 flex-col gap-6 px-6 py-8 sm:px-10"
    >
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="section-title text-ink">
            {discardedView ? "Descartados" : "Enriquecer"}
          </h1>
          <p className="text-sm text-ink-subtle">
            {discardedView ? (
              <>
                Estos items siguen en el catálogo y conservan su categoría; solo no aparecen en la
                tabla de enriquecimiento. «Restaurar» los devuelve.
              </>
            ) : (
              <>
                El TL;DR, el impacto, el «por qué importa» y el foresight los escribe el modelo sobre los {ANALYSIS_WINDOW}{" "}
                likes más recientes; doble click sobre el texto para corregirlo. La categoría y
                PESTEL se guardan con el botón Guardar de la fila.
              </>
            )}
          </p>
        </div>
        {!discardedView && <RunJobButton path="/api/jobs/analyze" label="Generar análisis" />}
      </header>

      <EnrichFiltersBar filters={filters} resultCount={total} />

      <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        {discardedView ? (
          <Link
            href={viewHref(false)}
            prefetch={false}
            className="text-ink-subtle underline-offset-2 hover:text-ink hover:underline"
          >
            ← Volver a enriquecer
          </Link>
        ) : (
          <div className="label-mono flex border border-hairline">
            {(["pending", "published"] as const).map((estado) => (
              <Link
                key={estado}
                href={estadoHref(estado)}
                prefetch={false}
                className={`px-3 py-1.5 ${
                  publishFilter === estado
                    ? "bg-ink text-brand-white"
                    : "text-ink-subtle hover:bg-surface-1 hover:text-ink"
                }`}
              >
                {ESTADO_LABEL[estado]} ({countByStatus[estado] ?? 0})
              </Link>
            ))}
          </div>
        )}

        {!discardedView && discardedCount > 0 && (
          <Link
            href={viewHref(true)}
            prefetch={false}
            className="text-ink-subtle underline-offset-2 hover:text-ink hover:underline"
          >
            Ver descartados ({discardedCount})
          </Link>
        )}
      </div>

      {discardedView && rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-hairline-strong py-16 text-center text-sm text-ink-subtle">
          No hay items descartados.
        </p>
      ) : (
        <EnrichTable
          // EnrichTable inicializa su estado (saved/order/drafts) desde `rows` con
          // useState, que solo corre en el primer render: sin `key`, cambiar de
          // pestaña (Pendientes/Publicadas, Descartados, filtros, página) navega a
          // otro `rows` pero React reusa la misma instancia y se queda mostrando la
          // tabla anterior. La key fuerza un remount limpio cada vez que cambia lo
          // que el servidor filtró.
          key={params.toString()}
          rows={rows}
          columns={definitions.map((d) => d.fieldKey)}
          categories={categories}
          discardedView={discardedView}
          initialPublishFilter={publishFilter}
        />
      )}

      <nav className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="text-ink-tertiary">
          Página {page} de {lastPage} · {total} items
        </span>
        <span className="flex gap-2">
          {page > 1 && (
            <Link
              href={pageHref(page - 1)}
              prefetch={false}
              className="rounded-md border border-hairline bg-surface-1 px-3 py-1.5 font-medium text-ink hover:bg-surface-2"
            >
              Anterior
            </Link>
          )}
          {page < lastPage && (
            <Link
              href={pageHref(page + 1)}
              prefetch={false}
              className="rounded-md border border-hairline bg-surface-1 px-3 py-1.5 font-medium text-ink hover:bg-surface-2"
            >
              Siguiente
            </Link>
          )}
        </span>
      </nav>
    </div>
  );
}
