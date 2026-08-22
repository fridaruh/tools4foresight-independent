"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

const BUTTON_CLASS =
  "label-mono self-start border border-ink bg-ink px-3 py-2 text-brand-white transition-colors duration-150 hover:border-brand-orange hover:bg-brand-orange disabled:opacity-50";

type BatchResult = {
  created: number;
  duplicates: number;
  invalid: { line: number; raw: string; reason: string }[];
};

/**
 * Carga masiva de enlaces desde /conexion: un CSV con una URL por fila, que entra
 * al catálogo igual que cada enlace agregado a mano en /enrich (mismo endpoint de
 * datos, mismo `fetchStatus: "pending"` para que lo procesen los jobs).
 */
export function CsvLinksForm() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BatchResult | null>(null);

  async function upload(event: React.FormEvent) {
    event.preventDefault();
    const file = inputRef.current?.files?.[0];
    if (!file) {
      setError("Elige un archivo CSV.");
      return;
    }

    setUploading(true);
    setError(null);
    setResult(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/liked-items/batch", { method: "POST", body: formData });
      const data = (await res.json()) as BatchResult | { error: string };
      if (!res.ok || "error" in data) {
        setError("error" in data ? data.error : "No se pudo procesar el archivo.");
        return;
      }
      setResult(data);
      if (inputRef.current) inputRef.current.value = "";
      router.refresh();
    } catch {
      setError("No se pudo conectar con el servidor.");
    } finally {
      setUploading(false);
    }
  }

  return (
    <section className="flex flex-col gap-3 border border-hairline bg-surface-1 p-4">
      <h2 className="label-mono text-ink-tertiary">Cargar enlaces por CSV</h2>
      <p className="text-xs text-ink-tertiary">
        Un archivo con una URL por línea. El contenido y el análisis de cada enlace se procesan
        después, en automático — igual que un enlace agregado a mano. Máximo 500 por carga.
      </p>
      <form onSubmit={upload} className="flex flex-wrap items-center gap-3">
        <input
          ref={inputRef}
          type="file"
          accept=".csv,text/csv,text/plain"
          className="text-sm text-ink-subtle file:mr-3 file:border file:border-hairline file:bg-canvas file:px-3 file:py-2 file:text-sm file:text-ink"
        />
        <button type="submit" disabled={uploading} className={BUTTON_CLASS}>
          {uploading ? "Cargando…" : "Cargar CSV"}
        </button>
      </form>
      {error && <p className="text-xs text-danger">{error}</p>}
      {result && (
        <div className="text-xs text-ink-subtle">
          <p>
            {result.created} agregados · {result.duplicates} ya estaban en el catálogo
            {result.invalid.length > 0 ? ` · ${result.invalid.length} inválidos` : ""}
          </p>
          {result.invalid.length > 0 && (
            <ul className="mt-1 flex flex-col gap-1">
              {result.invalid.slice(0, 10).map((item) => (
                <li key={item.line}>
                  línea {item.line}: {item.raw || "(vacía)"} — {item.reason}
                </li>
              ))}
              {result.invalid.length > 10 && <li>y {result.invalid.length - 10} más…</li>}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
