import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdminApi } from "@/lib/require-admin";

export async function GET() {
  const fields = await prisma.customFieldDefinition.findMany({
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
  });
  return NextResponse.json({ fields });
}

// Crear una columna nueva desde la pantalla de enriquecimiento. Solo registra la
// definicion; los valores por item se guardan al presionar "Guardar" en cada fila.
export async function POST(request: NextRequest) {
  const denied = await requireAdminApi();
  if (denied) return denied;

  const { fieldKey } = (await request.json()) as { fieldKey?: string };
  const key = fieldKey?.trim();

  if (!key) {
    return NextResponse.json({ error: "Falta el nombre de la columna" }, { status: 400 });
  }

  const existing = await prisma.customFieldDefinition.findUnique({ where: { fieldKey: key } });
  if (existing) {
    return NextResponse.json({ error: "Ya existe una columna con ese nombre" }, { status: 409 });
  }

  const count = await prisma.customFieldDefinition.count();
  const field = await prisma.customFieldDefinition.create({
    data: { fieldKey: key, position: count },
  });

  return NextResponse.json({ field }, { status: 201 });
}

export async function DELETE(request: NextRequest) {
  const denied = await requireAdminApi();
  if (denied) return denied;

  const key = request.nextUrl.searchParams.get("fieldKey");
  if (!key) return NextResponse.json({ error: "Falta fieldKey" }, { status: 400 });

  // Borra la definicion y los valores que ya se hayan capturado en esa columna.
  await prisma.$transaction([
    prisma.likedItemCustomField.deleteMany({ where: { fieldKey: key } }),
    prisma.customFieldDefinition.deleteMany({ where: { fieldKey: key } }),
  ]);

  return NextResponse.json({ ok: true });
}
