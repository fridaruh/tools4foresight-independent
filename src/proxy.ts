import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

// Gate de toda la app. Los endpoints de cron (/api/jobs/*) quedan fuera del
// matcher porque Vercel los invoca sin cookie de sesion — se protegen aparte
// con CRON_SECRET dentro de cada route (ver src/lib/cron-auth.ts).
//
// `/api/public/*` queda fuera por la misma razon y es importante entender por
// que: su credencial es `Authorization: Bearer <api-key>`, no una cookie. Un
// agente MCP nunca manda cookie, asi que si el proxy lo interceptara devolveria
// un 401 plano ANTES de que `withPublicApi` llegara a mirar la clave — la API
// publica entera seria inalcanzable y el sintoma ("401 con una clave valida")
// no apuntaria a este archivo. Se protege dentro de cada route con
// `withPublicApi` (src/lib/public-api-response.ts), que ademas resuelve la
// clave a su `ownerId` y aplica el rate limit por tenant.
//
// Esto es solo la primera barrera: valida que exista una cookie de sesion, no
// el rol (Next 16 recomienda no confiar solo en el proxy — ver docs/proxy.md).
// Cada Server Function vuelve a validar con auth.api.getSession + rol
// (src/lib/require-admin.ts).
export function proxy(request: NextRequest) {
  if (getSessionCookie(request)) {
    return NextResponse.next();
  }

  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ ok: false, error: "No autorizado" }, { status: 401 });
  }

  // La raiz es la landing publica para quien no tiene sesion: deja pasar
  // en vez de mandar a /login, la propia pagina decide que renderiza segun el rol.
  if (request.nextUrl.pathname === "/") {
    return NextResponse.next();
  }

  // El resto de rutas requieren sesion: redirigir a /login
  const from = request.nextUrl.pathname + request.nextUrl.search;
  const loginUrl = new URL("/login", request.url);
  if (from !== "/") loginUrl.searchParams.set("from", from);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: [
    // `onboarding/` queda fuera: son las capturas de public/onboarding/*.png que
    // pintan los modales del tour. Se piden desde una <img>, que no manda la
    // cookie de sesión en todos los contextos, y sin esta exclusión el proxy las
    // redirigía a /login — el modal enseñaba el HTML del login como imagen rota.
    // No hay ruta de app bajo /onboarding, así que no abre nada más.
    "/((?!api/jobs|api/auth|api/public|onboarding/|login|registro|terminos|privacidad|_next/static|_next/image|favicon.ico|icon.png|apple-icon.png|logo-aitns.png).*)",
  ],
};
