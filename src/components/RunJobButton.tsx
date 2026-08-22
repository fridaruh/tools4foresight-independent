"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Dispara un job manualmente desde la UI. Los jobs tambien corren por cron; esto es
 * para no tener que esperar a la corrida del dia (PLAN fase 4).
 */
export function RunJobButton({ path, label }: { path: string; label: string }) {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function run() {
    setRunning(true);
    setMessage(null);
    try {
      const res = await fetch(path, { method: "POST" });
      const data = (await res.json()) as {
        ok?: boolean;
        categorized?: number;
        impacts?: number;
        whyMatters?: number;
        remaining?: number;
        updated?: number;
        error?: string;
        errors?: string[];
      };

      const pending = data.remaining ? ` · faltan ${data.remaining}` : " · listo";

      if (!res.ok || data.ok === false) {
        setMessage(data.error ?? data.errors?.[0] ?? "El job falló");
      } else if (typeof data.categorized === "number") {
        setMessage(`${data.categorized} categorizados${pending}`);
      } else if (typeof data.impacts === "number") {
        // El analisis escribe dos textos por item y casi nunca termina de una:
        // 600 items son ~1200 llamadas al modelo y no caben en una sola corrida.
        setMessage(`${data.impacts} impactos · ${data.whyMatters} por qué importa${pending}`);
      } else {
        setMessage("Listo");
      }
      router.refresh();
    } catch {
      setMessage("No se pudo conectar con el servidor");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      {message && <span className="label-mono text-ink-subtle">{message}</span>}
      <button
        type="button"
        onClick={run}
        disabled={running}
        className="label-mono border border-ink bg-ink px-3 py-2 text-brand-white transition-colors duration-150 hover:border-brand-orange hover:bg-brand-orange disabled:opacity-60"
      >
        {running ? "Corriendo…" : label}
      </button>
    </div>
  );
}
