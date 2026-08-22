"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

/**
 * El círculo de cuenta en la esquina superior derecha: inicial del nombre,
 * y al click un menú con el perfil y cerrar sesión. Solo existe con sesión
 * de better-auth (con la cookie legacy de Fase 0 no hay usuario que editar
 * — ahí la nav sigue mostrando el "Salir" plano).
 */
export function UserMenu({
  user,
  showSubscription = false,
}: {
  user: { name: string; email: string };
  /** Members: enlace a /suscripcion (el admin no paga). */
  showSubscription?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const initial = (user.name.trim() || user.email)[0]?.toUpperCase() ?? "?";

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function logout() {
    setLoggingOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      router.push("/login");
      router.refresh();
    }
  }

  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Mi cuenta"
        title={user.email}
        className={`label-mono flex h-8 w-8 items-center justify-center rounded-full border transition-colors duration-150 sm:h-9 sm:w-9 ${
          open
            ? "border-brand-orange bg-brand-orange text-brand-white"
            : "border-ink bg-surface-1 text-ink hover:border-brand-orange hover:bg-brand-orange hover:text-brand-white"
        }`}
      >
        {initial}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-40 mt-2 w-56 border border-ink bg-canvas"
        >
          <div className="border-b border-hairline px-3 py-2.5">
            <p className="truncate text-sm font-medium text-ink">{user.name}</p>
            <p className="truncate text-xs text-ink-tertiary">{user.email}</p>
          </div>
          <Link
            href="/perfil"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="label-mono block px-3 py-2.5 text-xs text-ink-subtle transition-colors duration-150 hover:bg-surface-1 hover:text-ink"
          >
            Mi perfil
          </Link>
          {showSubscription && (
            <Link
              href="/suscripcion"
              role="menuitem"
              onClick={() => setOpen(false)}
              className="label-mono block px-3 py-2.5 text-xs text-ink-subtle transition-colors duration-150 hover:bg-surface-1 hover:text-ink"
            >
              Mi suscripción
            </Link>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={logout}
            disabled={loggingOut}
            className="label-mono block w-full border-t border-hairline px-3 py-2.5 text-left text-xs text-ink-subtle transition-colors duration-150 hover:bg-surface-1 hover:text-ink disabled:opacity-50"
          >
            {loggingOut ? "Saliendo…" : "Cerrar sesión"}
          </button>
        </div>
      )}
    </div>
  );
}
