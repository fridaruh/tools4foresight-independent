"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatSyncSummary, type SyncStages } from "@/lib/sync-summary";

export function SyncButton() {
  const router = useRouter();
  const [syncing, setSyncing] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function handleSync() {
    setSyncing(true);
    setResult(null);
    try {
      const res = await fetch("/api/sync", { method: "POST" });
      // `/api/sync` corre las cuatro etapas, no solo la ingesta: el mensaje reporta
      // todas para que no parezca que el boton solo trae likes.
      const data = (await res.json()) as SyncStages;
      setResult(formatSyncSummary(data));
      router.refresh();
    } catch {
      setResult("No se pudo conectar con el servidor");
    } finally {
      setSyncing(false);
      // El resumen ahora es de cuatro etapas y da mas que leer que el "+3 likes" de antes.
      setTimeout(() => setResult(null), 8000);
    }
  }

  return (
    <div className="flex min-w-0 items-center gap-2">
      {/* En movil el resumen no cabe entero junto al logo: se trunca con title para
          poder leerlo completo en hover/long-press. */}
      {result && (
        <span title={result} className="label-mono min-w-0 truncate text-ink-subtle max-md:max-w-[40vw]">
          {result}
        </span>
      )}
      <button
        type="button"
        onClick={handleSync}
        disabled={syncing}
        title="Traer likes, leer links, categorizar y analizar"
        aria-label="Traer likes, leer links, categorizar y analizar"
        className="flex h-9 w-9 items-center justify-center border border-ink bg-ink text-brand-white transition-colors duration-150 hover:border-brand-orange hover:bg-brand-orange disabled:opacity-60"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`h-4 w-4 ${syncing ? "animate-spin" : ""}`}
        >
          <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
          <path d="M21 3v5h-5" />
          <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
          <path d="M3 21v-5h5" />
        </svg>
      </button>
    </div>
  );
}
