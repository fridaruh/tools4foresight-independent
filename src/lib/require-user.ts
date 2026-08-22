/**
 * Guards de sesión y rol.
 *
 * Cambio de modelo respecto de x-likes-curator: ya no hay "admin" que ve todo y
 * "member" que ve lo publicado. Aquí **todo usuario con sesión es dueño de su
 * propio banco de señales** y lo ve completo; nadie ve el de nadie más. Por eso
 * `requireAdmin*` y `requireSession*` quedaron como alias de `requireUser*`: lo
 * que antes era "¿eres admin?" ahora es "¿hay sesión?", y el alcance de los datos
 * lo pone el `ownerId`, no el rol.
 *
 * `platform_admin` es otra cosa: es Frida operando la plataforma (panel /admin,
 * cuotas de otros tenants, flags globales — Fase 5). No da acceso al banco de
 * nadie; para eso está `withPlatformBypass` y es explícito.
 */
import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";

export type Role = "user" | "platform_admin" | null;

export type SessionUser = {
  /** El `ownerId` de todo lo que este usuario tenga en el pipeline. */
  userId: string;
  role: Exclude<Role, null>;
  email: string;
  name: string;
};

function normalizeRole(raw: unknown): Exclude<Role, null> {
  return raw === "platform_admin" ? "platform_admin" : "user";
}

/** El usuario de la sesión de better-auth, o null. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return null;
  return {
    userId: session.user.id,
    role: normalizeRole(session.user.role),
    email: session.user.email,
    name: session.user.name,
  };
}

/** Rol efectivo de la request actual; null si no hay sesión. */
export async function getEffectiveRole(): Promise<Role> {
  return (await getSessionUser())?.role ?? null;
}

// --- Cualquier usuario con sesión (el caso normal) ---

/** Para Server Components: redirige a /login si no hay sesión. */
export async function requireUserPage(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return user;
}

/**
 * Para Route Handlers. Devuelve el usuario o una respuesta 401 lista para
 * regresar; el caller distingue con `"userId" in result`.
 */
export async function requireUserApi(): Promise<SessionUser | NextResponse> {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "No autorizado" }, { status: 401 });
  }
  return user;
}

// --- Operación de la plataforma (Frida) ---

export async function requirePlatformAdminPage(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (user.role !== "platform_admin") redirect("/");
  return user;
}

export async function requirePlatformAdminApi(): Promise<SessionUser | NextResponse> {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "No autorizado" }, { status: 401 });
  }
  if (user.role !== "platform_admin") {
    return NextResponse.json({ ok: false, error: "No autorizado" }, { status: 403 });
  }
  return user;
}

// --- Alias del modelo viejo -------------------------------------------------
// Se conservan para no reescribir cada import de golpe. Todos significan hoy lo
// mismo: "hay sesión". Preferir requireUser* en código nuevo.

/** @deprecated usa `requireUserPage()` */
export async function requireAdminPage(): Promise<void> {
  await requireUserPage();
}

/** @deprecated usa `requireUserPage()` */
export async function requireSessionPage(): Promise<void> {
  await requireUserPage();
}

/**
 * @deprecated usa `requireUserApi()` — devuelve el usuario, que es lo que casi
 * siempre hace falta después del guard.
 */
export async function requireAdminApi(): Promise<NextResponse | null> {
  const result = await requireUserApi();
  return result instanceof NextResponse ? result : null;
}

/** @deprecated usa `requireUserApi()` */
export async function requireSessionApi(): Promise<NextResponse | null> {
  return requireAdminApi();
}
