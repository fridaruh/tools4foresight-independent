"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * CRUD de categorías del tenant (PLAN 4.3): distribución, propuestas del
 * modelo, catálogo editable (nombre/descripción/ejemplos/orden/fallback) y el
 * botón de re-categorización masiva. Cada mutación pega a `/api/categories*` y
 * termina en `router.refresh()`: el server component de `/categorias` vuelve a
 * leer con `withOwner` y este componente recibe props frescas — no hay estado
 * propio de "lista de categorías" fuera de lo que se está editando.
 */

export type CategoryDTO = {
  id: string;
  name: string;
  description: string;
  examples: string[];
  position: number;
  isFallback: boolean;
};

export type DistributionRow = { id: string; name: string; count: number };
export type ProposedCategory = { name: string; count: number };

type Props = {
  categories: CategoryDTO[];
  distribution: DistributionRow[];
  proposed: ProposedCategory[];
  uncategorized: number;
};

async function callApi(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(typeof data.error === "string" ? data.error : "Algo falló");
  }
  return data;
}

type Draft = { name: string; description: string; examples: string };

export function CategoryEditor({ categories, distribution, proposed, uncategorized }: Props) {
  const router = useRouter();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);
  const [newCat, setNewCat] = useState<Draft>({ name: "", description: "", examples: "" });
  const [creatingBusy, setCreatingBusy] = useState(false);

  const [recategorizeStep, setRecategorizeStep] = useState<0 | 1>(0);
  const [recategorizing, setRecategorizing] = useState(false);
  const [recategorizeMsg, setRecategorizeMsg] = useState<string | null>(null);

  const sortedCategories = [...categories].sort((a, b) => a.position - b.position);
  const countById = new Map(distribution.map((d) => [d.id, d.count]));
  const maxCount = Math.max(1, uncategorized, ...distribution.map((d) => d.count));

  function startEdit(cat: CategoryDTO) {
    setEditingId(cat.id);
    setDraft({ name: cat.name, description: cat.description, examples: cat.examples.join("\n") });
    setError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setDraft(null);
  }

  function examplesFrom(text: string): string[] {
    return text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  async function saveEdit(id: string) {
    if (!draft) return;
    setBusyId(id);
    setError(null);
    try {
      await callApi(`/api/categories/${id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: draft.name,
          description: draft.description,
          examples: examplesFrom(draft.examples),
        }),
      });
      setEditingId(null);
      setDraft(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar");
    } finally {
      setBusyId(null);
    }
  }

  async function setFallback(id: string) {
    setBusyId(id);
    setError(null);
    try {
      await callApi(`/api/categories/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ isFallback: true }),
      });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo marcar como fallback");
    } finally {
      setBusyId(null);
    }
  }

  // Sin endpoint de "reorder": mover una fila es intercambiar `position` con su
  // vecina, con dos PATCH. No hay unicidad sobre `position`, así que un swap no
  // puede chocar con nada mientras esté en vuelo.
  async function move(cat: CategoryDTO, direction: "up" | "down") {
    const index = sortedCategories.findIndex((c) => c.id === cat.id);
    const swapIndex = direction === "up" ? index - 1 : index + 1;
    if (swapIndex < 0 || swapIndex >= sortedCategories.length) return;
    const other = sortedCategories[swapIndex];

    setBusyId(cat.id);
    setError(null);
    try {
      await Promise.all([
        callApi(`/api/categories/${cat.id}`, {
          method: "PATCH",
          body: JSON.stringify({ position: other.position }),
        }),
        callApi(`/api/categories/${other.id}`, {
          method: "PATCH",
          body: JSON.stringify({ position: cat.position }),
        }),
      ]);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo reordenar");
    } finally {
      setBusyId(null);
    }
  }

  async function confirmDelete(id: string) {
    if (deletingId !== id) {
      setDeletingId(id);
      return;
    }
    setBusyId(id);
    setError(null);
    try {
      await callApi(`/api/categories/${id}`, { method: "DELETE" });
      setDeletingId(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo borrar");
      setDeletingId(null);
    } finally {
      setBusyId(null);
    }
  }

  async function createCategory() {
    if (!newCat.name.trim()) return;
    setCreatingBusy(true);
    setError(null);
    try {
      await callApi("/api/categories", {
        method: "POST",
        body: JSON.stringify({
          name: newCat.name,
          description: newCat.description,
          examples: examplesFrom(newCat.examples),
        }),
      });
      setNewCat({ name: "", description: "", examples: "" });
      setCreating(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo crear");
    } finally {
      setCreatingBusy(false);
    }
  }

  async function createFromProposed(name: string) {
    setError(null);
    try {
      await callApi("/api/categories", {
        method: "POST",
        body: JSON.stringify({ name, description: "", examples: [] }),
      });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo crear");
    }
  }

  async function runRecategorize() {
    if (recategorizeStep === 0) {
      setRecategorizeStep(1);
      return;
    }
    setRecategorizing(true);
    setRecategorizeMsg(null);
    try {
      const data = await callApi("/api/categories/recategorize", { method: "POST" });
      setRecategorizeMsg(`${data.count} items listos para reclasificar`);
      router.refresh();
    } catch (err) {
      setRecategorizeMsg(err instanceof Error ? err.message : "No se pudo re-categorizar");
    } finally {
      setRecategorizing(false);
      setRecategorizeStep(0);
    }
  }

  return (
    <div className="flex flex-col gap-8">
      {error && (
        <p className="border border-hairline-strong bg-surface-2 px-3 py-2 text-xs text-ink">{error}</p>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="section-heading text-ink">Distribución</h2>
        <ul className="flex flex-col gap-2">
          {sortedCategories.map((cat) => {
            const count = countById.get(cat.id) ?? 0;
            const pct = Math.round((count / maxCount) * 100);
            return (
              <li key={cat.id} className="flex items-center gap-3">
                <span className="label-mono w-40 shrink-0 truncate text-ink-subtle" title={cat.name}>
                  {cat.name}
                </span>
                <div className="h-2 flex-1 bg-surface-2">
                  <div className="h-2 bg-brand-orange" style={{ width: `${pct}%` }} />
                </div>
                <span className="w-10 shrink-0 text-right text-xs tabular-nums text-ink-subtle">
                  {count}
                </span>
              </li>
            );
          })}
          {uncategorized > 0 && (
            <li className="flex items-center gap-3">
              <span className="label-mono w-40 shrink-0 truncate text-ink-tertiary">
                Sin categorizar
              </span>
              <div className="h-2 flex-1 bg-surface-2">
                <div
                  className="h-2 bg-brand-grey"
                  style={{ width: `${Math.round((uncategorized / maxCount) * 100)}%` }}
                />
              </div>
              <span className="w-10 shrink-0 text-right text-xs tabular-nums text-ink-subtle">
                {uncategorized}
              </span>
            </li>
          )}
        </ul>
      </section>

      {proposed.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="section-heading text-ink">Propuestas</h2>
          <p className="text-sm text-ink-subtle">
            Categorías que tienen tus items pero ya no están en el catálogo: las renombraste o las
            borraste después de que el modelo las usara para clasificar.
          </p>
          <ul className="flex flex-col gap-2">
            {proposed.map((p) => (
              <li
                key={p.name}
                className="flex items-center justify-between gap-3 rounded-lg border border-hairline bg-surface-1 px-3 py-2"
              >
                <span className="text-sm text-ink">
                  {p.name} · {p.count}
                </span>
                <button
                  type="button"
                  onClick={() => createFromProposed(p.name)}
                  className="label-mono border border-ink px-2 py-1 text-[10px] text-ink transition-colors duration-150 hover:border-brand-orange hover:text-brand-orange"
                >
                  Crear como categoría
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="section-heading text-ink">Catálogo</h2>
          <button
            type="button"
            onClick={() => setCreating((v) => !v)}
            className="label-mono border border-ink bg-ink px-3 py-1.5 text-brand-white transition-colors duration-150 hover:border-brand-orange hover:bg-brand-orange"
          >
            {creating ? "Cancelar" : "Nueva categoría"}
          </button>
        </div>

        {creating && (
          <div className="flex flex-col gap-2 rounded-xl border border-hairline bg-surface-1 p-4">
            <input
              value={newCat.name}
              onChange={(event) => setNewCat((s) => ({ ...s, name: event.target.value }))}
              placeholder="Nombre"
              className="border border-hairline bg-canvas px-3 py-2 text-sm text-ink outline-none focus:border-hairline-strong"
            />
            <textarea
              value={newCat.description}
              onChange={(event) => setNewCat((s) => ({ ...s, description: event.target.value }))}
              placeholder="Descripción: qué entra aquí. Va literal al prompt del modelo."
              rows={3}
              className="border border-hairline bg-canvas px-3 py-2 text-sm text-ink outline-none focus:border-hairline-strong"
            />
            <textarea
              value={newCat.examples}
              onChange={(event) => setNewCat((s) => ({ ...s, examples: event.target.value }))}
              placeholder="Ejemplos, uno por línea"
              rows={3}
              className="border border-hairline bg-canvas px-3 py-2 font-mono text-xs text-ink outline-none focus:border-hairline-strong"
            />
            <button
              type="button"
              onClick={createCategory}
              disabled={creatingBusy || !newCat.name.trim()}
              className="label-mono self-start border border-ink bg-ink px-3 py-1.5 text-brand-white transition-colors duration-150 hover:border-brand-orange hover:bg-brand-orange disabled:opacity-40"
            >
              {creatingBusy ? "Creando…" : "Crear"}
            </button>
          </div>
        )}

        <ul className="flex flex-col gap-3">
          {sortedCategories.map((cat, index) => {
            const isEditing = editingId === cat.id;
            const isBusy = busyId === cat.id;
            return (
              <li key={cat.id} className="rounded-xl border border-hairline bg-surface-1 p-4">
                {isEditing && draft ? (
                  <div className="flex flex-col gap-2">
                    <input
                      value={draft.name}
                      onChange={(event) =>
                        setDraft((d) => (d ? { ...d, name: event.target.value } : d))
                      }
                      className="border border-hairline bg-canvas px-3 py-2 text-sm font-medium text-ink outline-none focus:border-hairline-strong"
                    />
                    <textarea
                      value={draft.description}
                      onChange={(event) =>
                        setDraft((d) => (d ? { ...d, description: event.target.value } : d))
                      }
                      rows={3}
                      className="border border-hairline bg-canvas px-3 py-2 text-sm text-ink outline-none focus:border-hairline-strong"
                    />
                    <textarea
                      value={draft.examples}
                      onChange={(event) =>
                        setDraft((d) => (d ? { ...d, examples: event.target.value } : d))
                      }
                      rows={3}
                      placeholder="Ejemplos, uno por línea"
                      className="border border-hairline bg-canvas px-3 py-2 font-mono text-xs text-ink outline-none focus:border-hairline-strong"
                    />
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => saveEdit(cat.id)}
                        disabled={isBusy}
                        className="label-mono border border-ink bg-ink px-3 py-1.5 text-brand-white transition-colors duration-150 hover:border-brand-orange hover:bg-brand-orange disabled:opacity-40"
                      >
                        {isBusy ? "Guardando…" : "Guardar"}
                      </button>
                      <button
                        type="button"
                        onClick={cancelEdit}
                        disabled={isBusy}
                        className="text-xs text-ink-subtle underline-offset-2 hover:text-ink hover:underline disabled:opacity-40"
                      >
                        Cancelar
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium text-ink">{cat.name}</p>
                        {cat.isFallback && (
                          <span className="label-mono border border-hairline-strong px-1.5 py-0.5 text-[10px] text-ink-subtle">
                            fallback
                          </span>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-1">
                        <button
                          type="button"
                          onClick={() => move(cat, "up")}
                          disabled={isBusy || index === 0}
                          aria-label="Subir"
                          className="border border-hairline px-2 py-1 text-xs text-ink-subtle hover:border-ink hover:text-ink disabled:opacity-30"
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          onClick={() => move(cat, "down")}
                          disabled={isBusy || index === sortedCategories.length - 1}
                          aria-label="Bajar"
                          className="border border-hairline px-2 py-1 text-xs text-ink-subtle hover:border-ink hover:text-ink disabled:opacity-30"
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          onClick={() => startEdit(cat)}
                          disabled={isBusy}
                          className="label-mono border border-hairline px-2 py-1 text-[10px] text-ink-subtle hover:border-ink hover:text-ink disabled:opacity-30"
                        >
                          Editar
                        </button>
                        {!cat.isFallback && (
                          <button
                            type="button"
                            onClick={() => setFallback(cat.id)}
                            disabled={isBusy}
                            className="label-mono border border-hairline px-2 py-1 text-[10px] text-ink-subtle hover:border-ink hover:text-ink disabled:opacity-30"
                          >
                            Marcar fallback
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => confirmDelete(cat.id)}
                          disabled={isBusy || cat.isFallback}
                          title={cat.isFallback ? "No se puede borrar la categoría de fallback" : undefined}
                          className={`label-mono border px-2 py-1 text-[10px] transition-colors duration-150 disabled:opacity-30 ${
                            deletingId === cat.id
                              ? "border-brand-orange bg-brand-orange text-brand-white"
                              : "border-hairline text-ink-subtle hover:border-ink hover:text-ink"
                          }`}
                        >
                          {deletingId === cat.id ? "¿Seguro? Borrar" : "Borrar"}
                        </button>
                      </div>
                    </div>
                    <p className="text-sm text-ink-subtle">{cat.description || "Sin descripción."}</p>
                    {cat.examples.length > 0 && (
                      <ul className="flex flex-col gap-0.5">
                        {cat.examples.map((example, exampleIndex) => (
                          <li key={exampleIndex} className="text-xs text-ink-tertiary">
                            · {example}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <section className="flex flex-col gap-3 border border-hairline-strong bg-surface-1 p-4">
        <h2 className="section-heading text-ink">Re-categorizar todo (auto)</h2>
        <p className="text-sm text-ink-subtle">
          Borra la categoría de todo lo que clasificó el modelo automáticamente — respeta lo que
          corregiste a mano — para que la siguiente corrida del job de categorización (el cron de las
          07:00 UTC o el botón manual en Sistema) lo vuelva a clasificar contra el catálogo actual.
          Útil después de renombrar, agregar o borrar categorías.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={runRecategorize}
            disabled={recategorizing}
            className={`label-mono border px-3 py-1.5 transition-colors duration-150 disabled:opacity-40 ${
              recategorizeStep === 1
                ? "border-brand-orange bg-brand-orange text-brand-white"
                : "border-ink bg-ink text-brand-white hover:border-brand-orange hover:bg-brand-orange"
            }`}
          >
            {recategorizing
              ? "Re-categorizando…"
              : recategorizeStep === 1
                ? "¿Seguro? Confirmar"
                : "Re-categorizar todo (auto)"}
          </button>
          {recategorizeStep === 1 && !recategorizing && (
            <button
              type="button"
              onClick={() => setRecategorizeStep(0)}
              className="text-xs text-ink-subtle underline-offset-2 hover:text-ink hover:underline"
            >
              Cancelar
            </button>
          )}
          {recategorizeMsg && <span className="label-mono text-ink-subtle">{recategorizeMsg}</span>}
        </div>
      </section>
    </div>
  );
}
