"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatLongDate } from "@/lib/format";

const INPUT_CLASS =
  "border border-hairline bg-canvas px-3 py-2 text-sm text-ink outline-none focus-visible:border-ink";
const BUTTON_CLASS =
  "label-mono self-start border border-ink bg-ink px-3 py-2 text-brand-white transition-colors duration-150 hover:border-brand-orange hover:bg-brand-orange disabled:opacity-50";

const MODEL_OPTIONS = [
  { value: "claude-sonnet-5", label: "Claude Sonnet 5 (default)" },
  { value: "claude-opus-5", label: "Claude Opus 5" },
] as const;

export type AnthropicKeyInfo = {
  last4: string | null;
  model: string | null;
  /** ISO string o null. Null = sin key, o key guardada pero que dejó de pasar la verificación. */
  verifiedAt: string | null;
};

/**
 * Ajustes de IA de /conexion (PLAN 4.2): pegar/probar/borrar la API key de
 * Anthropic que usa el job de foresight (BYOK). La key nunca llega de vuelta del
 * server tal cual — `saveAnthropicKey` la verifica y cifra en el mismo POST, así
 * que aquí solo se maneja el `last4` que sí es seguro mostrar.
 */
export function AnthropicKeyForm({ initial }: { initial: AnthropicKeyInfo }) {
  const router = useRouter();
  const hasKey = initial.last4 !== null;
  const [editing, setEditing] = useState(!hasKey);
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(initial.model ?? MODEL_OPTIONS[0].value);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState(initial);

  const staleKey = hasKey && !info.verifiedAt;

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/anthropic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey, model }),
      });
      const data = (await res.json()) as
        | { ok: true; last4: string; model: string; verifiedAt: string }
        | { ok: false; error: string };
      if (!data.ok) {
        setError(data.error);
        return;
      }
      setInfo({ last4: data.last4, model: data.model, verifiedAt: data.verifiedAt });
      setApiKey("");
      setEditing(false);
      router.refresh();
    } catch {
      setError("No se pudo conectar con el servidor");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/anthropic", { method: "DELETE" });
      if (!res.ok) throw new Error();
      setInfo({ last4: null, model: null, verifiedAt: null });
      setEditing(true);
      router.refresh();
    } catch {
      setError("No se pudo borrar la key");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <section className="flex flex-col gap-3 border border-hairline bg-surface-1 p-4">
      <h2 className="label-mono text-ink-tertiary">Ajustes de IA</h2>
      <p className="text-xs text-ink-tertiary">
        Tu key se guarda cifrada (AES-256-GCM) y solo se usa para generar el campo Foresight.
      </p>

      {staleKey && (
        <p className="border border-l-4 border-brand-orange bg-canvas px-3 py-2 text-xs text-ink">
          Tu key dejó de funcionar (la última verificación falló). Pega una nueva para que el
          análisis de foresight vuelva a correr.
        </p>
      )}

      {hasKey && !editing ? (
        <div className="flex flex-col gap-2 text-sm">
          <p className="text-ink">
            sk-…{info.last4} · {MODEL_OPTIONS.find((m) => m.value === info.model)?.label ?? info.model}
          </p>
          <p className="text-xs text-ink-subtle">
            {info.verifiedAt
              ? `Verificada el ${formatLongDate(info.verifiedAt)}`
              : "Sin verificar"}
          </p>
          <div className="flex gap-2">
            <button type="button" onClick={() => setEditing(true)} className={BUTTON_CLASS}>
              Cambiar key
            </button>
            <button
              type="button"
              onClick={remove}
              disabled={deleting}
              className="label-mono self-start border border-hairline px-3 py-2 text-ink-subtle transition-colors duration-150 hover:border-danger hover:text-danger disabled:opacity-50"
            >
              {deleting ? "Borrando…" : "Borrar key"}
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={save} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-ink-tertiary">API key de Anthropic</span>
            <input
              type="password"
              required
              autoComplete="off"
              placeholder="sk-ant-..."
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className={INPUT_CLASS}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-ink-tertiary">Modelo para Foresight</span>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className={INPUT_CLASS}
            >
              {MODEL_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <div className="flex gap-2">
            <button type="submit" disabled={saving} className={BUTTON_CLASS}>
              {saving ? "Probando y guardando…" : "Guardar y probar"}
            </button>
            {hasKey && (
              <button
                type="button"
                onClick={() => {
                  setEditing(false);
                  setError(null);
                }}
                className="label-mono self-start border border-hairline px-3 py-2 text-ink-subtle hover:text-ink"
              >
                Cancelar
              </button>
            )}
          </div>
          {error && <p className="text-xs text-danger">{error}</p>}
        </form>
      )}
    </section>
  );
}
