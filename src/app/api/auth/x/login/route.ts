import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { generateCodeChallenge, generateCodeVerifier, generateState } from "@/lib/pkce";
import { buildAuthorizeUrl } from "@/lib/x-oauth";

const COOKIE_MAX_AGE_SECONDS = 10 * 60; // 10 min, tiempo suficiente para completar el login

export async function GET() {
  const state = generateState();
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);

  const cookieStore = await cookies();
  const cookieOpts = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    maxAge: COOKIE_MAX_AGE_SECONDS,
    path: "/",
  };
  cookieStore.set("x_oauth_state", state, cookieOpts);
  cookieStore.set("x_oauth_code_verifier", codeVerifier, cookieOpts);

  const authorizeUrl = buildAuthorizeUrl({ state, codeChallenge });
  return NextResponse.redirect(authorizeUrl);
}
