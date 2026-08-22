"use client";

import { useEffect, useRef, useState } from "react";
import {
  DATE_RANGES,
  DATE_RANGE_LABELS,
  UNCATEGORIZED,
  type DateRange,
  type LikedItemsFilters,
} from "@/lib/liked-items-query";
import type { CategoryOption } from "@/app/api/categories/route";
import { PESTEL_DIMENSIONS, pestelDimension } from "@/config/pestel";

export function FiltersBar({
  filters,
  onChange,
  resultCount,
}: {
  filters: LikedItemsFilters;
  onChange: (next: LikedItemsFilters) => void;
  resultCount: number;
}) {
  const [options, setOptions] = useState<CategoryOption[]>([]);
  const [uncategorized, setUncategorized] = useState(0);
  const [open, setOpen] = useState(false);
  const [pestelOpen, setPestelOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const pestelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/categories")
      .then((res) => res.json())
      .then((data: { options: CategoryOption[]; uncategorized: number }) => {
        setOptions(data.options);
        setUncategorized(data.uncategorized);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!open && !pestelOpen) return;
    function handleClick(event: MouseEvent) {
      if (open && !dropdownRef.current?.contains(event.target as Node)) setOpen(false);
      if (pestelOpen && !pestelRef.current?.contains(event.target as Node)) setPestelOpen(false);
    }
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        setPestelOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open, pestelOpen]);

  function toggleCategory(name: string) {
    const next = filters.categories.includes(name)
      ? filters.categories.filter((c) => c !== name)
      : [...filters.categories, name];
    onChange({ ...filters, categories: next });
  }

  function togglePestel(key: string) {
    const next = filters.pestel.includes(key)
      ? filters.pestel.filter((p) => p !== key)
      : [...filters.pestel, key];
    onChange({ ...filters, pestel: next });
  }

  function setRange(range: DateRange) {
    onChange({ ...filters, range });
  }

  const selectedCount = filters.categories.length;
  const selectedPestelCount = filters.pestel.length;
  const hasFilters =
    selectedCount > 0 ||
    selectedPestelCount > 0 ||
    filters.range !== "all" ||
    filters.search.trim() !== "";

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-hairline bg-surface-1 p-3">
      <div className="flex flex-wrap items-center gap-2">
        {/* Rango sobre la fecha del like. flex-wrap: en 320px los cuatro rangos no
            caben en una linea y sin esto el grupo desborda la barra. */}
        <div className="inline-flex flex-wrap items-center border border-hairline bg-surface-1">
          {DATE_RANGES.map((range) => (
            <button
              key={range}
              type="button"
              onClick={() => setRange(range)}
              aria-pressed={filters.range === range}
              className={`label-mono px-3 py-1.5 transition-colors duration-150 ${
                filters.range === range
                  ? "bg-ink text-brand-white"
                  : "text-ink-subtle hover:text-ink"
              }`}
            >
              {DATE_RANGE_LABELS[range]}
            </button>
          ))}
        </div>

        {/* Categorias: seleccion multiple */}
        <div className="relative" ref={dropdownRef}>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-haspopup="true"
            className="label-mono inline-flex items-center gap-1.5 border border-hairline bg-surface-1 px-3 py-1.5 text-ink-subtle transition-colors duration-150 hover:border-ink hover:text-ink"
          >
            Categoría
            {selectedCount > 0 && (
              <span className="bg-brand-orange px-1.5 text-[10px] text-brand-white">
                {selectedCount}
              </span>
            )}
            <svg
              viewBox="0 0 12 12"
              className={`h-2.5 w-2.5 transition-transform duration-150 ${open ? "rotate-180" : ""}`}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path d="M2.5 4.5 6 8l3.5-3.5" />
            </svg>
          </button>

          {open && (
            <div className="absolute left-0 top-full z-20 mt-1.5 max-h-80 w-64 overflow-y-auto border border-ink bg-surface-1 p-1">
              {options.length === 0 && uncategorized === 0 && (
                <p className="px-2 py-3 text-xs text-ink-tertiary">
                  Todavía no hay categorías. Corre la sincronización para categorizar.
                </p>
              )}
              {options.map((option) => (
                <label
                  key={option.name}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-ink hover:bg-surface-1"
                >
                  <input
                    type="checkbox"
                    checked={filters.categories.includes(option.name)}
                    onChange={() => toggleCategory(option.name)}
                    className="h-3.5 w-3.5 accent-primary"
                  />
                  <span className="flex-1 truncate">{option.name}</span>
                  <span className="text-xs text-ink-tertiary">{option.count}</span>
                </label>
              ))}
              {uncategorized > 0 && (
                <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-ink-subtle hover:bg-surface-1">
                  <input
                    type="checkbox"
                    checked={filters.categories.includes(UNCATEGORIZED)}
                    onChange={() => toggleCategory(UNCATEGORIZED)}
                    className="h-3.5 w-3.5 accent-primary"
                  />
                  <span className="flex-1 truncate">Sin categorizar</span>
                  <span className="text-xs text-ink-tertiary">{uncategorized}</span>
                </label>
              )}
            </div>
          )}
        </div>

        {/* PESTEL: seleccion multiple, mismo patron que categoria. */}
        <div className="relative" ref={pestelRef}>
          <button
            type="button"
            onClick={() => setPestelOpen((v) => !v)}
            aria-expanded={pestelOpen}
            aria-haspopup="true"
            className="label-mono inline-flex items-center gap-1.5 border border-hairline bg-surface-1 px-3 py-1.5 text-ink-subtle transition-colors duration-150 hover:border-ink hover:text-ink"
          >
            PESTEL
            {selectedPestelCount > 0 && (
              <span className="bg-brand-orange px-1.5 text-[10px] text-brand-white">
                {selectedPestelCount}
              </span>
            )}
            <svg
              viewBox="0 0 12 12"
              className={`h-2.5 w-2.5 transition-transform duration-150 ${pestelOpen ? "rotate-180" : ""}`}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path d="M2.5 4.5 6 8l3.5-3.5" />
            </svg>
          </button>

          {pestelOpen && (
            <div className="absolute left-0 top-full z-20 mt-1.5 w-56 border border-ink bg-surface-1 p-1">
              {PESTEL_DIMENSIONS.map((dim) => (
                <label
                  key={dim.key}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-ink hover:bg-surface-1"
                >
                  <input
                    type="checkbox"
                    checked={filters.pestel.includes(dim.key)}
                    onChange={() => togglePestel(dim.key)}
                    className="h-3.5 w-3.5 accent-primary"
                  />
                  <span className="flex-1 truncate">
                    {dim.letter} · {dim.label}
                  </span>
                </label>
              ))}
            </div>
          )}
        </div>

        <input
          type="search"
          value={filters.search}
          onChange={(event) => onChange({ ...filters, search: event.target.value })}
          placeholder="Buscar en el texto…"
          className="min-w-40 flex-1 border border-hairline bg-canvas px-3 py-1.5 text-xs text-ink outline-none transition-colors duration-150 placeholder:text-ink-tertiary focus:border-hairline-tertiary"
        />

        {hasFilters && (
          <button
            type="button"
            onClick={() => onChange({ range: "all", categories: [], pestel: [], search: "" })}
            className="text-xs text-ink-subtle underline-offset-2 hover:text-ink hover:underline"
          >
            Limpiar
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-ink-tertiary">
          {resultCount} {resultCount === 1 ? "resultado" : "resultados"}
        </span>
        {filters.categories.map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => toggleCategory(name)}
            className="inline-flex items-center gap-1 border border-hairline bg-surface-1 px-2 py-0.5 text-[11px] text-ink-subtle transition-colors duration-150 hover:bg-surface-3 hover:text-ink"
          >
            {name === UNCATEGORIZED ? "Sin categorizar" : name}
            <span aria-hidden>×</span>
            <span className="sr-only">Quitar filtro</span>
          </button>
        ))}
        {filters.pestel.map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => togglePestel(key)}
            className="inline-flex items-center gap-1 border border-hairline bg-surface-1 px-2 py-0.5 text-[11px] text-ink-subtle transition-colors duration-150 hover:bg-surface-3 hover:text-ink"
          >
            {pestelDimension(key)?.label ?? key}
            <span aria-hidden>×</span>
            <span className="sr-only">Quitar filtro</span>
          </button>
        ))}
      </div>
    </div>
  );
}
