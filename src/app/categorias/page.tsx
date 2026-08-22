import { CategoryBadge } from "@/components/CategoryBadge";
import { RunJobButton } from "@/components/RunJobButton";
import { CategoryEditor, type CategoryDTO } from "@/components/CategoryEditor";
import { getCategoriesOverview } from "@/lib/category-service";
import { requireUserPage } from "@/lib/require-user";
import { withOwner } from "@/lib/tenant-db";
import { SourcesBoard } from "@/components/SourcesBoard";
import { summarizeSources } from "@/lib/sources";

export const dynamic = "force-dynamic";

/**
 * `/categorias` (PLAN 4.3): el catálogo del tenant, editable, con distribución
 * y propuestas del modelo. Todo se carga aquí (server component) vía
 * `withOwner`; `CategoryEditor` recibe las props ya resueltas y cada mutación
 * termina en `router.refresh()`, que vuelve a correr este componente.
 */
export default async function CategoriasPage() {
  const user = await requireUserPage();

  const { categories, distribution, uncategorizedCount, proposed, lowConfidence, sources } = await withOwner(
    user.userId,
    async (tx) => {
      const overview = await getCategoriesOverview(tx, user.userId);
      const lowConfidence = await tx.likedItem.findMany({
        where: { ownerId: user.userId, categoryConfidence: { lt: 0.6 }, categorySource: "auto" },
        orderBy: { categoryConfidence: "asc" },
        take: 15,
        select: {
          id: true,
          category: true,
          categoryConfidence: true,
          categoryReasoning: true,
          tweetText: true,
          authorHandle: true,
        },
      });
      const sourceRows = await tx.likedItem.findMany({
        where: { ownerId: user.userId },
        select: { source: true, authorHandle: true, contentUrl: true, tweetUrl: true },
      });
      return { ...overview, lowConfidence, sources: summarizeSources(sourceRows) };
    },
  );

  const categoryDtos: CategoryDTO[] = categories.map((c) => ({
    id: c.id,
    name: c.name,
    description: c.description,
    examples: c.examples,
    position: c.position,
    isFallback: c.isFallback,
  }));

  const uncategorized = uncategorizedCount;

  return (
    <div
      data-section="categorias"
      className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-8 px-6 py-8 sm:px-10"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="section-title text-ink">Categorías</h1>
          <p className="text-sm text-ink-subtle">
            Tu catálogo de categorías: cómo lo edites cambia con qué clasifica el modelo la próxima
            vez que corra.
          </p>
        </div>
        {uncategorized > 0 && (
          <RunJobButton path="/api/jobs/categorize/run" label="Categorizar pendientes" />
        )}
      </header>

      <SourcesBoard summary={sources} />

      <CategoryEditor
        categories={categoryDtos}
        distribution={distribution}
        proposed={proposed}
        uncategorized={uncategorized}
      />


      {lowConfidence.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="section-heading text-ink">Clasificaciones dudosas</h2>
          <p className="text-sm text-ink-subtle">
            Las que el modelo asignó con menos confianza. Buen punto de partida para revisar o para
            ajustar la descripción/ejemplos de la categoría que le costó trabajo.
          </p>
          <ul className="flex flex-col gap-2">
            {lowConfidence.map((item) => (
              <li key={item.id} className="rounded-lg border border-hairline bg-surface-1 p-3">
                <div className="flex items-start justify-between gap-3">
                  <p className="min-w-0 flex-1 text-sm text-ink line-clamp-2">{item.tweetText}</p>
                  <CategoryBadge category={item.category} />
                </div>
                <p className="mt-1 text-xs text-ink-tertiary">
                  @{item.authorHandle} ·{" "}
                  {item.categoryConfidence !== null
                    ? `${Math.round(Number(item.categoryConfidence) * 100)}% de confianza`
                    : "sin confianza"}
                  {item.categoryReasoning ? ` · ${item.categoryReasoning}` : ""}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
