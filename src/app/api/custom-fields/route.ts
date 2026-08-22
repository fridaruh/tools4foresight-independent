import { NextRequest, NextResponse } from "next/server";
import { tenantClient } from "@/lib/tenant-db";
import { requireUserApi } from "@/lib/require-user";

export async function GET() {
  const user = await requireUserApi();
  if (user instanceof NextResponse) return user;

  const client = tenantClient(user.userId);
  const fields = await client.customFieldDefinition.findMany({
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

  const client = tenantClient(user.userId);
  const existing = await client.customFieldDefinition.findFirst({
    where: { fieldKey: key },
  });
  if (existing) {
    return NextResponse.json({ error: "Ya existe una columna con ese nombre" }, { status: 409 });
  }

  const count = await client.customFieldDefinition.count();
  const field = await client.customFieldDefinition.create({
    data: { fieldKey: key, position: count, ownerId: user.userId },
  });

  return NextResponse.json({ field }, { status: 201 });
}

export async function DELETE(request: NextRequest) {
  const user = await requireUserApi();
  if (user instanceof NextResponse) return user;

  const key = request.nextUrl.searchParams.get("fieldKey");
  if (!key) return NextResponse.json({ error: "Falta fieldKey" }, { status: 400 });

  // Borra la definicion y los valores que ya se hayan capturado en esa columna.
  const client = tenantClient(user.userId);
  await client.$transaction([
    client.likedItemCustomField.deleteMany({ where: { fieldKey: key } }),
    client.customFieldDefinition.deleteMany({ where: { fieldKey: key } }),
  ]);

  return NextResponse.json({ ok: true });
}
