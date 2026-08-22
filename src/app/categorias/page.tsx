import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { CATEGORIES, isKnownCategory } from "@/config/categories";
import { CategoryBadge } from "@/components/CategoryBadge";
import { RunJobButton } from "@/components/RunJobButton";
import { getAccess } from "@/lib/require-admin";
import { CategoriasMemberView } from "./member-view";

export const dynamic = "force-dynamic";

// La ruta se comparte por rol, como "/": para un member es su home de tarjetas
// por categoria; para admin sigue siendo la taxonomia de siempre.
export default async function CategoriasPage() {
  const { role, hasAccess } = await getAccess();
  if (role === null) redirect("/login?from=%2Fcategorias");
  // Member sin suscripcion vigente: a pagar antes de ver contenido (Fase 4).
  if (role === "member") return hasAccess ? <CategoriasMemberView /> : redirect("/suscripcion");

  const [grouped, manualCount, lowConfidence] = await Promise.all([
    prisma.likedItem.groupBy({
      by: ["category"],
      _count: { _all: true },
      _avg: { categoryConfidence: true },
    }),
    prisma.likedItem.count({ where: { categorySource: "manual" } }),
    prisma.likedItem.findMany({
      where: { categoryConfidence: { lt: 0.6 }, categorySource: "auto" },
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
    }),
  ]);

  const rows = grouped
    .map((row) => ({
      name: row.category,
      count: row._count._all,
      confidence: row._avg.categoryConfidence ? Number(row._avg.categoryConfidence) : null,
    }))
    .sort((a, b) => b.count - a.count);

  const uncategorized = rows.find((row) => row.name === null)?.count ?? 0;
  // Categorias que propuso el modelo y todavia no estan en src/config/categories.ts.
  const proposed = rows.filter((row) => row.name !== null && !isKnownCategory(row.name));

  return (
    <div
      data-section="categorias"
      className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-8 px-6 py-8 sm:px-10"
    >
      <header>
        <h1 className="section-title text-ink">Categorías</h1>
        <p className="text-sm text-ink-subtle">
          Cómo quedaron repartidos tus likes. La clasificación la hace un modelo local vía Ollama;
          puedes corregir cualquier item desde{" "}
          <Link href="/enrich" className="underline underline-offset-2 hover:text-ink">
            Enriquecer
          </Link>
          .
        </p>
      </header>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="section-heading text-ink">Distribución</h2>
          {uncategorized > 0 && <RunJobButton path="/api/jobs/categorize" label="Categorizar pendientes" />}
        </div>

        {/* En movil la tabla completa no cabe y scrollear la cortaba en un numero a
            medias: la columna Confianza (la menos consultada) se esconde en <sm y la
            de Categoria trunca, con lo que todo entra sin scroll. */}
        <div className="overflow-x-auto rounded-xl border border-hairline">
          <table className="w-full border-collapse text-sm sm:min-w-[28rem]">
            <thead>
              <tr className="label-mono border-b border-ink bg-surface-1 text-left text-ink-subtle">
                <th className="px-2 py-2 font-medium sm:px-4">Categoría</th>
                <th className="w-24 px-2 py-2 text-right font-medium sm:px-4">Items</th>
                <th className="w-32 px-2 py-2 text-right font-medium max-sm:hidden sm:px-4">
                  Confianza
                </th>
                <th className="w-24 px-2 py-2 text-right font-medium sm:px-4">&nbsp;</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.name ?? "null"} className="border-b border-hairline last:border-b-0">
                  <td className="px-2 py-2 max-sm:w-full max-sm:max-w-0 sm:px-4">
                    <CategoryBadge category={row.name} />
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums text-ink sm:px-4">{row.count}</td>
                  <td className="px-2 py-2 text-right tabular-nums text-ink-subtle max-sm:hidden sm:px-4">
                    {row.confidence === null ? "—" : `${Math.round(row.confidence * 100)}%`}
                  </td>
                  <td className="px-2 py-2 text-right sm:px-4">
                    <Link
                      href={`/?categories=${encodeURIComponent(row.name ?? "__sin_categoria__")}`}
                      className="text-xs text-ink-subtle underline-offset-2 hover:text-ink hover:underline"
                    >
                      Ver
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="text-xs text-ink-tertiary">
          {manualCount} {manualCount === 1 ? "item corregido" : "items corregidos"} a mano. Las
          corridas automáticas no los vuelven a tocar.
        </p>
      </section>

      {proposed.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="section-heading text-ink">Propuestas por el modelo</h2>
          <p className="text-sm text-ink-subtle">
            Estas no están en el catálogo. Si te sirven, agrégalas en{" "}
            <code className="rounded bg-surface-2 px-1 py-0.5 text-xs">src/config/categories.ts</code>{" "}
            para que las siguientes corridas las usen con ejemplos propios.
          </p>
          <ul className="flex flex-wrap gap-2">
            {proposed.map((row) => (
              <li
                key={row.name}
                className="label-mono border border-hairline bg-surface-1 px-3 py-1 text-ink-subtle"
              >
                {row.name} · {row.count}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="section-heading text-ink">Catálogo actual</h2>
        <dl className="flex flex-col gap-3">
          {CATEGORIES.map((category) => (
            <div key={category.name} className="rounded-lg border border-hairline bg-surface-1 p-3">
              <dt className="text-sm font-medium text-ink">{category.name}</dt>
              <dd className="mt-0.5 text-sm text-ink-subtle">{category.description}</dd>
            </div>
          ))}
        </dl>
      </section>

      {lowConfidence.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="section-heading text-ink">Clasificaciones dudosas</h2>
          <p className="text-sm text-ink-subtle">
            Las que el modelo asignó con menos confianza. Buen punto de partida para revisar.
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
