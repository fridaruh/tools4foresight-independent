import { NextRequest, NextResponse } from "next/server";
import { requireUserApi } from "@/lib/require-user";
import { withOwner } from "@/lib/tenant-db";
import { CategoryServiceError, deleteCategory, updateCategory } from "@/lib/category-service";

type PatchBody = {
  name?: unknown;
  description?: unknown;
  examples?: unknown;
  position?: unknown;
  isFallback?: unknown;
};

/**
 * Edita una categoría propia (nombre, descripción, ejemplos, orden, fallback).
 * Todo dentro de `withOwner`; un id de otro tenant no se edita, 404 (no 403).
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUserApi();
  if (user instanceof NextResponse) return user;

  const { id } = await params;
  const body = (await request.json().catch(() => null)) as PatchBody | null;
  if (!body) return NextResponse.json({ error: "Body inválido" }, { status: 400 });

  const patch: Parameters<typeof updateCategory>[3] = {};
  if (typeof body.name === "string") patch.name = body.name;
  if (typeof body.description === "string") patch.description = body.description;
  if (Array.isArray(body.examples)) patch.examples = body.examples as string[];
  if (typeof body.position === "number" && Number.isFinite(body.position)) {
    patch.position = body.position;
  }
  if (typeof body.isFallback === "boolean") patch.isFallback = body.isFallback;

  try {
    const category = await withOwner(user.userId, (tx) =>
      updateCategory(tx, user.userId, id, patch),
    );
    return NextResponse.json({ category });
  } catch (error) {
    if (error instanceof CategoryServiceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}

/**
 * Borra una categoría propia. 409 si es la fallback. Los items que la tenían
 * quedan sin categoría y `categorySource = 'auto'` para que el job los
 * reclasifique en la siguiente corrida.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUserApi();
  if (user instanceof NextResponse) return user;

  const { id } = await params;

  try {
    await withOwner(user.userId, (tx) => deleteCategory(tx, user.userId, id));
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof CategoryServiceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
