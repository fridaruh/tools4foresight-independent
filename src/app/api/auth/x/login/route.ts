import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { generateCodeChallenge, generateCodeVerifier } from "@/lib/pkce";
import { buildAuthorizeUrl, signOAuthState } from "@/lib/x-oauth";
import { requireUserApi } from "@/lib/require-user";
import { isRateLimited, rateLimitHeaders } from "@/lib/rate-limit";

const COOKIE_MAX_AGE_SECONDS = 10 * 60; // 10 min, tiempo suficiente para completar el login

// La conexion con X queda atada al usuario de la sesion: sin sesion no hay
// tenant al cual guardarle el token, asi que ni siquiera se arranca el flujo.
// El `state` que manda X de vuelta lleva el userId firmado (fase 2.1): el
// callback lo verifica contra la sesion que lo complete, no contra una cookie.
export async function GET() {
  const sessionUser = await requireUserApi();
  if (sessionUser instanceof NextResponse) {
    return sessionUser;
  }

  // Freno por usuario (PLAN 5.4): arrancar el flujo firma un state y planta una
  // cookie; en bucle es ruido contra la X App compartida. El bucket va por
  // userId y no por IP porque aquí ya hay sesión: es más preciso y no castiga a
  // dos personas detrás del mismo NAT.
  if (await isRateLimited(`x-oauth:${sessionUser.userId}`)) {
    return NextResponse.json(
      { ok: false, error: "Demasiados intentos de conectar X. Espera unos minutos." },
      { status: 429, headers: rateLimitHeaders() },
    );
  }

  const state = signOAuthState(sessionUser.userId);
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);

  const cookieStore = await cookies();
  cookieStore.set("x_oauth_code_verifier", codeVerifier, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    maxAge: COOKIE_MAX_AGE_SECONDS,
    path: "/",
  });

  const authorizeUrl = buildAuthorizeUrl({ state, codeChallenge });
  return NextResponse.redirect(authorizeUrl);
}
