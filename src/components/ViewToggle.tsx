"use client";

export type ViewMode = "cards" | "list";

export function ViewToggle({ view, onChange }: { view: ViewMode; onChange: (v: ViewMode) => void }) {
  return (
    <div className="inline-flex items-center border border-hairline bg-surface-1">
      {(["cards", "list"] as const).map((mode) => (
        <button
          key={mode}
          type="button"
          onClick={() => onChange(mode)}
          className={`label-mono px-3 py-1.5 capitalize transition-colors duration-150 ${
            view === mode ? "bg-ink text-brand-white" : "text-ink-subtle hover:text-ink"
          }`}
        >
          {mode === "cards" ? "Tarjetas" : "Lista"}
        </button>
      ))}
    </div>
  );
}
