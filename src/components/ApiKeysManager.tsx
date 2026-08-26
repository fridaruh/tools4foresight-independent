"use client";

import { useEffect, useState } from "react";

/**
 * Gestor de claves de API para conectar un agente (Claude Code, Claude
 * Desktop, Cursor…) al servidor MCP de tools4foresight. Contrato en
 * src/app/api/perfil/api-keys/route.ts: GET lista, POST crea (devuelve el
 * texto plano UNA sola vez), DELETE revoca.
 *
 * Se autoabastece con su propio `useEffect` en vez de recibir la lista como
 * prop desde `/perfil` (server component): el mismo patrón que ya usan
 * `LikedItemsBoard` y `UserMenu` en este repo, y aquí evita que la carga de
 * `/perfil` dependa de una tabla que no es tenant.
 */

const INPUT_CLASS =
  "border border-hairline bg-canvas px-3 py-2 text-sm text-ink outline-none focus-visible:border-ink";
const BUTTON_CLASS =
  "label-mono self-start border border-ink bg-ink px-3 py-2 text-brand-white transition-colors duration-150 hover:border-brand-orange hover:bg-brand-orange disabled:opacity-50";

const MAX_ACTIVE_KEYS = 10;

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-hairline bg-surface-1 p-4">
      <h2 className="label-mono text-ink-tertiary">{title}</h2>
      {children}
    </section>
  );
}

type ApiKeySummary = {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
};

type RevealedKey = {
  id: string;
  name: string;
  prefix: string;
  plaintext: string;
  createdAt: string;
};

type ListState =
  | { kind: "loading" }
  | { kind: "ready"; keys: ApiKeySummary[] }
  | { kind: "error"; note: string };

type CreateStatus = { kind: "idle" } | { kind: "saving" } | { kind: "error"; note: string };

function formatFecha(iso: string): string {
  return new Date(iso).toLocaleString("es-MX");
}

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

/** Trae la lista sin tocar estado: la usan tanto el efecto de montaje como el
 * botón de reintentar, cada uno decide cuándo pisar `list` con el resultado. */
async function fetchKeysList(): Promise<ListState> {
  try {
    const data = await callApi("/api/perfil/api-keys");
    return { kind: "ready", keys: (data.keys as ApiKeySummary[] | undefined) ?? [] };
  } catch (err) {
    return {
      kind: "error",
      note: err instanceof Error ? err.message : "No se pudieron cargar tus claves",
    };
  }
}

export function ApiKeysManager() {
  const [list, setList] = useState<ListState>({ kind: "loading" });

  const [name, setName] = useState("");
  const [createStatus, setCreateStatus] = useState<CreateStatus>({ kind: "idle" });

  // La clave en texto plano solo vive en este estado: no se guarda en ningún
  // lado y desaparece al recargar la página. Es la única vez que existe.
  const [revealed, setRevealed] = useState<RevealedKey | null>(null);
  const [copied, setCopied] = useState(false);

  // Revocar es de dos pasos, igual que el borrado de fila en CategoryEditor:
  // el primer click en "Revocar" arma la confirmación, el segundo la ejecuta.
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchKeysList().then((result) => {
      if (!cancelled) setList(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function retryLoad() {
    setList({ kind: "loading" });
    setList(await fetchKeysList());
  }

  async function createKey(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setCreateStatus({ kind: "saving" });
    setCopied(false);
    try {
      const data = await callApi("/api/perfil/api-keys", {
        method: "POST",
        body: JSON.stringify({ name: name.trim() }),
      });
      const key = data.key as RevealedKey;
      setRevealed(key);
      setName("");
      setCreateStatus({ kind: "idle" });
      // Se agrega a mano a la lista ya cargada: no vale la pena otro roundtrip
      // solo para traer de vuelta la fila que acabamos de crear.
      setList((prev) =>
        prev.kind === "ready"
          ? {
              kind: "ready",
              keys: [
                {
                  id: key.id,
                  name: key.name,
                  prefix: key.prefix,
                  createdAt: key.createdAt,
                  lastUsedAt: null,
                },
                ...prev.keys,
              ],
            }
          : prev,
      );
    } catch (err) {
      setCreateStatus({
        kind: "error",
        note: err instanceof Error ? err.message : "No se pudo crear la clave",
      });
    }
  }

  async function copyPlaintext() {
    if (!revealed) return;
    try {
      await navigator.clipboard.writeText(revealed.plaintext);
      setCopied(true);
    } catch {
      // Sin permiso de portapapeles (o navegador sin API): la clave sigue
      // visible en pantalla para copiarla a mano, así que no es un error duro.
      setCopied(false);
    }
  }

  async function confirmRevoke(id: string) {
    if (confirmingId !== id) {
      setConfirmingId(id);
      setRevokeError(null);
      return;
    }
    setBusyId(id);
    setRevokeError(null);
    try {
      await callApi(`/api/perfil/api-keys?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      setList((prev) =>
        prev.kind === "ready" ? { kind: "ready", keys: prev.keys.filter((k) => k.id !== id) } : prev,
      );
      if (revealed?.id === id) setRevealed(null);
      setConfirmingId(null);
    } catch (err) {
      setRevokeError(err instanceof Error ? err.message : "No se pudo revocar la clave");
    } finally {
      setBusyId(null);
    }
  }

  const activeCount = list.kind === "ready" ? list.keys.length : null;
  const atLimit = activeCount !== null && activeCount >= MAX_ACTIVE_KEYS;

  return (
    <div className="flex flex-col gap-4">
      {revealed && (
        <div className="border border-ink border-l-4 border-l-brand-orange bg-surface-1 p-4 text-sm">
          <p className="label-mono text-brand-orange">status: clave creada — se muestra una sola vez</p>
          <p className="mt-1.5 text-ink">
            Cópiala y guárdala ahora mismo. Por seguridad no queda guardada en ningún lado: si cierras
            esta ventana sin copiarla, tendrás que crear una clave nueva.
          </p>
          <code className="mt-2 block break-all border border-hairline bg-canvas px-3 py-2 text-sm text-ink">
            {revealed.plaintext}
          </code>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button type="button" onClick={copyPlaintext} className={BUTTON_CLASS}>
              {copied ? "Copiada" : "Copiar"}
            </button>
            <button
              type="button"
              onClick={() => setRevealed(null)}
              className="text-xs text-ink-subtle underline-offset-2 hover:text-ink hover:underline"
            >
              Ya la guardé, cerrar
            </button>
          </div>
        </div>
      )}

      <Card title={`Tus claves${activeCount !== null ? ` (${activeCount}/${MAX_ACTIVE_KEYS})` : ""}`}>
        {list.kind === "loading" && <p className="text-sm text-ink-subtle">Cargando…</p>}

        {list.kind === "error" && (
          <div className="flex flex-col items-start gap-2">
            <p className="text-xs text-danger">{list.note}</p>
            <button
              type="button"
              onClick={retryLoad}
              className="text-xs text-ink-subtle underline-offset-2 hover:text-ink hover:underline"
            >
              Reintentar
            </button>
          </div>
        )}

        {list.kind === "ready" && list.keys.length === 0 && (
          <p className="text-sm text-ink-subtle">Todavía no tienes claves.</p>
        )}

        {list.kind === "ready" && list.keys.length > 0 && (
          <ul className="flex flex-col gap-2">
            {list.keys.map((key) => (
              <li key={key.id} className="flex flex-col gap-2 border border-hairline px-3 py-2">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-sm text-ink">{key.name}</span>
                    <span className="label-mono text-ink-tertiary">{key.prefix}…</span>
                    <span className="text-xs text-ink-subtle">
                      Creada el {formatFecha(key.createdAt)} ·{" "}
                      {key.lastUsedAt ? `usada el ${formatFecha(key.lastUsedAt)}` : "sin usar todavía"}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    {confirmingId === key.id && busyId !== key.id && (
                      <button
                        type="button"
                        onClick={() => setConfirmingId(null)}
                        className="text-xs text-ink-subtle underline-offset-2 hover:text-ink hover:underline"
                      >
                        Cancelar
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => confirmRevoke(key.id)}
                      disabled={busyId === key.id}
                      className={`label-mono self-start border px-2 py-1 text-[10px] transition-colors duration-150 disabled:opacity-30 ${
                        confirmingId === key.id
                          ? "border-brand-orange bg-brand-orange text-brand-white"
                          : "border-hairline text-ink-subtle hover:border-ink hover:text-ink"
                      }`}
                    >
                      {busyId === key.id
                        ? "Revocando…"
                        : confirmingId === key.id
                          ? "¿Seguro? Revocar"
                          : "Revocar"}
                    </button>
                  </div>
                </div>
                {confirmingId === key.id && (
                  <p className="text-xs text-danger">
                    Los agentes que estén usando esta clave dejan de funcionar de inmediato. No se puede
                    deshacer.
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}

        {revokeError && <p className="text-xs text-danger">{revokeError}</p>}
      </Card>

      <Card title="Crear clave nueva">
        <form onSubmit={createKey} className="flex flex-col gap-3">
          <input
            type="text"
            required
            placeholder="mi laptop, Claude Desktop…"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={atLimit}
            className={INPUT_CLASS}
          />
          <button type="submit" disabled={createStatus.kind === "saving" || atLimit} className={BUTTON_CLASS}>
            {createStatus.kind === "saving" ? "Creando…" : "Crear clave"}
          </button>
          {atLimit && (
            <p className="text-xs text-ink-tertiary">
              Llegaste al máximo de {MAX_ACTIVE_KEYS} claves activas. Revoca alguna para crear otra.
            </p>
          )}
          {createStatus.kind === "error" && <p className="text-xs text-danger">{createStatus.note}</p>}
        </form>
      </Card>
    </div>
  );
}
