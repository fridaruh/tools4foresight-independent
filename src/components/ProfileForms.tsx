"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const INPUT_CLASS =
  "border border-hairline bg-canvas px-3 py-2 text-sm text-ink outline-none focus-visible:border-ink";
const BUTTON_CLASS =
  "label-mono self-start border border-ink bg-ink px-3 py-2 text-brand-white transition-colors duration-150 hover:border-brand-orange hover:bg-brand-orange disabled:opacity-50";

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-hairline bg-surface-1 p-4">
      <h2 className="label-mono text-ink-tertiary">{title}</h2>
      {children}
    </section>
  );
}

type Status = { kind: "idle" } | { kind: "saving" } | { kind: "ok"; note?: string } | { kind: "error"; note: string };

function StatusNote({ status }: { status: Status }) {
  if (status.kind === "ok") {
    return <p className="text-xs text-success">{status.note ?? "Guardado"}</p>;
  }
  if (status.kind === "error") return <p className="text-xs text-danger">{status.note}</p>;
  return null;
}

export function ProfileForms({
  initialName,
  initialEmail,
  hasPassword,
}: {
  initialName: string;
  initialEmail: string;
  /** false = entró siempre por magic link: el form crea la contraseña sin pedir la actual. */
  hasPassword: boolean;
}) {
  const router = useRouter();

  const [name, setName] = useState(initialName);
  const [nameStatus, setNameStatus] = useState<Status>({ kind: "idle" });

  const [email, setEmail] = useState(initialEmail);
  const [emailStatus, setEmailStatus] = useState<Status>({ kind: "idle" });

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordSet, setPasswordSet] = useState(hasPassword);
  const [passwordStatus, setPasswordStatus] = useState<Status>({ kind: "idle" });

  async function patchPerfil(body: Record<string, string>): Promise<string | null> {
    const res = await fetch("/api/perfil", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return null;
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    return data?.error ?? "No se pudo guardar";
  }

  async function saveName(event: React.FormEvent) {
    event.preventDefault();
    setNameStatus({ kind: "saving" });
    const error = await patchPerfil({ name });
    if (error) return setNameStatus({ kind: "error", note: error });
    setNameStatus({ kind: "ok" });
    router.refresh(); // el círculo de la nav muestra la inicial del nombre nuevo
  }

  async function saveEmail(event: React.FormEvent) {
    event.preventDefault();
    setEmailStatus({ kind: "saving" });
    const error = await patchPerfil({ email });
    if (error) return setEmailStatus({ kind: "error", note: error });
    setEmailStatus({ kind: "ok", note: "Guardado. Con este email entras a partir de ahora." });
    router.refresh();
  }

  async function savePassword(event: React.FormEvent) {
    event.preventDefault();
    setPasswordStatus({ kind: "saving" });
    const res = await fetch("/api/perfil/password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        passwordSet ? { currentPassword, newPassword } : { newPassword },
      ),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      return setPasswordStatus({ kind: "error", note: data?.error ?? "No se pudo guardar" });
    }
    setPasswordStatus({
      kind: "ok",
      note: passwordSet
        ? "Contraseña cambiada. Tus otras sesiones se cerraron."
        : "Contraseña creada. Ya puedes entrar con ella.",
    });
    setPasswordSet(true);
    setCurrentPassword("");
    setNewPassword("");
  }

  return (
    <div className="flex flex-col gap-4">
      <Card title="Nombre">
        <form onSubmit={saveName} className="flex flex-col gap-3">
          <input
            type="text"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={INPUT_CLASS}
          />
          <button type="submit" disabled={nameStatus.kind === "saving"} className={BUTTON_CLASS}>
            {nameStatus.kind === "saving" ? "Guardando…" : "Guardar nombre"}
          </button>
          <StatusNote status={nameStatus} />
        </form>
      </Card>

      <Card title="Email">
        <form onSubmit={saveEmail} className="flex flex-col gap-3">
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={INPUT_CLASS}
          />
          <p className="text-xs text-ink-tertiary">
            Es tu llave de acceso: con este email entras (contraseña o magic link) y aquí llegan los
            correos.
          </p>
          <button type="submit" disabled={emailStatus.kind === "saving"} className={BUTTON_CLASS}>
            {emailStatus.kind === "saving" ? "Guardando…" : "Guardar email"}
          </button>
          <StatusNote status={emailStatus} />
        </form>
      </Card>

      <Card title={passwordSet ? "Cambiar contraseña" : "Crear contraseña"}>
        <form onSubmit={savePassword} className="flex flex-col gap-3">
          {passwordSet ? (
            <label className="flex flex-col gap-1">
              <span className="text-xs text-ink-tertiary">Contraseña actual</span>
              <input
                type="password"
                required
                autoComplete="current-password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                className={INPUT_CLASS}
              />
            </label>
          ) : (
            <p className="text-xs text-ink-tertiary">
              Hasta ahora entras con magic link. Crea una contraseña y podrás usar cualquiera de las
              dos.
            </p>
          )}
          <label className="flex flex-col gap-1">
            <span className="text-xs text-ink-tertiary">Contraseña nueva (mínimo 8 caracteres)</span>
            <input
              type="password"
              required
              minLength={8}
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className={INPUT_CLASS}
            />
          </label>
          <button type="submit" disabled={passwordStatus.kind === "saving"} className={BUTTON_CLASS}>
            {passwordStatus.kind === "saving"
              ? "Guardando…"
              : passwordSet
                ? "Cambiar contraseña"
                : "Crear contraseña"}
          </button>
          <StatusNote status={passwordStatus} />
        </form>
      </Card>
    </div>
  );
}
