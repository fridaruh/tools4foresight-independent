"use client";

import { useState } from "react";

export function MagicLinkForm({ redirectTo }: { redirectTo: string }) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("sending");
    setError(null);

    try {
      const res = await fetch("/api/auth/sign-in/magic-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // errorCallbackURL: si el token del link no sirve (expirado, ya usado),
        // better-auth redirige ahi con ?error=... — sin esto caia en "/" y la
        // landing se tragaba el error en silencio.
        // name: solo se usa si el email no tiene cuenta (signup); no pedimos
        // nombre en el form, con el local-part del email alcanza.
        body: JSON.stringify({
          email,
          name: email.split("@")[0],
          callbackURL: redirectTo,
          errorCallbackURL: "/login",
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? "No se pudo enviar el link");
      }
      setStatus("sent");
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "No se pudo enviar el link");
    }
  }

  if (status === "sent") {
    return <p className="text-sm text-ink">Te mandamos un link a {email}. Expira en 10 minutos.</p>;
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1">
        <span className="label-mono text-ink-tertiary">Email</span>
        <input
          type="email"
          name="email"
          required
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="border border-hairline bg-surface-1 px-3 py-2 text-sm text-ink outline-none focus-visible:border-ink"
        />
      </label>
      <button
        type="submit"
        disabled={status === "sending"}
        className="label-mono border border-ink bg-ink px-3 py-2 text-brand-white transition-colors duration-150 hover:border-brand-orange hover:bg-brand-orange disabled:opacity-60"
      >
        {status === "sending" ? "Enviando…" : "Mandarme el link"}
      </button>
      {status === "error" && <p className="text-xs text-danger">{error}</p>}
    </form>
  );
}
