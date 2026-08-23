"use client";

import { useState } from "react";
import { HORIZON_COLORS } from "@/components/HorizontesBoard";
import type { HorizonKey } from "@/lib/horizons";

export type MacroTheme = {
  id: string;
  name: string;
  summary: string;
  horizon: HorizonKey;
  /** Suma de señales de los temas finos que agrupa. */
  size: number;
  /** Cuántos temas finos agrupa (1 = no se agrupó nada, es un tema suelto). */
  clusterCount: number;
};

const COLUMN_TITLES: Record<HorizonKey, string> = {
  H1: "Ya está pasando",
  H2: "En transición",
  H3: "Señal débil",
};

const COLUMNS: HorizonKey[] = ["H1", "H2", "H3"];

/**
 * Resumen de arriba de /horizontes: como mucho 15 macro-temas (5 por columna),
 * uno por horizonte. El detalle fino (los temas de verdad, hasta 45+) sigue
 * abajo en la tabla completa — esto es solo la vista de conjunto.
 */
export function MacroHorizonBoard({ themes }: { themes: MacroTheme[] }) {
  const [selected, setSelected] = useState<MacroTheme | null>(null);

  if (themes.length === 0) return null;

  const byColumn = new Map<HorizonKey, MacroTheme[]>();
  for (const h of COLUMNS) byColumn.set(h, []);
  for (const theme of themes) byColumn.get(theme.horizon)?.push(theme);
  for (const list of byColumn.values()) list.sort((a, b) => b.size - a.size);

  return (
    <section className="flex flex-col gap-3">
      <h2 className="section-heading text-ink">Macro-temas</h2>
      <div className="grid gap-4 sm:grid-cols-3">
        {COLUMNS.map((horizon) => (
          <div key={horizon} className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <span
                aria-hidden
                className="h-2.5 w-2.5 shrink-0"
                style={{ backgroundColor: HORIZON_COLORS[horizon] }}
              />
              <p className="label-mono text-ink-tertiary">{COLUMN_TITLES[horizon]}</p>
            </div>
            <div className="flex flex-col gap-2">
              {(byColumn.get(horizon) ?? []).length === 0 ? (
                <p className="text-xs text-ink-tertiary">Sin temas todavía.</p>
              ) : (
                byColumn.get(horizon)!.map((theme) => (
                  <button
                    key={theme.id}
                    type="button"
                    onClick={() => setSelected(theme)}
                    className="flex flex-col gap-1 border border-hairline bg-surface-1 p-3 text-left transition-colors duration-150 hover:border-hairline-strong"
                  >
                    <p className="text-sm font-medium text-ink">{theme.name}</p>
                    <p className="label-mono text-[10px] text-ink-tertiary">
                      {theme.size} señales
                      {theme.clusterCount > 1 ? ` · ${theme.clusterCount} temas` : ""}
                    </p>
                  </button>
                ))
              )}
            </div>
          </div>
        ))}
      </div>

      {selected && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setSelected(null)}
        >
          <div
            role="dialog"
            aria-modal
            onClick={(event) => event.stopPropagation()}
            className="flex max-h-[80vh] w-full max-w-lg flex-col gap-3 overflow-y-auto border border-ink bg-canvas p-5"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2">
                <span
                  aria-hidden
                  className="h-2.5 w-2.5 shrink-0"
                  style={{ backgroundColor: HORIZON_COLORS[selected.horizon] }}
                />
                <p className="label-mono text-ink-tertiary">{COLUMN_TITLES[selected.horizon]}</p>
              </div>
              <button
                type="button"
                onClick={() => setSelected(null)}
                aria-label="Cerrar"
                className="text-ink-tertiary hover:text-ink"
              >
                ×
              </button>
            </div>
            <h3 className="text-lg font-medium text-ink">{selected.name}</h3>
            <p className="text-sm leading-relaxed text-ink-subtle">
              {selected.summary || "Sin descripción todavía."}
            </p>
            <p className="label-mono text-[10px] text-ink-tertiary">
              {selected.size} señales
              {selected.clusterCount > 1 ? ` · agrupa ${selected.clusterCount} temas` : ""}
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
