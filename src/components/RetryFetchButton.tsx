"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** Reintento manual del fetch de contenido de un item (PLAN fase 4). */
export function RetryFetchButton({ id }: { id: string }) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "running" | "ok" | "error">("idle");

  async function retry() {
    setState("running");
    const res = await fetch(`/api/liked-items/${id}/refetch`, { method: "POST" }).catch(() => null);
    if (res?.ok) {
      setState("ok");
      router.refresh();
    } else {
      setState("error");
    }
  }

  return (
    <button
      type="button"
      onClick={retry}
      disabled={state === "running" || state === "ok"}
      className="shrink-0 rounded-md border border-hairline bg-surface-1 px-2.5 py-1 text-xs font-medium text-ink transition-colors duration-150 hover:bg-surface-2 disabled:opacity-50"
    >
      {state === "running" && "Reintentando…"}
      {state === "ok" && "Listo"}
      {state === "error" && "Falló otra vez"}
      {state === "idle" && "Reintentar"}
    </button>
  );
}
