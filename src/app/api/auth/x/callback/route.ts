import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { encryptToken } from "@/lib/token-crypto";
import { exchangeCodeForTokens, fetchAuthenticatedUserId } from "@/lib/x-oauth";

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const error = searchParams.get("error");
  if (error) {
    return NextResponse.json({ error: `X rechazo la autorizacion: ${error}` }, { status: 400 });
  }

  const code = searchParams.get("code");
  const state = searchParams.get("state");
  if (!code || !state) {
    return NextResponse.json({ error: "Faltan code o state en el callback" }, { status: 400 });
  }

  const cookieStore = await cookies();
  const expectedState = cookieStore.get("x_oauth_state")?.value;
  const codeVerifier = cookieStore.get("x_oauth_code_verifier")?.value;

  if (!expectedState || !codeVerifier || state !== expectedState) {
    return NextResponse.json({ error: "State invalido o expirado, intenta el login de nuevo" }, { status: 400 });
  }

  cookieStore.delete("x_oauth_state");
  cookieStore.delete("x_oauth_code_verifier");

  const tokens = await exchangeCodeForTokens({ code, codeVerifier });
  const xUserId = await fetchAuthenticatedUserId(tokens.access_token);

  if (!tokens.refresh_token) {
    return NextResponse.json(
      { error: "X no devolvio refresh_token, revisa que el scope offline.access este habilitado" },
      { status: 500 }
    );
  }

  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

  await prisma.xAuthToken.upsert({
    where: { xUserId },
    create: {
      xUserId,
      accessToken: encryptToken(tokens.access_token),
      refreshToken: encryptToken(tokens.refresh_token),
      expiresAt,
    },
    update: {
      accessToken: encryptToken(tokens.access_token),
      refreshToken: encryptToken(tokens.refresh_token),
      expiresAt,
    },
  });

  return NextResponse.redirect(new URL("/?x_connected=1", request.url));
}
