import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { encryptToken } from "@/lib/token-crypto";
import { exchangeCodeForTokens, fetchAuthenticatedXUser, verifyOAuthState } from "@/lib/x-oauth";
import { getSessionUser } from "@/lib/require-user";
import { withOwner, withPlatformBypass } from "@/lib/tenant-db";

export async function GET(request: NextRequest) {
  // La conexion con X queda atada al usuario de la sesion: sin sesion no hay
  // tenant al cual guardarle el token.
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

  // El state va firmado (HMAC-SHA256 con AUTH_SECRET) y lleva el userId de quien
  // arrancó el login (fase 2.1): si la firma no cuadra, pasaron más de 10
  // minutos, o el userId no es el de la sesión actual, se corta acá. Esto
  // reemplaza la comparación contra una cookie `x_oauth_state` — el estado ya
  // no necesita guardarse en ningún lado para poder verificarse.
  if (!verifyOAuthState(state, sessionUser.userId)) {
    return NextResponse.redirect(new URL("/conexion?x_error=state", request.url));
  }

  const cookieStore = await cookies();
  const codeVerifier = cookieStore.get("x_oauth_code_verifier")?.value;
  if (!codeVerifier) {
    return NextResponse.redirect(new URL("/conexion?x_error=state", request.url));
  }
  cookieStore.delete("x_oauth_code_verifier");

  const tokens = await exchangeCodeForTokens({ code, codeVerifier });
  const { id: xUserId, username: xUsername } = await fetchAuthenticatedXUser(tokens.access_token);

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

  await withOwner(sessionUser.userId, async (tx) => {
    await tx.xAuthToken.upsert({
      where: { userId: sessionUser.userId },
      create: {
        userId: sessionUser.userId,
        xUserId,
        xUsername,
        accessToken,
        refreshToken,
        expiresAt,
      },
      update: { xUsername, accessToken, refreshToken, expiresAt },
    });

    // El cursor de ingesta es 1:1 con el usuario; se crea vacío si es la
    // primera vez que conecta X, así que la primera corrida de ingest-likes ya
    // lo encuentra listo en vez de tener que sembrarlo ella misma.
    await tx.ingestionCursor.upsert({
      where: { userId: sessionUser.userId },
      update: {},
      create: { userId: sessionUser.userId },
    });
  });

  return NextResponse.redirect(new URL("/conexion?x_connected=1", request.url));
}
