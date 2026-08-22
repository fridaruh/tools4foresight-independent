import { NextRequest, NextResponse } from "next/server";
import { normalizePestel } from "@/config/pestel";
import { requireUserApi } from "@/lib/require-user";
import { isPublishable, isPublishStatus } from "@/lib/publish";
import { withOwner } from "@/lib/tenant-db";

type Body = {
  category?: string | null;
  pestel?: string[];
  tldr?: string | null;
  impact?: string | null;
  whyMatters?: string | null;
  /** Sacar (o devolver) el item de la tabla de enriquecimiento. No lo borra. */
  enrichDiscarded?: boolean;
  /** pending | published — ver src/lib/publish.ts */
  publishStatus?: string;
  /** Valores de las columnas custom de la pantalla de enriquecimiento. */
  customFields?: Record<string, string>;
};

/**
 * Editar un item propio.
 *
 * Todo pasa por `withOwner(userId)` y todo `where` lleva `ownerId`: un id de
 * otro tenant no se edita, se responde 404 (no 403 — un 403 confirmaría que el
 * item existe).
 *
 * Publicar/despublicar ya NO recalcula el grafo en un `after()` (PLAN §3.10):
 * eran 2 minutos de función por cada click y N clicks seguidos disparaban N
 * recálculos encimados del mismo tenant. Ahora solo se marca `graphDirtyAt` y
 * quien recalcula es el cron de grafo —que solo despacha tenants marcados— o el
 * botón "recalcular ahora" (`POST /api/jobs/graph/now`).
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUserApi();
  if (user instanceof NextResponse) return user;

  const ownerId = user.userId;
  const { id } = await params;
  const body = (await request.json()) as Body;

  const data: Record<string, unknown> = {};

  if ("category" in body) {
    data.category = body.category;
    // Una edicion manual marca la fuente para que las corridas automaticas
    // futuras no la pisen.
    data.categorySource = "manual";
    data.categoryConfidence = null;
    data.categoryReasoning = null;
  }
  if ("pestel" in body) data.pestel = normalizePestel(body.pestel);

  // Igual que con la categoria: tocar el texto lo marca como manual para que el job
  // de analisis no lo vuelva a pisar en la siguiente corrida.
  if ("tldr" in body) {
    data.tldr = body.tldr;
    data.tldrSource = "manual";
  }
  if ("impact" in body) {
    data.impact = body.impact;
    data.impactSource = "manual";
  }
  if ("whyMatters" in body) {
    data.whyMatters = body.whyMatters;
    data.whyMattersSource = "manual";
  }
  // Descartar es solo una bandera de la pantalla 2: no toca categoria, textos ni nada
  // que se vea en el catalogo.
  if (typeof body.enrichDiscarded === "boolean") data.enrichDiscarded = body.enrichDiscarded;

  const customEntries = Object.entries(body.customFields ?? {});
  const changesPublishStatus = "publishStatus" in body;

  if (changesPublishStatus && !isPublishStatus(body.publishStatus)) {
    return NextResponse.json({ error: "publishStatus inválido" }, { status: 400 });
  }

  if (Object.keys(data).length === 0 && customEntries.length === 0 && !changesPublishStatus) {
    return NextResponse.json({ error: "Nada que actualizar" }, { status: 400 });
  }

  const result = await withOwner(ownerId, async (tx) => {
    const current = await tx.likedItem.findFirst({
      where: { id, ownerId },
      select: { category: true, impact: true, whyMatters: true },
    });
    if (!current) return { status: 404 as const, error: "No encontrado" };

    if (changesPublishStatus) {
      if (body.publishStatus === "published") {
        // La regla se evalua contra el estado que va a quedar: si esta misma
        // llamada trae category/impact/whyMatters, cuentan; si no, se usa lo que
        // ya hay en la DB.
        const effective = {
          category: "category" in body ? body.category ?? null : current.category,
          impact: "impact" in body ? body.impact ?? null : current.impact,
          whyMatters: "whyMatters" in body ? body.whyMatters ?? null : current.whyMatters,
        };
        if (!isPublishable(effective)) {
          return {
            status: 400 as const,
            error: 'Falta categoría, impacto o "por qué importa" para poder publicar.',
          };
        }
      }

      data.publishStatus = body.publishStatus;
      data.publishedAt = body.publishStatus === "published" ? new Date() : null;
    }

    // El boton "Guardar" de la pantalla 2 manda toda la fila de una vez, asi que
    // los campos base y los custom se escriben en la misma transaccion: o queda
    // toda la fila o no queda nada.
    if (Object.keys(data).length > 0) {
      await tx.likedItem.updateMany({ where: { id, ownerId }, data });
    }
    for (const [fieldKey, fieldValue] of customEntries) {
      await tx.likedItemCustomField.upsert({
        where: { likedItemId_fieldKey: { likedItemId: id, fieldKey } },
        update: { fieldValue },
        create: { ownerId, likedItemId: id, fieldKey, fieldValue },
      });
    }

    // Debounce del grafo: publicar o despublicar solo ensucia la marca.
    if (changesPublishStatus) {
      await tx.userQuota.updateMany({
        where: { userId: ownerId },
        data: { graphDirtyAt: new Date() },
      });
    }

    const item = await tx.likedItem.findFirst({
      where: { id, ownerId },
      include: { customFields: true },
    });

    return { status: 200 as const, item };
  });

  if (result.status !== 200) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ item: result.item, graphDirty: changesPublishStatus });
}

/**
 * Leer un item propio. Lleva guard igual que el PATCH: sin el, cualquiera con
 * el id de un item lo leia completo (PLAN §3.13).
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUserApi();
  if (user instanceof NextResponse) return user;

  const { id } = await params;
  const item = await withOwner(user.userId, (tx) =>
    tx.likedItem.findFirst({
      where: { id, ownerId: user.userId },
      include: { customFields: true },
    }),
  );

  if (!item) return NextResponse.json({ error: "No encontrado" }, { status: 404 });
  return NextResponse.json({ item });
}

/**
 * Borrar un item propio. Las filas colgadas (custom fields, aristas del grafo,
 * membresías de snapshot) se van por `onDelete: Cascade` del schema.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUserApi();
  if (user instanceof NextResponse) return user;

  const ownerId = user.userId;
  const { id } = await params;

  const deleted = await withOwner(ownerId, async (tx) => {
    const removed = await tx.likedItem.deleteMany({ where: { id, ownerId } });
    if (removed.count === 0) return 0;
    // Borrar una señal publicada cambia el grafo tanto como despublicarla.
    await tx.userQuota.updateMany({
      where: { userId: ownerId },
      data: { graphDirtyAt: new Date() },
    });
    return removed.count;
  });

  if (deleted === 0) return NextResponse.json({ error: "No encontrado" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
