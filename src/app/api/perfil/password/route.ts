import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getSessionUser } from "@/lib/require-user";

const MIN_PASSWORD_LENGTH = 8; // mismo mínimo que el signup (src/lib/auth.ts)

// Cambiar (o crear) la contraseña desde /perfil. Quien entró siempre por
// magic link no tiene credencial todavía: para ese caso setPassword crea una
// sin pedir la actual — la sesión activa es la prueba de identidad, igual
// que en el propio magic link.
export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "Necesitas una cuenta" }, { status: 401 });
  }

  const body = (await request.json()) as { currentPassword?: string; newPassword?: string };
  const newPassword = body.newPassword ?? "";
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return NextResponse.json(
      { ok: false, error: `La contraseña necesita al menos ${MIN_PASSWORD_LENGTH} caracteres` },
      { status: 400 },
    );
  }

  const requestHeaders = await headers();
  const credential = await prisma.account.findFirst({
    where: { userId: user.userId, providerId: "credential" },
    select: { id: true },
  });

  try {
    if (credential) {
      if (!body.currentPassword) {
        return NextResponse.json(
          { ok: false, error: "Escribe tu contraseña actual" },
          { status: 400 },
        );
      }
      await auth.api.changePassword({
        body: {
          currentPassword: body.currentPassword,
          newPassword,
          revokeOtherSessions: true,
        },
        headers: requestHeaders,
      });
    } else {
      await auth.api.setPassword({ body: { newPassword }, headers: requestHeaders });
    }
  } catch {
    return NextResponse.json(
      { ok: false, error: credential ? "La contraseña actual no coincide" : "No se pudo crear la contraseña" },
      { status: 400 },
    );
  }

  return NextResponse.json({ ok: true });
}
