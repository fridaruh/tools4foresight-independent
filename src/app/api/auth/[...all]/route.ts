import { NextResponse } from "next/server";
import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth";
import { isRateLimited, rateLimitHeaders, requestIp } from "@/lib/rate-limit";

const handlers = toNextJsHandler(auth);

export const GET = handlers.GET;

/**
 * Rutas de better-auth que aceptan credenciales o mandan correo, y por eso
 * llevan freno (PLAN 5.4). El valor es el prefijo de la clave del bucket, para
 * que el límite de "pedir magic link" y el de "probar contraseña" no se
 * consuman entre sí.
 *
 *   - `sign-in/magic-link`: manda un correo por Resend a cualquier dirección —
 *     sin freno es spam y gasto.
 *   - `sign-in/email`: es el único endpoint donde se prueba una contraseña;
 *     sin freno es fuerza bruta.
 *   - `sign-up/email`: signup abierto — sin freno se pueden crear cuentas en
 *     masa (y cada una siembra un tenant).
 *   - `forget-password` / `reset-password`: mandan o consumen correo.
 */
const LIMITED_PATHS: Record<string, string> = {
  "/sign-in/magic-link": "magic",
  "/sign-in/email": "signin",
  "/sign-up/email": "signup",
  "/forget-password": "forgot",
  "/reset-password": "reset",
};

function limitedBucket(pathname: string): string | null {
  for (const [suffix, bucket] of Object.entries(LIMITED_PATHS)) {
    if (pathname.endsWith(suffix)) return bucket;
  }
  return null;
}

// Se limita por IP y por email antes de tocar better-auth; la respuesta es
// igual exista o no la cuenta, para no convertir el 429 en un oráculo de
// "este email está registrado".
export async function POST(request: Request) {
  const bucket = limitedBucket(new URL(request.url).pathname);

  if (bucket) {
    const ip = requestIp(request);
    const body = (await request
      .clone()
      .json()
      .catch(() => null)) as { email?: string } | null;
    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";

    const ipLimited = await isRateLimited(`${bucket}-ip:${ip}`);
    const emailLimited = email ? await isRateLimited(`${bucket}-email:${email}`) : false;

    if (ipLimited || emailLimited) {
      return NextResponse.json(
        { message: "Demasiados intentos. Espera unos minutos y vuelve a intentarlo." },
        { status: 429, headers: rateLimitHeaders() },
      );
    }
  }

  return handlers.POST(request);
}
