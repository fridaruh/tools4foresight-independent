// Estado del sistema, en el lenguaje que la marca usa para eso: `STATUS: ...` en mono
// y barra Signal Orange a la izquierda, en vez del amarillo de alerta genérico y el
// emoji (DESIGN.md §11 prohíbe emojis, §14 pide indicadores de estado técnicos).
export function StatusBanner({ lastStatus, lastError }: { lastStatus: string; lastError: string | null }) {
  if (lastStatus !== "error_credits_depleted" && lastStatus !== "error") return null;

  const code = lastStatus === "error_credits_depleted" ? "credits depleted" : "error";

  return (
    <div className="border border-ink border-l-4 border-l-brand-orange bg-surface-1 p-4 text-sm">
      <p className="label-mono text-brand-orange">status: {code}</p>
      <p className="mt-1.5 font-medium text-ink">No se pudo traer nuevos likes</p>
      <p className="mt-0.5 text-ink-subtle">
        {lastError ?? "Ocurrió un error inesperado en la última sincronización."}
      </p>
    </div>
  );
}
