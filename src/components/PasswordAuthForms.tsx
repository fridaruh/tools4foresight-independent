"use client";

import { useState } from "react";

/**
 * Login y registro con email + contraseña (better-auth emailAndPassword).
 * Mismo estilo que MagicLinkForm: fetch directo a los endpoints REST de
 * better-auth — no hay authClient en el proyecto y para dos formularios no
 * hace falta.
 */

const INPUT_CLASS =
  "border border-hairline bg-surface-1 px-3 py-2 text-sm text-ink outline-none focus-visible:border-ink";

function errorLabel(status: number, message: string | undefined, mode: "login" | "signup"): string {
  if (mode === "login" && status === 401) return "Email o contraseña incorrectos.";
  if (mode === "signup" && status === 422) return "Ya existe una cuenta con ese email. Entra en su lugar.";
  return message ?? "Algo falló, intenta de nuevo.";
}

export function PasswordLoginForm({ redirectTo }: { redirectTo: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(errorLabel(res.status, body?.message, "login"));
      }
      // La cookie de sesión ya quedó puesta; navegación dura para que el
      // server re-evalúe rol y redirects.
      window.location.assign(redirectTo);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Algo falló, intenta de nuevo.");
      setSending(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1">
        <span className="label-mono text-ink-tertiary">Email</span>
        <input
          type="email"
          required
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className={INPUT_CLASS}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="label-mono text-ink-tertiary">Contraseña</span>
        <input
          type="password"
          required
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className={INPUT_CLASS}
        />
      </label>
      <button
        type="submit"
        disabled={sending}
        className="label-mono border border-ink bg-ink px-3 py-2 text-brand-white transition-colors duration-150 hover:border-brand-orange hover:bg-brand-orange disabled:opacity-60"
      >
        {sending ? "Entrando…" : "Entrar"}
      </button>
      {error && <p className="text-xs text-danger">{error}</p>}
    </form>
  );
}

export function RegisterForm({ redirectTo }: { redirectTo: string }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() || email.split("@")[0], email, password }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(errorLabel(res.status, body?.message, "signup"));
      }
      // autoSignIn de better-auth ya dejó la sesión puesta.
      window.location.assign(redirectTo);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Algo falló, intenta de nuevo.");
      setSending(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1">
        <span className="label-mono text-ink-tertiary">Nombre</span>
        <input
          type="text"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={INPUT_CLASS}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="label-mono text-ink-tertiary">Email</span>
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className={INPUT_CLASS}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="label-mono text-ink-tertiary">Contraseña</span>
        <input
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className={INPUT_CLASS}
        />
        <span className="text-[11px] text-ink-tertiary">Mínimo 8 caracteres.</span>
      </label>
      <button
        type="submit"
        disabled={sending}
        className="label-mono border border-ink bg-ink px-3 py-2 text-brand-white transition-colors duration-150 hover:border-brand-orange hover:bg-brand-orange disabled:opacity-60"
      >
        {sending ? "Creando cuenta…" : "Crear cuenta"}
      </button>
      {error && <p className="text-xs text-danger">{error}</p>}
    </form>
  );
}
