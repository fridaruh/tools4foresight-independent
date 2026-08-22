"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatSyncSummary, type SyncStages } from "@/lib/sync-summary";

/**
 * Las cuatro etapas, en el orden en que dependen una de otra: primero llegan los likes,
 * luego se leen los links (el titulo y la descripcion mejoran la clasificacion), luego
 * se categoriza y al final se escribe el analisis.
 */
const STEPS = [
  { key: "ingestion", path: "/api/jobs/ingest-likes", label: "Trayendo likes nuevos…" },
  { key: "content", path: "/api/jobs/fetch-content", label: "Leyendo links pendientes…" },
  { key: "categorization", path: "/api/jobs/categorize", label: "Categorizando…" },
  { key: "analysis", path: "/api/jobs/analyze", label: "Generando análisis…" },
  { key: "graph", path: "/api/jobs/graph", label: "Actualizando el grafo…" },
] as const;

/**
 * Un solo boton para toda la cadena, incluido el enriquecimiento (decision de Frida:
 * "que sea un solo botón que hace todo + el enriquecimiento").
 *
 * Encadena los cuatro endpoints desde el cliente en vez de llamar a `/api/sync`, y es a
 * proposito: asi cada etapa estrena los 300s de su propia funcion en vez de repartirse
 * los de una sola, y el boton puede ir diciendo en cual va. La cadena completa puede
 * tardar varios minutos.
 */
export function RunPipelineButton() {
  const router = useRouter();
  const [step, setStep] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const running = step !== null;

  async function run() {
    setMessage(null);
    const stages: SyncStages = {};

    for (let index = 0; index < STEPS.length; index += 1) {
      const { key, path } = STEPS[index];
      setStep(index);

      try {
        const res = await fetch(path, { method: "POST" });
        const data = await res.json();
        // Una etapa que falla no corta la cadena: si la X API se quedo sin creditos,
        // todavia vale la pena leer, categorizar y analizar lo que ya esta guardado.
        stages[key] = res.ok ? data : { ...data, ok: false };
      } catch {
        stages[key] = { ok: false, error: "No se pudo conectar con el servidor" };
      }

      // Cada etapa deja datos nuevos en la base; refrescar en el camino deja ver el
      // avance sin esperar a que termine toda la cadena.
      router.refresh();
    }

    setStep(null);
    setMessage(formatSyncSummary(stages));
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={run}
        disabled={running}
        className="rounded-md border border-hairline bg-surface-1 px-3 py-1.5 text-xs font-medium text-ink transition-colors duration-150 hover:bg-surface-2 disabled:opacity-60"
      >
        {running ? `${step + 1}/${STEPS.length} · ${STEPS[step].label}` : "Actualizar todo"}
      </button>
      {message && <span className="text-xs text-ink-subtle">{message}</span>}
    </div>
  );
}
