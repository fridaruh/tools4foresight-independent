"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Flag global de créditos de X (PLAN 5.1): estado + los dos botones que lo
 * mueven a mano. "Limpiar flag" es lo normal (Frida recargó créditos); "Marcar
 * agotados" es el escape para pausar la ingesta de todos antes de que X
 * devuelva el 402 en caliente.
 */
export function AdminXCreditsFlag({ initialDepleted }: { initialDepleted: boolean }) {
  const router = useRouter();
  const [depleted, setDepleted] = useState(initialDepleted);
  const [loading, setLoading] = useState<"clear" | "mark" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function call(action: "clear" | "mark") {
    setLoading(action);
    setError(null);
    try {
      const res = await fetch(`/api/admin/flags/x-credits/${action}`, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        xCreditsDepleted?: boolean;
        error?: string;
      };
      if (!res.ok || data.ok === false) throw new Error(data.error ?? "No se pudo actualizar el flag");
      setDepleted(data.xCreditsDepleted ?? action === "mark");
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="border border-ink border-l-4 border-l-brand-orange bg-surface-1 p-4">
      <p className="label-mono text-brand-orange">status: x credits {depleted ? "depleted" : "ok"}</p>
      <p className="mt-1 text-sm text-ink-subtle">
        {depleted
          ? "La cuenta de X compartida está sin créditos. La ingesta de todos los tenants está pausada."
          : "La cuenta de X compartida tiene créditos. La ingesta corre normal."}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => call("clear")}
          disabled={loading !== null || !depleted}
          className="label-mono border border-ink bg-ink px-3 py-1.5 text-brand-white transition-colors duration-150 hover:border-brand-orange hover:bg-brand-orange disabled:cursor-default disabled:opacity-40"
        >
          {loading === "clear" ? "Limpiando…" : "Limpiar flag"}
        </button>
        <button
          type="button"
          onClick={() => call("mark")}
          disabled={loading !== null || depleted}
          className="label-mono border border-hairline px-3 py-1.5 text-ink-subtle transition-colors duration-150 hover:border-danger hover:text-danger disabled:cursor-default disabled:opacity-40"
        >
          {loading === "mark" ? "Marcando…" : "Marcar agotados"}
        </button>
        {error && <span className="text-xs text-danger">{error}</span>}
      </div>
    </div>
  );
}
