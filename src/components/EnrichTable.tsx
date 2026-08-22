"use client";

import { useState } from "react";
import { CATEGORY_NAMES } from "@/config/categories";
import { authorLabel, isManualItem, type BoardItem } from "@/lib/board-item";
import { formatDate, likedAtTooltip, truncate } from "@/lib/format";
import { PestelSelect } from "@/components/PestelSelect";
import { TweetModal } from "@/components/TweetModal";
import { isPublishable, type PublishStatus } from "@/lib/publish";

export type EnrichRow = {
  id: string;
  category: string | null;
  categorySource: string;
  pestel: string[];
  tldr: string | null;
  whyMatters: string | null;
  impact: string | null;
  foresight: string | null;
  publishStatus: PublishStatus;
  customFields: Record<string, string>;
  /** El item completo, para poder abrir el popup desde esta pantalla. */
  item: BoardItem;
};

const PUBLISH_LABEL: Record<PublishStatus, string> = {
  pending: "Pendiente",
  published: "Publicada",
};

/** Lo que guarda el boton "Guardar" de la fila. La prosa se guarda por celda. */
type Draft = {
  category: string;
  pestel: string[];
  customFields: Record<string, string>;
};

function toDraft(row: EnrichRow): Draft {
  return {
    category: row.category ?? "",
    pestel: [...row.pestel],
    customFields: { ...row.customFields },
  };
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value) => b.includes(value));
}

function isDirty(row: EnrichRow, draft: Draft): boolean {
  if (draft.category !== (row.category ?? "")) return true;
  if (!sameSet(draft.pestel, row.pestel)) return true;
  const keys = new Set([...Object.keys(row.customFields), ...Object.keys(draft.customFields)]);
  for (const key of keys) {
    if ((draft.customFields[key] ?? "") !== (row.customFields[key] ?? "")) return true;
  }
  return false;
}

/**
 * Celda de texto generado por el modelo (Impacto y "¿Por qué importa?").
 *
 * Se lee como texto y entra en edicion con doble click, no con un click: un click
 * suelto sobre la fila abre el popup del tweet, y en una tabla de 50 filas es facil
 * rozar una celda sin querer.
 */
function ProseCell({
  value,
  placeholder,
  onSave,
}: {
  value: string | null;
  placeholder: string;
  onSave: (next: string | null) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);

  function startEditing() {
    setDraft(value ?? "");
    setError(false);
    setEditing(true);
  }

  async function save() {
    setSaving(true);
    setError(false);
    const ok = await onSave(draft.trim() || null);
    setSaving(false);
    if (ok) setEditing(false);
    else setError(true);
  }

  if (!editing) {
    return (
      <div
        onDoubleClick={startEditing}
        title="Doble click para editar"
        className="max-h-32 cursor-text overflow-y-auto rounded-md px-1 py-0.5 text-sm leading-relaxed text-ink hover:bg-surface-1"
      >
        {value ? (
          <p className="whitespace-pre-wrap">{value}</p>
        ) : (
          <span className="text-ink-tertiary">{placeholder}</span>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-start gap-1.5">
      <textarea
        autoFocus
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setEditing(false);
        }}
        rows={6}
        className="flex-1 resize-y rounded-md border border-hairline bg-canvas px-2 py-1 text-sm leading-relaxed text-ink outline-none focus:border-hairline-strong"
      />
      {/* Los dos botoncitos a la derecha mientras se edita: guardar y cancelar. */}
      <div className="flex shrink-0 flex-col gap-1">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          aria-label="Guardar"
          title="Guardar"
          className="rounded-md border border-hairline bg-surface-1 p-1.5 text-ink transition-colors duration-150 hover:bg-surface-2 disabled:opacity-40"
        >
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={1.8}>
            <path d="m3 8.5 3.5 3.5L13 5" />
          </svg>
        </button>
        <button
          type="button"
          onClick={() => setEditing(false)}
          disabled={saving}
          aria-label="Cancelar"
          title="Cancelar"
          className="rounded-md border border-hairline bg-surface-1 p-1.5 text-ink-subtle transition-colors duration-150 hover:bg-surface-2 hover:text-ink disabled:opacity-40"
        >
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={1.8}>
            <path d="m4 4 8 8M12 4l-8 8" />
          </svg>
        </button>
        {error && <span className="text-[10px] text-danger">No se guardó</span>}
      </div>
    </div>
  );
}

/** Fila recien creada desde el formulario de enlaces, antes de procesarla. */
function blankRow(item: BoardItem): EnrichRow {
  return {
    id: item.id,
    category: item.category,
    categorySource: item.categorySource,
    pestel: [],
    tldr: null,
    whyMatters: null,
    impact: null,
    foresight: null,
    publishStatus: "pending",
    customFields: {},
    item,
  };
}

export function EnrichTable({
  rows,
  columns,
  categories,
  discardedView = false,
  initialPublishFilter = "pending",
}: {
  rows: EnrichRow[];
  columns: string[];
  categories: string[];
  /** La pantalla esta mostrando los descartados: el boton devuelve en vez de sacar. */
  discardedView?: boolean;
  /** Estado editorial que esta filtrando la vista actual (ver estadoHref en la pagina). */
  initialPublishFilter?: PublishStatus;
}) {
  // El orden se lleva aparte de `saved` porque la tabla ya no es solo lo que vino del
  // servidor: un enlace agregado a mano entra hasta arriba y un descarte saca la fila
  // sin recargar la pagina.
  const [order, setOrder] = useState<string[]>(rows.map((r) => r.id));
  const [saved, setSaved] = useState<Record<string, EnrichRow>>(
    Object.fromEntries(rows.map((r) => [r.id, r])),
  );
  const [drafts, setDrafts] = useState<Record<string, Draft>>(
    Object.fromEntries(rows.map((r) => [r.id, toDraft(r)])),
  );
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [flash, setFlash] = useState<Record<string, string>>({});
  const [processing, setProcessing] = useState<Record<string, boolean>>({});
  const fields = columns;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [linkUrl, setLinkUrl] = useState("");
  const [addingLink, setAddingLink] = useState(false);
  const [linkError, setLinkError] = useState("");
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [bulkPublishing, setBulkPublishing] = useState(false);

  // Guardado explicito por fila (decision de Frida, PLAN seccion 6): editar no
  // persiste nada hasta que se presiona Guardar. Impacto y "por que importa" son la
  // excepcion: se guardan por celda, con sus propios botones.
  function edit(id: string, patch: Partial<Draft>) {
    setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }

  function editCustom(id: string, fieldKey: string, value: string) {
    setDrafts((prev) => ({
      ...prev,
      [id]: { ...prev[id], customFields: { ...prev[id].customFields, [fieldKey]: value } },
    }));
  }

  async function patchRow(id: string, body: Record<string, unknown>): Promise<boolean> {
    const res = await fetch(`/api/liked-items/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.ok;
  }

  async function save(id: string) {
    const draft = drafts[id];
    setSaving((prev) => ({ ...prev, [id]: true }));
    try {
      const ok = await patchRow(id, {
        category: draft.category || null,
        pestel: draft.pestel,
        customFields: draft.customFields,
      });
      if (!ok) throw new Error("save failed");

      setSaved((prev) => ({
        ...prev,
        [id]: {
          ...prev[id],
          category: draft.category || null,
          categorySource: "manual",
          pestel: [...draft.pestel],
          customFields: { ...draft.customFields },
        },
      }));
      setFlash((prev) => ({ ...prev, [id]: "Guardado" }));
    } catch {
      setFlash((prev) => ({ ...prev, [id]: "No se pudo guardar" }));
    } finally {
      setSaving((prev) => ({ ...prev, [id]: false }));
      setTimeout(() => setFlash((prev) => ({ ...prev, [id]: "" })), 2500);
    }
  }

  /** Guarda una sola celda de prosa y refleja el valor nuevo sin recargar la tabla. */
  async function saveProse(
    id: string,
    field: "tldr" | "impact" | "whyMatters" | "foresight",
    value: string | null,
  ): Promise<boolean> {
    const ok = await patchRow(id, { [field]: value });
    if (ok) setSaved((prev) => ({ ...prev, [id]: { ...prev[id], [field]: value } }));
    return ok;
  }

  /**
   * Saca la fila de esta tabla (o la devuelve, en la vista de descartados). El item no
   * se borra: sigue en el catalogo con todo lo que ya tenia. Es tambien el boton para
   * "no relevante" — un solo botón, una sola lista de excluidos (unificado a pedido
   * de Frida, 2026-08-09; antes "no relevante" era un estado aparte).
   */
  async function toggleDiscard(id: string) {
    setSaving((prev) => ({ ...prev, [id]: true }));
    const ok = await patchRow(id, { enrichDiscarded: !discardedView });
    setSaving((prev) => ({ ...prev, [id]: false }));

    if (!ok) {
      setFlash((prev) => ({ ...prev, [id]: "No se pudo" }));
      setTimeout(() => setFlash((prev) => ({ ...prev, [id]: "" })), 2500);
      return;
    }
    // Se quita de la lista en vez de recargar: recargar perderia lo que haya editado
    // sin guardar en las demas filas.
    setOrder((prev) => prev.filter((rowId) => rowId !== id));
  }

  /**
   * Cambia el estado editorial de una fila (Fase 2: pendiente / publicada / no
   * relevante). La vista actual es un filtro por estado en el servidor, asi que un
   * cambio que saca al item del estado que se esta viendo lo quita de la lista, igual
   * que al descartar.
   */
  async function setPublishStatus(id: string, next: PublishStatus) {
    setSaving((prev) => ({ ...prev, [id]: true }));
    const res = await fetch(`/api/liked-items/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ publishStatus: next }),
    });
    setSaving((prev) => ({ ...prev, [id]: false }));

    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      setFlash((prev) => ({ ...prev, [id]: data?.error ?? "No se pudo" }));
      setTimeout(() => setFlash((prev) => ({ ...prev, [id]: "" })), 4000);
      return;
    }

    setSaved((prev) => ({ ...prev, [id]: { ...prev[id], publishStatus: next } }));
    // En la vista de descartados no se filtra por estado editorial (ver EnrichPage),
    // asi que ahi el cambio no debe hacer desaparecer la fila.
    if (!discardedView && next !== initialPublishFilter) {
      setOrder((prev) => prev.filter((rowId) => rowId !== id));
    }
  }

  /** Publica todo lo seleccionado que ya cumple la regla de publicabilidad. */
  async function publishSelected() {
    const ids = Object.entries(checked)
      .filter(([, isChecked]) => isChecked)
      .map(([id]) => id);
    if (ids.length === 0) return;

    setBulkPublishing(true);
    try {
      const results = await Promise.all(ids.map((id) => setPublishStatus(id, "published")));
      void results;
    } finally {
      setChecked({});
      setBulkPublishing(false);
    }
  }

  /**
   * Corre la cadena completa (contenido + categoria + impacto + por que importa) sobre
   * una fila. Tarda hasta un par de minutos porque son tres llamadas al modelo.
   */
  async function processRow(id: string) {
    setProcessing((prev) => ({ ...prev, [id]: true }));
    try {
      const res = await fetch(`/api/liked-items/${id}/process`, { method: "POST" });
      const data = (await res.json()) as {
        item?: BoardItem;
        tldr?: string | null;
        impact?: string | null;
        whyMatters?: string | null;
        foresight?: string | null;
        pestel?: string[];
        errors?: string[];
      };

      if (res.ok && data.item) {
        const item = data.item;
        const pestel = data.pestel ?? saved[id]?.pestel ?? [];
        setSaved((prev) => ({
          ...prev,
          [id]: {
            ...prev[id],
            item,
            category: item.category,
            categorySource: item.categorySource,
            tldr: data.tldr ?? null,
            impact: data.impact ?? null,
            whyMatters: data.whyMatters ?? null,
            foresight: data.foresight ?? null,
            pestel,
          },
        }));
        // El draft de categoria y PESTEL tambien, o los controles seguirian mostrando
        // el valor viejo y el boton Guardar aparecería sucio sin que nadie tocara nada.
        setDrafts((prev) => ({
          ...prev,
          [id]: { ...prev[id], category: item.category ?? "", pestel: [...pestel] },
        }));
      }

      if (data.errors?.length) {
        setFlash((prev) => ({ ...prev, [id]: data.errors![0] }));
        setTimeout(() => setFlash((prev) => ({ ...prev, [id]: "" })), 6000);
      }
    } catch {
      setFlash((prev) => ({ ...prev, [id]: "No se pudo procesar" }));
      setTimeout(() => setFlash((prev) => ({ ...prev, [id]: "" })), 6000);
    } finally {
      setProcessing((prev) => ({ ...prev, [id]: false }));
    }
  }

  async function addLink() {
    const url = linkUrl.trim();
    if (!url) return;

    setAddingLink(true);
    setLinkError("");
    try {
      const res = await fetch("/api/liked-items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = (await res.json()) as { item?: BoardItem; error?: string };

      if (!res.ok || !data.item) {
        setLinkError(data.error ?? "No se pudo agregar el enlace.");
        return;
      }

      // La fila aparece de inmediato, vacia, y se va llenando cuando termine el
      // procesamiento: esperar 2 minutos con el formulario colgado seria peor.
      const row = blankRow(data.item);
      setSaved((prev) => ({ ...prev, [row.id]: row }));
      setDrafts((prev) => ({ ...prev, [row.id]: toDraft(row) }));
      setOrder((prev) => [row.id, ...prev]);
      setLinkUrl("");
      void processRow(row.id);
    } catch {
      setLinkError("No se pudo agregar el enlace.");
    } finally {
      setAddingLink(false);
    }
  }


  const options = [...new Set([...CATEGORY_NAMES, ...categories])];

  return (
    <div className="flex flex-col gap-4">
      {/* Agregar un enlace que no viene de X. Vive aqui y no en la pantalla de likes
          porque lo que se quiere ver enseguida es su fila enriquecida; el item entra
          al catalogo igual. */}
      {!discardedView && (
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="url"
              value={linkUrl}
              onChange={(event) => {
                setLinkUrl(event.target.value);
                if (linkError) setLinkError("");
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") addLink();
              }}
              placeholder="Pega un enlace para agregarlo a mano"
              className="min-w-0 flex-1 rounded-md border border-hairline bg-canvas px-3 py-1.5 text-sm text-ink outline-none placeholder:text-ink-tertiary focus:border-hairline-strong sm:min-w-72"
            />
            <button
              type="button"
              onClick={addLink}
              disabled={addingLink || !linkUrl.trim()}
              className="label-mono border border-ink bg-ink px-3 py-2 text-brand-white transition-colors duration-150 hover:border-brand-orange hover:bg-brand-orange disabled:opacity-50"
            >
              {addingLink ? "Agregando…" : "+ Agregar enlace"}
            </button>
          </div>
          {linkError && <p className="text-xs text-danger">{linkError}</p>}
        </div>
      )}

      {!discardedView && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <button
            type="button"
            onClick={publishSelected}
            disabled={bulkPublishing || Object.values(checked).every((v) => !v)}
            className="label-mono border border-hairline bg-surface-1 px-3 py-1.5 text-ink transition-colors duration-150 hover:border-ink disabled:opacity-40"
          >
            {bulkPublishing ? "Publicando…" : "Publicar seleccionados"}
          </button>
          <span className="text-xs text-ink-tertiary">
            Solo publica las que ya tienen categoría, impacto y «por qué importa».
          </span>
        </div>
      )}

      {order.length === 0 && (
        <p className="rounded-xl border border-dashed border-hairline-strong py-16 text-center text-sm text-ink-subtle">
          No hay items en esta página.
        </p>
      )}

      {/* Movil: las mismas filas como fichas apiladas. La tabla exige ~1400px de
          columnas y en un telefono solo se alcanzaba a ver el checkbox y el TL;DR;
          editar prosa scrolleando horizontal era inusable. Misma logica y mismos
          handlers: solo cambia el acomodo. */}
      <div className={order.length === 0 ? "hidden" : "flex flex-col gap-4 md:hidden"}>
        {order.map((id) => {
          const current = saved[id];
          const draft = drafts[id];
          const dirty = isDirty(current, draft);
          const item = current.item;

          return (
            <article key={id} className="border border-hairline bg-surface-1">
              <div className="flex items-start gap-3 border-b border-hairline px-3 py-2.5">
                {!discardedView && (
                  <input
                    type="checkbox"
                    checked={!!checked[id]}
                    onChange={(event) =>
                      setChecked((prev) => ({ ...prev, [id]: event.target.checked }))
                    }
                    aria-label="Seleccionar fila"
                    className="mt-1"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <button
                    type="button"
                    onClick={() => setSelectedId(id)}
                    className="text-left text-sm text-ink hover:underline"
                  >
                    {item.contentTitle ?? truncate(item.tweetText, 120)}
                  </button>
                  <p className="mt-0.5 text-xs text-ink-tertiary">
                    {authorLabel(item)} ·{" "}
                    <span title={likedAtTooltip(item.likedAt, item.likedAtSource)}>
                      {isManualItem(item) ? "+ " : "♥ ~"}
                      {formatDate(item.likedAt)}
                    </span>
                  </p>
                  {processing[id] && (
                    <p className="mt-1 text-xs text-ink-subtle">
                      Leyendo el enlace, clasificando y analizando… (tarda un par de minutos)
                    </p>
                  )}
                </div>
              </div>

              <div className="flex flex-col gap-3 px-3 py-3">
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <p className="label-mono mb-1 text-[10px] text-ink-tertiary">Categoría</p>
                    <select
                      value={draft.category}
                      onChange={(event) => edit(id, { category: event.target.value })}
                      className="w-full rounded-md border border-hairline bg-canvas px-2 py-1 text-sm text-ink outline-none focus:border-hairline-strong"
                    >
                      <option value="">Sin categorizar</option>
                      {options.map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                    </select>
                    {current.categorySource === "manual" && (
                      <p className="mt-0.5 text-[10px] text-ink-tertiary">editada a mano</p>
                    )}
                  </div>
                  <div>
                    <p className="label-mono mb-1 text-[10px] text-ink-tertiary">PESTEL</p>
                    <PestelSelect
                      selected={draft.pestel}
                      onChange={(pestel) => edit(id, { pestel })}
                    />
                  </div>
                </div>

                <div>
                  <p className="label-mono mb-1 text-[10px] text-ink-tertiary">TL;DR</p>
                  <ProseCell
                    value={current.tldr}
                    placeholder="Sin generar"
                    onSave={(value) => saveProse(id, "tldr", value)}
                  />
                </div>
                <div>
                  <p className="label-mono mb-1 text-[10px] text-ink-tertiary">¿Por qué importa?</p>
                  <ProseCell
                    value={current.whyMatters}
                    placeholder="Sin generar"
                    onSave={(value) => saveProse(id, "whyMatters", value)}
                  />
                </div>
                <div>
                  <p className="label-mono mb-1 text-[10px] text-ink-tertiary">Impacto</p>
                  <ProseCell
                    value={current.impact}
                    placeholder="Sin generar"
                    onSave={(value) => saveProse(id, "impact", value)}
                  />
                </div>
                <div>
                  <p className="label-mono mb-1 text-[10px] text-ink-tertiary">Foresight</p>
                  <ProseCell
                    value={current.foresight}
                    placeholder="Sin generar"
                    onSave={(value) => saveProse(id, "foresight", value)}
                  />
                </div>

                {fields.map((field) => (
                  <div key={field}>
                    <p className="label-mono mb-1 text-[10px] text-ink-tertiary">{field}</p>
                    <input
                      value={draft.customFields[field] ?? ""}
                      onChange={(event) => editCustom(id, field, event.target.value)}
                      className="w-full rounded-md border border-hairline bg-canvas px-2 py-1 text-sm text-ink outline-none focus:border-hairline-strong"
                    />
                  </div>
                ))}
              </div>

              <div className="flex flex-wrap items-center gap-2 border-t border-hairline px-3 py-2.5">
                <span className="label-mono text-[10px] text-ink-tertiary">
                  {PUBLISH_LABEL[current.publishStatus]}
                </span>
                {flash[id] && <span className="text-[10px] text-ink-tertiary">{flash[id]}</span>}
                <div className="ml-auto flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => toggleDiscard(id)}
                    disabled={saving[id]}
                    className="rounded-md px-2 py-1.5 text-[11px] text-ink-tertiary transition-colors duration-150 hover:bg-surface-2 hover:text-ink disabled:opacity-40"
                  >
                    {discardedView ? "Restaurar" : "Descartar"}
                  </button>
                  {current.publishStatus !== "published" && (
                    <button
                      type="button"
                      onClick={() => setPublishStatus(id, "published")}
                      disabled={
                        saving[id] ||
                        !isPublishable({
                          category: current.category,
                          impact: current.impact,
                          whyMatters: current.whyMatters,
                        })
                      }
                      className="rounded-md px-2 py-1.5 text-[11px] text-ink-tertiary transition-colors duration-150 hover:bg-surface-2 hover:text-ink disabled:opacity-40"
                    >
                      Publicar
                    </button>
                  )}
                  {current.publishStatus !== "pending" && (
                    <button
                      type="button"
                      onClick={() => setPublishStatus(id, "pending")}
                      disabled={saving[id]}
                      className="rounded-md px-2 py-1.5 text-[11px] text-ink-tertiary transition-colors duration-150 hover:bg-surface-2 hover:text-ink disabled:opacity-40"
                    >
                      Revertir
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => save(id)}
                    disabled={!dirty || saving[id]}
                    className="label-mono border border-hairline bg-surface-1 px-3 py-1.5 text-ink transition-colors duration-150 hover:border-ink disabled:opacity-40"
                  >
                    {saving[id] ? "Guardando…" : "Guardar"}
                  </button>
                </div>
              </div>
            </article>
          );
        })}
      </div>

      <div
        hidden={order.length === 0}
        className="overflow-x-auto rounded-xl border border-hairline max-md:hidden"
      >
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="label-mono border-b border-ink bg-surface-1 text-left text-ink-subtle">
              {!discardedView && (
                <th className="w-8 px-3 py-2 font-medium">
                  <input
                    type="checkbox"
                    checked={order.length > 0 && order.every((id) => checked[id])}
                    onChange={(event) => {
                      const value = event.target.checked;
                      setChecked(Object.fromEntries(order.map((id) => [id, value])));
                    }}
                    aria-label="Seleccionar todos"
                  />
                </th>
              )}
              <th className="min-w-64 px-3 py-2 font-medium">TL;DR</th>
              <th className="min-w-72 px-3 py-2 font-medium">Item</th>
              <th className="w-44 px-3 py-2 font-medium">Categoría</th>
              <th className="w-40 px-3 py-2 font-medium">PESTEL</th>
              <th className="min-w-64 px-3 py-2 font-medium">¿Por qué importa?</th>
              <th className="min-w-64 px-3 py-2 font-medium">Impacto</th>
              <th className="min-w-64 px-3 py-2 font-medium">Foresight</th>
              {fields.map((field) => (
                <th key={field} className="min-w-40 px-3 py-2 font-medium">
                  {field}
                </th>
              ))}
              <th className="w-40 px-3 py-2 font-medium">&nbsp;</th>
            </tr>
          </thead>
          <tbody>
            {order.map((id) => {
              const current = saved[id];
              const draft = drafts[id];
              const dirty = isDirty(current, draft);
              const item = current.item;

              return (
                <tr key={id} className="border-b border-hairline align-top last:border-b-0">
                  {!discardedView && (
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={!!checked[id]}
                        onChange={(event) =>
                          setChecked((prev) => ({ ...prev, [id]: event.target.checked }))
                        }
                        aria-label="Seleccionar fila"
                      />
                    </td>
                  )}
                  <td className="px-3 py-2">
                    <ProseCell
                      value={current.tldr}
                      placeholder="Sin generar"
                      onSave={(value) => saveProse(id, "tldr", value)}
                    />
                  </td>

                  <td className="px-3 py-2">
                    {/* Click en el item abre el popup, para recordar que decia sin
                        salir de la tabla ni perder lo que se este editando. */}
                    <button
                      type="button"
                      onClick={() => setSelectedId(id)}
                      className="text-left text-ink hover:underline"
                    >
                      {item.contentTitle ?? truncate(item.tweetText, 120)}
                    </button>
                    <p className="mt-0.5 text-xs text-ink-tertiary">
                      {authorLabel(item)} ·{" "}
                      <span title={likedAtTooltip(item.likedAt, item.likedAtSource)}>
                        {isManualItem(item) ? "+ " : "♥ ~"}
                        {formatDate(item.likedAt)}
                      </span>
                    </p>
                    {processing[id] && (
                      <p className="mt-1 text-xs text-ink-subtle">
                        Leyendo el enlace, clasificando y analizando… (tarda un par de minutos)
                      </p>
                    )}
                  </td>

                  <td className="px-3 py-2">
                    <select
                      value={draft.category}
                      onChange={(event) => edit(id, { category: event.target.value })}
                      className="w-full rounded-md border border-hairline bg-canvas px-2 py-1 text-sm text-ink outline-none focus:border-hairline-strong"
                    >
                      <option value="">Sin categorizar</option>
                      {options.map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                    </select>
                    {current.categorySource === "manual" && (
                      <p className="mt-0.5 text-[10px] text-ink-tertiary">editada a mano</p>
                    )}
                  </td>

                  <td className="px-3 py-2">
                    <PestelSelect
                      selected={draft.pestel}
                      onChange={(pestel) => edit(id, { pestel })}
                    />
                  </td>

                  <td className="px-3 py-2">
                    <ProseCell
                      value={current.whyMatters}
                      placeholder="Sin generar"
                      onSave={(value) => saveProse(id, "whyMatters", value)}
                    />
                  </td>

                  <td className="px-3 py-2">
                    <ProseCell
                      value={current.impact}
                      placeholder="Sin generar"
                      onSave={(value) => saveProse(id, "impact", value)}
                    />
                  </td>

                  <td className="px-3 py-2">
                    <ProseCell
                      value={current.foresight}
                      placeholder="Sin generar"
                      onSave={(value) => saveProse(id, "foresight", value)}
                    />
                  </td>

                  {fields.map((field) => (
                    <td key={field} className="px-3 py-2">
                      <input
                        value={draft.customFields[field] ?? ""}
                        onChange={(event) => editCustom(id, field, event.target.value)}
                        className="w-full rounded-md border border-hairline bg-canvas px-2 py-1 text-sm text-ink outline-none focus:border-hairline-strong"
                      />
                    </td>
                  ))}

                  <td className="px-3 py-2">
                    <button
                      type="button"
                      onClick={() => save(id)}
                      disabled={!dirty || saving[id]}
                      className="label-mono w-full border border-hairline bg-surface-1 px-2 py-1.5 text-ink transition-colors duration-150 hover:border-ink disabled:opacity-40"
                    >
                      {saving[id] ? "Guardando…" : "Guardar"}
                    </button>
                    <button
                      type="button"
                      onClick={() => toggleDiscard(id)}
                      disabled={saving[id]}
                      title={
                        discardedView
                          ? "Devolver este item a la tabla de enriquecimiento"
                          : "Sacarlo de esta tabla. Sigue en el catálogo."
                      }
                      className="mt-1 w-full rounded-md px-2 py-1 text-[11px] text-ink-tertiary transition-colors duration-150 hover:bg-surface-1 hover:text-ink disabled:opacity-40"
                    >
                      {discardedView ? "Restaurar" : "Descartar"}
                    </button>

                    <p className="label-mono mt-2 text-center text-[10px] text-ink-tertiary">
                      {PUBLISH_LABEL[current.publishStatus]}
                    </p>
                    <div className="mt-1 flex gap-1">
                      {current.publishStatus !== "published" && (
                        <button
                          type="button"
                          onClick={() => setPublishStatus(id, "published")}
                          disabled={
                            saving[id] ||
                            !isPublishable({
                              category: current.category,
                              impact: current.impact,
                              whyMatters: current.whyMatters,
                            })
                          }
                          title="Publicar para los miembros"
                          className="flex-1 rounded-md px-2 py-1 text-[11px] text-ink-tertiary transition-colors duration-150 hover:bg-surface-1 hover:text-ink disabled:opacity-40"
                        >
                          Publicar
                        </button>
                      )}
                      {current.publishStatus !== "pending" && (
                        <button
                          type="button"
                          onClick={() => setPublishStatus(id, "pending")}
                          disabled={saving[id]}
                          title="Volver a pendiente de revisión"
                          className="flex-1 rounded-md px-2 py-1 text-[11px] text-ink-tertiary transition-colors duration-150 hover:bg-surface-1 hover:text-ink disabled:opacity-40"
                        >
                          Revertir
                        </button>
                      )}
                    </div>

                    {flash[id] && (
                      <p className="mt-1 text-center text-[10px] text-ink-tertiary">{flash[id]}</p>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {selectedId && saved[selectedId] && (
        <TweetModal
          item={saved[selectedId].item}
          tldr={saved[selectedId].tldr}
          impact={saved[selectedId].impact}
          whyMatters={saved[selectedId].whyMatters}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}
