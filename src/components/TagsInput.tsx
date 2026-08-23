"use client";

import { useState } from "react";

function normalizeTag(raw: string): string {
  return raw.trim().toLowerCase().replace(/^#/, "");
}

/**
 * Input de etiquetas libres (a diferencia de PESTEL, sin catálogo fijo detrás).
 * Escribir y Enter/coma agrega una etiqueta; backspace sobre el input vacío
 * borra la última. El guardado real lo hace el botón "Guardar" de la fila,
 * igual que PESTEL — esto solo edita el draft en memoria.
 */
export function TagsInput({
  value,
  onChange,
}: {
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState("");

  function commit(raw: string) {
    const tag = normalizeTag(raw);
    if (!tag || value.includes(tag)) return;
    onChange([...value, tag]);
  }

  function remove(tag: string) {
    onChange(value.filter((t) => t !== tag));
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      commit(draft);
      setDraft("");
    } else if (event.key === "Backspace" && draft === "" && value.length > 0) {
      remove(value[value.length - 1]);
    }
  }

  function handleBlur() {
    if (draft.trim()) {
      commit(draft);
      setDraft("");
    }
  }

  return (
    <div className="flex w-full flex-wrap items-center gap-1 rounded-md border border-hairline bg-canvas px-2 py-1 focus-within:border-hairline-strong">
      {value.map((tag) => (
        <span
          key={tag}
          className="flex items-center gap-1 rounded bg-surface-2 px-1.5 py-0.5 text-xs text-ink"
        >
          {tag}
          <button
            type="button"
            onClick={() => remove(tag)}
            aria-label={`Quitar etiqueta ${tag}`}
            className="text-ink-tertiary hover:text-ink"
          >
            ×
          </button>
        </span>
      ))}
      <input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        placeholder={value.length === 0 ? "Agregar…" : ""}
        className="min-w-16 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-tertiary"
      />
    </div>
  );
}
