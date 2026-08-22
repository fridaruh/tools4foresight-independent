import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";

export type Role = "admin" | "member" | null;

/**
 * Rol efectivo de la request actual según la sesión de better-auth.
 */
export async function getEffectiveRole(): Promise<Role> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (session) return session.user.role === "admin" ? "admin" : "member";
  return null;
}

/**
 * Para Server Components de admin: redirige a /login si no hay sesión.
 */
export async function requireAdminPage(): Promise<void> {
  const role = await getEffectiveRole();
  if (role === "admin") return;
  redirect(role === null ? "/login" : "/");
}

/** Para Route Handlers: responde 403 en vez de redirigir. */
export async function requireAdminApi(): Promise<NextResponse | null> {
  const role = await getEffectiveRole();
  if (role === "admin") return null;
  return NextResponse.json({ ok: false, error: "No autorizado" }, { status: 403 });
}

/** Para Route Handlers abiertos a cualquier sesión: 401 sin sesión. */
export async function requireSessionApi(): Promise<NextResponse | null> {
  if ((await getEffectiveRole()) !== null) return null;
  return NextResponse.json({ ok: false, error: "No autorizado" }, { status: 401 });
}

/** Para Server Components que requieren sesión: redirige a /login si no hay sesión. */
export async function requireSessionPage(): Promise<void> {
  if ((await getEffectiveRole()) === null) redirect("/login");
}

export type SessionUser = {
  id: string;
  role: "admin" | "member";
  email: string;
  name: string;
};

/**
 * El usuario de la sesión de better-auth, o null.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return null;
  return {
    id: session.user.id,
    role: session.user.role === "admin" ? "admin" : "member",
    email: session.user.email,
    name: session.user.name,
  };
}
