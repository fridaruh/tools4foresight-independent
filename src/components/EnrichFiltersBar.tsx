"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { FiltersBar } from "@/components/FiltersBar";
import { filtersToSearchParams, type LikedItemsFilters } from "@/lib/liked-items-query";

/**
 * /enrich pagina y filtra en el servidor (a diferencia del catalogo, que trae
 * los resultados por fetch client-side) — así que en vez de un estado local,
 * FiltersBar se envuelve para que un cambio empuje una navegación con los
 * search params nuevos, conservando `estado` y `descartados`, y resetea `page`.
 */
export function EnrichFiltersBar({
  filters,
  resultCount,
}: {
  filters: LikedItemsFilters;
  resultCount: number;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function onChange(next: LikedItemsFilters) {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("page");
    ["range", "categories", "pestel", "q"].forEach((key) => params.delete(key));
    for (const [key, value] of filtersToSearchParams(next)) {
      params.set(key, value);
    }
    const query = params.toString();
    router.push(query ? `/enrich?${query}` : "/enrich");
  }

  return <FiltersBar filters={filters} onChange={onChange} resultCount={resultCount} />;
}
