import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";
import { ADMIN_SESSION_COOKIE, isValidSessionCookieValue } from "@/lib/admin-session";

// Gate de toda la app. Los 4 endpoints de cron (/api/jobs/*) quedan fuera del
// matcher porque Vercel los invoca sin cookie de sesion — se protegen aparte
// con CRON_SECRET dentro de cada route (ver src/lib/cron-auth.ts). Lo mismo el
// webhook de Stripe (/api/billing/webhook), que valida la firma del evento.
//
// Esto es solo la primera barrera: valida que exista una cookie de sesion, no
// el rol (Next 16 recomienda no confiar solo en el proxy — ver docs/proxy.md).
// Cada Server Function vuelve a validar con auth.api.getSession + rol
// (src/lib/require-admin.ts).
//
// Fase 0 dejo un password gate temporal (cookie propia + ADMIN_PASSWORD) que
// todavia se acepta en paralelo a la sesion de better-auth: retirarlo antes de
// que Frida confirme que el magic link le funciona la dejaria fuera si RESEND
// no esta configurado todavia.
export function proxy(request: NextRequest) {
  if (getSessionCookie(request)) {
    return NextResponse.next();
  }

  const legacySession = request.cookies.get(ADMIN_SESSION_COOKIE)?.value;
  if (isValidSessionCookieValue(legacySession)) {
    return NextResponse.next();
  }

  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ ok: false, error: "No autorizado" }, { status: 401 });
  }

  // La raiz es la landing publica para quien no tiene sesion (Fase 5): deja pasar
  // en vez de mandar a /login, la propia pagina decide que renderiza segun el rol.
  if (request.nextUrl.pathname === "/") {
    return NextResponse.next();
  }

  // Quien llega a /suscripcion sin sesion viene de un CTA de la landing y casi
  // siempre no tiene cuenta: a registro (que enlaza a login conservando el
  // destino, con el plan elegido). El resto, a login.
  const from = request.nextUrl.pathname + request.nextUrl.search;
  const entry = request.nextUrl.pathname.startsWith("/suscripcion") ? "/registro" : "/login";
  const loginUrl = new URL(entry, request.url);
  if (from !== "/") loginUrl.searchParams.set("from", from);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: [
    "/((?!api/jobs|api/auth|api/billing/webhook|login|registro|terminos|privacidad|_next/static|_next/image|favicon.ico|icon.png|apple-icon.png|logo-aitns.png).*)",
  ],
};
