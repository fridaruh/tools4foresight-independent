"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { PESTEL_DIMENSIONS } from "@/config/pestel";

/** Alto estimado del panel (6 opciones + el pie). Solo decide si abre hacia arriba. */
const PANEL_HEIGHT = 260;
const PANEL_WIDTH = 200;

type Position = { top: number; left: number };

/**
 * Desplegable de seleccion multiple para PESTEL.
 *
 * El panel se monta en un portal sobre `document.body` y se posiciona con coordenadas
 * fijas, no como hijo de la celda: la tabla vive dentro de un `overflow-x-auto` y
 * cualquier menu absoluto dentro de ella se recorta contra el borde del contenedor.
 * A cambio hay que reposicionarlo si la pagina o la tabla hacen scroll — de ahi el
 * listener con `capture` sobre scroll.
 */
export function PestelSelect({
  selected,
  onChange,
}: {
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<Position | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function place() {
      const anchor = buttonRef.current?.getBoundingClientRect();
      if (!anchor) return;
      // Si no cabe abajo pero si arriba, se voltea. Si no cabe en ninguno de los dos,
      // se queda abajo pegado al borde de la ventana.
      const spaceBelow = window.innerHeight - anchor.bottom;
      const above = spaceBelow < PANEL_HEIGHT && anchor.top > PANEL_HEIGHT;
      setPosition({
        top: above ? anchor.top - PANEL_HEIGHT - 4 : anchor.bottom + 4,
        left: Math.min(anchor.left, window.innerWidth - PANEL_WIDTH - 8),
      });
    }

    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    }

    function handlePointer(event: MouseEvent) {
      const target = event.target as Node;
      if (buttonRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    }

    place();
    document.addEventListener("keydown", handleKey);
    document.addEventListener("mousedown", handlePointer);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);

    return () => {
      document.removeEventListener("keydown", handleKey);
      document.removeEventListener("mousedown", handlePointer);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  function toggle(key: string) {
    onChange(selected.includes(key) ? selected.filter((k) => k !== key) : [...selected, key]);
  }

  const chosen = PESTEL_DIMENSIONS.filter((d) => selected.includes(d.key));
  const title = chosen.length > 0 ? chosen.map((d) => d.label).join(", ") : "Sin dimensiones";

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={title}
        className="flex w-full items-center justify-between gap-1 rounded-md border border-hairline bg-canvas px-2 py-1 text-left text-sm text-ink transition-colors duration-150 hover:border-hairline-strong"
      >
        {chosen.length === 0 ? (
          <span className="text-ink-tertiary">Seleccionar</span>
        ) : (
          // Se muestran las letras del acronimo y no las etiquetas completas: en una
          // columna de 160px, "Político, Tecnológico" no cabe ni truncado con sentido.
          <span className="flex flex-wrap gap-1">
            {chosen.map((dimension) => (
              <span
                key={dimension.key}
                className="flex h-5 w-5 items-center justify-center rounded bg-ink text-[10px] font-semibold text-canvas"
              >
                {dimension.letter}
              </span>
            ))}
          </span>
        )}
        <svg
          viewBox="0 0 16 16"
          aria-hidden
          className={`h-3 w-3 shrink-0 text-ink-tertiary transition-transform duration-150 ${open ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
        >
          <path d="m4 6 4 4 4-4" />
        </svg>
      </button>

      {open &&
        position &&
        createPortal(
          <div
            ref={panelRef}
            role="listbox"
            aria-multiselectable
            style={{ top: position.top, left: position.left, width: PANEL_WIDTH }}
            className="fixed z-50 flex flex-col border border-ink bg-surface-1 p-1"
          >
            {PESTEL_DIMENSIONS.map((dimension) => {
              const active = selected.includes(dimension.key);
              return (
                <button
                  key={dimension.key}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => toggle(dimension.key)}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-ink transition-colors duration-150 hover:bg-surface-1"
                >
                  <span
                    aria-hidden
                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                      active ? "border-transparent bg-ink text-canvas" : "border-hairline-strong"
                    }`}
                  >
                    {active && (
                      <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={2.4}>
                        <path d="m3 8.5 3.5 3.5L13 5" />
                      </svg>
                    )}
                  </span>
                  <span className="w-3 shrink-0 text-xs font-semibold text-ink-tertiary">
                    {dimension.letter}
                  </span>
                  {dimension.label}
                </button>
              );
            })}

            <div className="mt-1 flex items-center justify-between border-t border-hairline px-2 pt-1.5">
              <button
                type="button"
                onClick={() => onChange([])}
                disabled={selected.length === 0}
                className="text-xs text-ink-subtle underline-offset-2 hover:text-ink hover:underline disabled:opacity-40 disabled:no-underline"
              >
                Limpiar
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-xs font-medium text-ink-subtle hover:text-ink"
              >
                Listo
              </button>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
