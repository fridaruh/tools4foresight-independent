"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { BoardItem } from "@/lib/board-item";
import {
  DEFAULT_FILTERS,
  filtersToSearchParams,
  type LikedItemsFilters,
} from "@/lib/liked-items-query";
import { ViewToggle, type ViewMode } from "@/components/ViewToggle";
import { FiltersBar } from "@/components/FiltersBar";
import { LikedItemCard } from "@/components/LikedItemCard";
import { LikedItemRow } from "@/components/LikedItemRow";
import { TweetModal } from "@/components/TweetModal";

/** Espera antes de pegarle a la API al escribir en la busqueda. */
const SEARCH_DEBOUNCE_MS = 300;

export function LikedItemsBoard({
  initialItems,
  initialTotal,
  initialNextOffset,
  initialFilters,
  audience = "admin",
}: {
  initialItems: BoardItem[];
  initialTotal: number;
  initialNextOffset: number | null;
  initialFilters: LikedItemsFilters;
  /**
   * "member" es el mismo board montado en /senales: la API ya escopea a lo
   * publicado por rol; aqui solo cambian la URL que refleja los filtros y el
   * copy del estado vacio (un member no tiene boton de sincronizar).
   */
  audience?: "admin" | "member";
}) {
  const basePath = audience === "member" ? "/senales" : "/";
  const [view, setView] = useState<ViewMode>("cards");
  const [filters, setFilters] = useState(initialFilters);
  const [items, setItems] = useState(initialItems);
  const [total, setTotal] = useState(initialTotal);
  const [nextOffset, setNextOffset] = useState(initialNextOffset);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);

  // El render del servidor ya trajo la primera pagina con `initialFilters`, asi que
  // el efecto de abajo no debe repetir esa misma consulta al montar.
  const isFirstRender = useRef(true);

  const fetchPage = useCallback(async (next: LikedItemsFilters, offset: number) => {
    const params = filtersToSearchParams(next);
    params.set("offset", String(offset));
    // scope=published: un admin parado en /senales tiene que ver exactamente lo
    // que ve un member; sin esto la API le devolveria tambien lo no publicado y
    // filtrar contradiria la primera pagina del server.
    if (audience === "member") params.set("scope", "published");
    const res = await fetch(`/api/liked-items?${params}`);
    if (!res.ok) throw new Error("No se pudo cargar la lista");
    return (await res.json()) as {
      items: BoardItem[];
      total: number;
      nextOffset: number | null;
    };
  }, [audience]);

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }

    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const data = await fetchPage(filters, 0);
        if (cancelled) return;
        setItems(data.items);
        setTotal(data.total);
        setNextOffset(data.nextOffset);
        // La URL refleja los filtros para que recargar o compartir la vista la
        // conserve. replaceState y no push: filtrar no deberia llenar el historial.
        const params = filtersToSearchParams(filters);
        const query = params.toString();
        window.history.replaceState(null, "", query ? `${basePath}?${query}` : basePath);
      } catch {
        if (!cancelled) setItems([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [filters, fetchPage, basePath]);

  async function loadMore() {
    if (nextOffset === null) return;
    setLoadingMore(true);
    try {
      const data = await fetchPage(filters, nextOffset);
      setItems((prev) => [...prev, ...data.items]);
      setTotal(data.total);
      setNextOffset(data.nextOffset);
    } finally {
      setLoadingMore(false);
    }
  }

  const selected = selectedIndex === null ? null : (items[selectedIndex] ?? null);

  function goPrev() {
    setSelectedIndex((i) => (i !== null && i > 0 ? i - 1 : i));
  }

  async function goNext() {
    if (selectedIndex === null) return;
    if (selectedIndex < items.length - 1) {
      setSelectedIndex(selectedIndex + 1);
      return;
    }
    // Al filo de lo ya cargado: trae la siguiente pagina y avanza, para que las
    // flechas no se topen con una pared en el item 60 cuando hay 4000.
    if (nextOffset !== null && !loadingMore) {
      await loadMore();
      setSelectedIndex(selectedIndex + 1);
    }
  }

  const hasFilters =
    filters.range !== DEFAULT_FILTERS.range ||
    filters.categories.length > 0 ||
    filters.search.trim() !== "";

  return (
    <div className="flex flex-col gap-5">
      <FiltersBar filters={filters} onChange={setFilters} resultCount={total} audience={audience} />

      <div className="flex items-center justify-between">
        <p className="text-sm text-ink-subtle">
          {loading ? "Filtrando…" : `Mostrando ${items.length} de ${total}`}
        </p>
        <ViewToggle view={view} onChange={setView} />
      </div>

      {items.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-hairline-strong py-16 text-center">
          <p className="text-sm font-medium text-ink">
            {hasFilters
              ? audience === "member"
                ? "Ninguna señal coincide con estos filtros"
                : "Ningún like coincide con estos filtros"
              : audience === "member"
                ? "Todavía no hay señales publicadas"
                : "Todavía no hay likes sincronizados"}
          </p>
          <p className="text-sm text-ink-subtle">
            {hasFilters
              ? "Prueba con un rango de fechas más amplio o quita alguna categoría."
              : audience === "member"
                ? "Vuelve pronto: el banco se alimenta todos los días."
                : "Usa el botón de sincronizar arriba a la derecha para traer tus likes de X."}
          </p>
        </div>
      ) : view === "cards" ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {items.map((item, index) => (
            <LikedItemCard
              key={item.id}
              item={item}
              onOpen={() => setSelectedIndex(index)}
            />
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          {items.map((item, index) => (
            <LikedItemRow key={item.id} item={item} onOpen={() => setSelectedIndex(index)} />
          ))}
        </div>
      )}

      {nextOffset !== null && (
        <button
          type="button"
          onClick={loadMore}
          disabled={loadingMore}
          className="mx-auto mt-2 rounded-md border border-hairline bg-surface-1 px-4 py-2 text-sm font-medium text-ink transition-colors duration-150 hover:bg-surface-2 disabled:opacity-60"
        >
          {loadingMore ? "Cargando…" : "Cargar más"}
        </button>
      )}

      {selected && (
        <TweetModal
          item={selected}
          onClose={() => setSelectedIndex(null)}
          onPrev={goPrev}
          onNext={goNext}
          hasPrev={selectedIndex !== null && selectedIndex > 0}
          hasNext={
            selectedIndex !== null && (selectedIndex < items.length - 1 || nextOffset !== null)
          }
        />
      )}
    </div>
  );
}
