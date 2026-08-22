import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { encryptToken } from "@/lib/token-crypto";
import { exchangeCodeForTokens, fetchAuthenticatedUserId } from "@/lib/x-oauth";
import { getSessionUser } from "@/lib/require-user";
import { withOwner, withPlatformBypass } from "@/lib/tenant-db";

export async function GET(request: NextRequest) {
  // La conexion con X queda atada al usuario de la sesion: sin sesion no hay
  // tenant al cual guardarle el token.
  // TODO(fase2.1): firmar el `state` con HMAC(AUTH_SECRET) incluyendo el userId y
  // verificar aqui que coincida con la sesion, en vez de confiar solo en la cookie.
  const sessionUser = await getSessionUser();
  if (!sessionUser) {
    return NextResponse.redirect(new URL("/login?from=%2Fconexion", request.url));
  }

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
  const accessToken = encryptToken(tokens.access_token);
  const refreshToken = encryptToken(tokens.refresh_token);

  // Una cuenta de X no puede alimentar dos bancos: el chequeo necesita ver
  // TODOS los tenants, de ahi el bypass acotado a esta lectura.
  const takenByAnother = await withPlatformBypass((tx) =>
    tx.xAuthToken.findFirst({
      where: { xUserId, userId: { not: sessionUser.userId } },
      select: { id: true },
    }),
  );
  if (takenByAnother) {
    return NextResponse.redirect(new URL("/conexion?x_error=cuenta_ya_conectada", request.url));
  }

  await withOwner(sessionUser.userId, (tx) =>
    tx.xAuthToken.upsert({
      where: { userId: sessionUser.userId },
      create: {
        userId: sessionUser.userId,
        xUserId,
        accessToken,
        refreshToken,
        expiresAt,
      },
      update: { accessToken, refreshToken, expiresAt },
    }),
  );

  return NextResponse.redirect(new URL("/conexion?x_connected=1", request.url));
}
