"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Botón para desconectar la cuenta de X.
 *
 * Implementa un flujo de dos pasos:
 * 1. "Desconectar" (inicial)
 * 2. Confirmación: "¿Seguro? Sí, desconectar" (tras hacer clic)
 *
 * Al confirmar, borra el token de X pero preserva los liked_items.
 */
export function DisconnectXButton() {
  const router = useRouter();
  const [step, setStep] = useState<"initial" | "confirm">("initial");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleClick = async () => {
    if (step === "initial") {
      setStep("confirm");
      return;
    }

    // step === "confirm"
    setLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/auth/x", {
        method: "DELETE",
      });

      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || "No se pudo desconectar de X");
      }

      // Refrescar la página para reflejar el cambio
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
      setLoading(false);
      setStep("initial");
    }
  };

  const handleCancel = () => {
    setStep("initial");
    setError(null);
  };

  if (step === "initial") {
    return (
      <button
        type="button"
        onClick={handleClick}
        disabled={loading}
        className="label-mono border border-hairline px-3 py-2 text-ink-subtle transition-colors duration-150 hover:border-danger hover:text-danger disabled:opacity-50"
      >
        Desconectar
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-ink-subtle">¿Seguro?</span>
      <button
        type="button"
        onClick={handleClick}
        disabled={loading}
        className="label-mono border border-danger bg-danger px-3 py-2 text-brand-white transition-colors duration-150 hover:opacity-90 disabled:opacity-50"
      >
        {loading ? "Desconectando…" : "Sí, desconectar"}
      </button>
      <button
        type="button"
        onClick={handleCancel}
        disabled={loading}
        className="label-mono border border-hairline px-3 py-2 text-ink-subtle transition-colors duration-150 hover:text-ink disabled:opacity-50"
      >
        Cancelar
      </button>
      {error && <span className="text-xs text-danger">{error}</span>}
    </div>
  );
}
