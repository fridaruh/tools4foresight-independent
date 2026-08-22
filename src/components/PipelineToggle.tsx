"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** Prende/apaga si el cron nocturno corre este tenant (PLAN 4.2). */
export function PipelineToggle({ initialEnabled }: { initialEnabled: boolean }) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(initialEnabled);
  const [saving, setSaving] = useState(false);

  async function toggle() {
    const next = !enabled;
    setSaving(true);
    setEnabled(next);
    try {
      const res = await fetch("/api/settings/pipeline", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pipelineEnabled: next }),
      });
      if (!res.ok) throw new Error();
      router.refresh();
    } catch {
      setEnabled(!next); // revierte si el server no lo aceptó
    } finally {
      setSaving(false);
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={saving}
      role="switch"
      aria-checked={enabled}
      className={`label-mono inline-flex items-center gap-2 border px-3 py-1.5 transition-colors duration-150 disabled:opacity-60 ${
        enabled
          ? "border-ink bg-ink text-brand-white"
          : "border-hairline text-ink-subtle hover:border-ink hover:text-ink"
      }`}
    >
      <span className={`h-1.5 w-1.5 ${enabled ? "bg-brand-orange" : "bg-ink-tertiary"}`} aria-hidden />
      {enabled ? "Pipeline automático: activo" : "Pipeline automático: pausado"}
    </button>
  );
}
