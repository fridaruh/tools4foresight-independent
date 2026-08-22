import { NextResponse } from "next/server";
import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth";
import { isRateLimited, requestIp } from "@/lib/rate-limit";

const handlers = toNextJsHandler(auth);

export const GET = handlers.GET;

// Con signup abierto, pedir un magic link manda un email via Resend a cualquier
// direccion: sin freno es un vector de spam (y de gasto). Se limita por IP y por
// email antes de tocar better-auth; la respuesta es igual exista o no la cuenta.
export async function POST(request: Request) {
  if (new URL(request.url).pathname.endsWith("/sign-in/magic-link")) {
    const ip = requestIp(request);
    const body = (await request
      .clone()
      .json()
      .catch(() => null)) as { email?: string } | null;
    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";

    const ipLimited = await isRateLimited(`magic-ip:${ip}`);
    const emailLimited = email && (await isRateLimited(`magic-email:${email}`));

    if (ipLimited || emailLimited) {
      return NextResponse.json(
        { message: "Demasiados intentos. Espera unos minutos y vuelve a pedir tu link." },
        { status: 429 },
      );
    }
  }

  return handlers.POST(request);
}
