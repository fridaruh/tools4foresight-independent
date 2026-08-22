import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserApi } from "@/lib/require-user";

export async function GET() {
  const user = await requireUserApi();
  if (user instanceof NextResponse) return user;

  const fields = await prisma.customFieldDefinition.findMany({
    where: { ownerId: user.userId },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
  });
  return NextResponse.json({ fields });
}

// Crear una columna nueva desde la pantalla de enriquecimiento. Solo registra la
// definicion; los valores por item se guardan al presionar "Guardar" en cada fila.
export async function POST(request: NextRequest) {
  const user = await requireUserApi();
  if (user instanceof NextResponse) return user;

  const { fieldKey } = (await request.json()) as { fieldKey?: string };
  const key = fieldKey?.trim();

  if (!key) {
    return NextResponse.json({ error: "Falta el nombre de la columna" }, { status: 400 });
  }

  const existing = await prisma.customFieldDefinition.findUnique({
    where: { ownerId_fieldKey: { ownerId: user.userId, fieldKey: key } },
  });
  if (existing) {
    return NextResponse.json({ error: "Ya existe una columna con ese nombre" }, { status: 409 });
  }

  const count = await prisma.customFieldDefinition.count({ where: { ownerId: user.userId } });
  const field = await prisma.customFieldDefinition.create({
    data: { ownerId: user.userId, fieldKey: key, position: count },
  });

  return NextResponse.json({ field }, { status: 201 });
}

export async function DELETE(request: NextRequest) {
  const user = await requireUserApi();
  if (user instanceof NextResponse) return user;

  const key = request.nextUrl.searchParams.get("fieldKey");
  if (!key) return NextResponse.json({ error: "Falta fieldKey" }, { status: 400 });

  // Borra la definicion y los valores que ya se hayan capturado en esa columna.
  await prisma.$transaction([
    prisma.likedItemCustomField.deleteMany({ where: { ownerId: user.userId, fieldKey: key } }),
    prisma.customFieldDefinition.deleteMany({ where: { ownerId: user.userId, fieldKey: key } }),
  ]);

  return NextResponse.json({ ok: true });
}
