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
        onClick={handleClick}
        disabled={loading}
        className="px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50 rounded transition-colors disabled:opacity-50"
      >
        Desconectar
      </button>
    );
  }

  return (
    <div className="flex gap-2 items-center">
      <span className="text-sm text-gray-700">¿Seguro?</span>
      <button
        onClick={handleClick}
        disabled={loading}
        className="px-3 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded transition-colors disabled:opacity-50"
      >
        {loading ? "Desconectando..." : "Sí, desconectar"}
      </button>
      <button
        onClick={handleCancel}
        disabled={loading}
        className="px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded transition-colors disabled:opacity-50"
      >
        Cancelar
      </button>
      {error && <span className="text-sm text-red-600">{error}</span>}
    </div>
  );
}
