import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getSessionUser } from "@/lib/require-admin";

// Editar nombre y/o email del usuario de la sesión (pantalla /perfil).
// Pasa por auth.api (better-auth) y no por prisma directo, para que la
// sesión y sus hooks se mantengan consistentes.
export async function PATCH(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "Necesitas una cuenta" }, { status: 401 });
  }

  const body = (await request.json()) as { name?: string; email?: string };
  const requestHeaders = await headers();

  if ("name" in body) {
    const name = body.name?.trim() ?? "";
    if (!name) {
      return NextResponse.json({ ok: false, error: "El nombre no puede quedar vacío" }, { status: 400 });
    }
    await auth.api.updateUser({ body: { name }, headers: requestHeaders });
  }

  if ("email" in body) {
    const email = body.email?.trim().toLowerCase() ?? "";
    if (!email || !email.includes("@")) {
      return NextResponse.json({ ok: false, error: "Escribe un email válido" }, { status: 400 });
    }
    if (email !== user.email) {
      // Directo en la DB y no via auth.api.changeEmail: ese endpoint exige un
      // flujo de verificación por correo para cuentas verificadas (magic
      // link) que esta app no tiene. La sesión activa es la prueba de
      // identidad, igual que en el resto de /perfil.
      const taken = await prisma.user.findUnique({ where: { email }, select: { id: true } });
      if (taken && taken.id !== user.id) {
        return NextResponse.json(
          { ok: false, error: "Ya hay una cuenta con ese email." },
          { status: 400 },
        );
      }
      await prisma.user.update({
        where: { id: user.id },
        data: { email, emailVerified: false },
      });
    }
  }

  return NextResponse.json({ ok: true });
}
