import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

// Gate de toda la app. Los endpoints de cron (/api/jobs/*) quedan fuera del
// matcher porque Vercel los invoca sin cookie de sesion — se protegen aparte
// con CRON_SECRET dentro de cada route (ver src/lib/cron-auth.ts).
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
    "/((?!api/jobs|api/auth|login|registro|terminos|privacidad|_next/static|_next/image|favicon.ico|icon.png|apple-icon.png|logo-aitns.png).*)",
  ],
};
