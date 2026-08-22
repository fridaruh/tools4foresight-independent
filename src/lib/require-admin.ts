import { NextResponse } from "next/server";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { ADMIN_SESSION_COOKIE, isValidSessionCookieValue } from "@/lib/admin-session";
import { hasAccess, type AccessFields } from "@/lib/subscription";
import { isStripeConfigured } from "@/lib/stripe";

export type Role = "admin" | "member" | null;

async function hasLegacyAdminCookie(): Promise<boolean> {
  const store = await cookies();
  return isValidSessionCookieValue(store.get(ADMIN_SESSION_COOKIE)?.value);
}

/**
 * Rol efectivo de la request actual. La cookie del password gate de Fase 0
 * cuenta como admin (es exclusiva de Frida) hasta que se retire — ver el
 * comentario en proxy.ts. Sin esto, alguien logueado solo con esa cookie
 * pasaba el proxy pero rebotaba en cada página/API porque acá solo se
 * miraba la sesión de better-auth.
 */
export async function getEffectiveRole(): Promise<Role> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (session) return session.user.role === "admin" ? "admin" : "member";
  return (await hasLegacyAdminCookie()) ? "admin" : null;
}

/**
 * Para Server Components de admin: redirige a /login si no hay sesión, o a
 * /senales si hay sesión pero no es admin (mandarla a /login la dejaría dando
 * vueltas: ya está logueada, solo no tiene el rol).
 */
export async function requireAdminPage(): Promise<void> {
  const role = await getEffectiveRole();
  if (role === "admin") return;
  redirect(role === null ? "/login" : "/senales");
}

/** Para Route Handlers: responde 403 en vez de redirigir. */
export async function requireAdminApi(): Promise<NextResponse | null> {
  const role = await getEffectiveRole();
  if (role === "admin") return null;
  return NextResponse.json({ ok: false, error: "No autorizado" }, { status: 403 });
}

/** Para Route Handlers abiertos a cualquier sesión (admin o member): 401 sin sesión. */
export async function requireSessionApi(): Promise<NextResponse | null> {
  if ((await getEffectiveRole()) !== null) return null;
  return NextResponse.json({ ok: false, error: "No autorizado" }, { status: 401 });
}

/** Para Server Components de member: redirige a /login si no hay sesión. */
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
 * El usuario de la sesión de better-auth, o null. A diferencia de
 * getEffectiveRole, aquí la cookie legacy de Fase 0 NO cuenta: favoritos y
 * feedback se guardan por usuario y esa cookie no tiene usuario detrás.
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

// --- Fase 4: acceso de pago ---

export type Access = {
  role: Role;
  /** true si puede leer el banco: admin, cookie legacy, o member con suscripcion vigente. */
  hasAccess: boolean;
  subscriptionStatus: string | null;
};

/**
 * Rol + si tiene acceso al contenido. El admin y la cookie legacy de Fase 0
 * (exclusiva de Frida) siempre pasan; un member necesita suscripcion en
 * trialing/active/past_due (src/lib/subscription.ts). Si Stripe no esta
 * configurado (STRIPE_SECRET_KEY vacio, p.ej. en local) no hay forma de
 * suscribirse, asi que todos los members pasan — es el comportamiento previo
 * a esta fase y evita dejar la app inutilizable por un .env incompleto.
 */
export async function getAccess(): Promise<Access> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    const legacy = await hasLegacyAdminCookie();
    return { role: legacy ? "admin" : null, hasAccess: legacy, subscriptionStatus: null };
  }
  if (session.user.role === "admin") {
    return { role: "admin", hasAccess: true, subscriptionStatus: null };
  }
  const fields = session.user as Partial<AccessFields>;
  const status = fields.subscriptionStatus ?? null;
  const allowed =
    !isStripeConfigured() ||
    hasAccess({
      subscriptionStatus: status,
      subscriptionId: fields.subscriptionId,
      subscriptionPeriodEnd: fields.subscriptionPeriodEnd,
    });
  return { role: "member", hasAccess: allowed, subscriptionStatus: status };
}

/**
 * Para Server Components de contenido (señales, categorias de member): a
 * /login sin sesion, a /suscripcion si es member sin suscripcion vigente.
 */
export async function requireAccessPage(): Promise<void> {
  const access = await getAccess();
  if (access.hasAccess) return;
  redirect(access.role === null ? "/login" : "/suscripcion");
}

/** Para Route Handlers de contenido: 401 sin sesion, 402 sin suscripcion. */
export async function requireAccessApi(): Promise<NextResponse | null> {
  const access = await getAccess();
  if (access.hasAccess) return null;
  if (access.role === null) {
    return NextResponse.json({ ok: false, error: "No autorizado" }, { status: 401 });
  }
  return NextResponse.json(
    { ok: false, error: "Necesitas una suscripción activa", redirect: "/suscripcion" },
    { status: 402 },
  );
}
