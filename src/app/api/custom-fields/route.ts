import { NextRequest, NextResponse } from "next/server";
import { withOwner } from "@/lib/tenant-db";
import { requireUserApi } from "@/lib/require-user";

export async function GET() {
  const user = await requireUserApi();
  if (user instanceof NextResponse) return user;

  const fields = await withOwner(user.userId, (tx) =>
    tx.customFieldDefinition.findMany({
      where: { ownerId: user.userId },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    }),
  );
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

  const result = await withOwner(user.userId, async (tx) => {
    const existing = await tx.customFieldDefinition.findFirst({
      where: { ownerId: user.userId, fieldKey: key },
    });
    if (existing) return { status: 409 as const };

    const count = await tx.customFieldDefinition.count({ where: { ownerId: user.userId } });
    const field = await tx.customFieldDefinition.create({
      data: { fieldKey: key, position: count, ownerId: user.userId },
    });
    return { status: 201 as const, field };
  });

  if (result.status === 409) {
    return NextResponse.json({ error: "Ya existe una columna con ese nombre" }, { status: 409 });
  }
  return NextResponse.json({ field: result.field }, { status: 201 });
}

export async function DELETE(request: NextRequest) {
  const user = await requireUserApi();
  if (user instanceof NextResponse) return user;

  const key = request.nextUrl.searchParams.get("fieldKey");
  if (!key) return NextResponse.json({ error: "Falta fieldKey" }, { status: 400 });

  // Borra la definicion y los valores que ya se hayan capturado en esa columna.
  await withOwner(user.userId, (tx) =>
    Promise.all([
      tx.likedItemCustomField.deleteMany({ where: { ownerId: user.userId, fieldKey: key } }),
      tx.customFieldDefinition.deleteMany({ where: { ownerId: user.userId, fieldKey: key } }),
    ]),
  );

  return NextResponse.json({ ok: true });
}
