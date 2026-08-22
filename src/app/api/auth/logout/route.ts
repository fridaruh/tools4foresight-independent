import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { ADMIN_SESSION_COOKIE } from "@/lib/admin-session";

// Un solo botón de salir que cierra las dos sesiones posibles: la de
// better-auth (magic link) y la cookie del password gate de Fase 0. Sin esto
// "Salir" solo tumbaba una de las dos y la otra seguía dejando entrar.
export async function POST() {
  await auth.api.signOut({ headers: await headers() }).catch(() => {});
  const response = NextResponse.json({ ok: true });
  response.cookies.set(ADMIN_SESSION_COOKIE, "", { path: "/", maxAge: 0 });
  return response;
}
