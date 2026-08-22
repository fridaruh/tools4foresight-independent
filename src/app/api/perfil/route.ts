import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getSessionUser } from "@/lib/require-user";
import { withPlatformBypass } from "@/lib/tenant-db";

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
      if (taken && taken.id !== user.userId) {
        return NextResponse.json(
          { ok: false, error: "Ya hay una cuenta con ese email." },
          { status: 400 },
        );
      }
      await prisma.user.update({
        where: { id: user.userId },
        data: { email, emailVerified: false },
      });
    }
  }

  return NextResponse.json({ ok: true });
}

/**
 * `DELETE /api/perfil` — borrar la cuenta (PLAN 4.7). El `User` es la raíz de
 * todo el tenant (ver el `@@map("users")` en schema.prisma: cascade sobre
 * sesiones, secretos, cuota, categorías, likes, grafo…), así que borrarlo
 * borra el banco completo.
 *
 * Va por `withPlatformBypass` a propósito: el `DELETE` en `users` cascadea
 * `DELETE`s en cada tabla de tenant, y esos SÍ pasan por sus políticas RLS
 * (una cascada no las salta) — con `app.owner_id` puesto por `withOwner` el
 * primer `DELETE` (en `users`, que no tiene RLS de tenant) pasaría, pero los
 * de las tablas hijas fallarían en silencio. El bypass es LOCAL a esta
 * transacción y solo corre después de verificar que hay sesión.
 */
export async function DELETE(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "Necesitas una cuenta" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as { confirm?: string } | null;
  if (body?.confirm !== "BORRAR") {
    return NextResponse.json(
      { ok: false, error: 'Escribe "BORRAR" para confirmar' },
      { status: 400 },
    );
  }

  await withPlatformBypass((tx) => tx.user.delete({ where: { id: user.userId } }));

  // El borrado ya tiró la fila de `sessions` por cascade; esto solo limpia la
  // cookie del navegador. Best-effort: si better-auth no encuentra la sesión
  // (porque ya se borró) no hay nada más que hacer.
  const requestHeaders = await headers();
  await auth.api.signOut({ headers: requestHeaders }).catch(() => {});

  return NextResponse.json({ ok: true });
}
