import { NextRequest, NextResponse, after } from "next/server";
import { prisma } from "@/lib/prisma";
import { normalizePestel } from "@/config/pestel";
import { requireUserApi } from "@/lib/require-user";
import { isPublishable, isPublishStatus } from "@/lib/publish";
import { refreshGraph } from "@/lib/jobs/graph";

// Margen para el recalculo del grafo que corre despues de responder (ver abajo).
export const maxDuration = 300;

type Body = {
  category?: string | null;
  pestel?: string[];
  tldr?: string | null;
  impact?: string | null;
  whyMatters?: string | null;
  foresight?: string | null;
  /** Sacar (o devolver) el item de la tabla de enriquecimiento. No lo borra. */
  enrichDiscarded?: boolean;
  /** pending | published — ver src/lib/publish.ts */
  publishStatus?: string;
  /** Valores de las columnas custom de la pantalla de enriquecimiento. */
  customFields?: Record<string, string>;
};

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUserApi();
  if (user instanceof NextResponse) return user;

  const { id } = await params;
  const body = (await request.json()) as Body;

  const data: Record<string, unknown> = {};

  if ("category" in body) {
    data.category = body.category;
    // Una edicion manual marca la fuente para que las corridas automaticas
    // futuras no la pisen (PLAN 3.3 / fase 4).
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
  if ("foresight" in body) {
    data.foresight = body.foresight;
    data.foresightSource = "manual";
  }

  // Descartar es solo una bandera de la pantalla 2: no toca categoria, textos ni nada
  // que se vea en el catalogo.
  if (typeof body.enrichDiscarded === "boolean") data.enrichDiscarded = body.enrichDiscarded;

  if ("publishStatus" in body) {
    if (!isPublishStatus(body.publishStatus)) {
      return NextResponse.json({ error: "publishStatus inválido" }, { status: 400 });
    }

    if (body.publishStatus === "published") {
      // La regla se evalua contra el estado que va a quedar: si esta misma llamada
      // trae category/impact/whyMatters, cuentan; si no, se usa lo que ya hay en la DB.
      const current = await prisma.likedItem.findFirst({
        where: { id, ownerId: user.userId },
        select: { category: true, impact: true, whyMatters: true },
      });
      if (!current) return NextResponse.json({ error: "No encontrado" }, { status: 404 });

      const effective = {
        category: "category" in body ? body.category ?? null : current.category,
        impact: "impact" in body ? body.impact ?? null : current.impact,
        whyMatters: "whyMatters" in body ? body.whyMatters ?? null : current.whyMatters,
      };
      if (!isPublishable(effective)) {
        return NextResponse.json(
          { error: "Falta categoría, impacto o \"por qué importa\" para poder publicar." },
          { status: 400 },
        );
      }
    }

    data.publishStatus = body.publishStatus;
    data.publishedAt = body.publishStatus === "published" ? new Date() : null;
  }

  const customEntries = Object.entries(body.customFields ?? {});

  if (Object.keys(data).length === 0 && customEntries.length === 0) {
    return NextResponse.json({ error: "Nada que actualizar" }, { status: 400 });
  }

  // El boton "Guardar" de la pantalla 2 manda toda la fila de una vez, asi que
  // los campos base y los custom se escriben en una sola transaccion: o queda
  // toda la fila o no queda nada.
  const writes = [];
  if (Object.keys(data).length > 0) {
    // where con ownerId: si el item es de otro tenant el update revienta con
    // P2025 en vez de tocar la fila (y RLS lo cortaria igual).
    writes.push(prisma.likedItem.update({ where: { id, ownerId: user.userId }, data }));
  }
  for (const [fieldKey, fieldValue] of customEntries) {
    writes.push(
      prisma.likedItemCustomField.upsert({
        where: { likedItemId_fieldKey: { likedItemId: id, fieldKey } },
        update: { fieldValue },
        create: { ownerId: user.userId, likedItemId: id, fieldKey, fieldValue },
      }),
    );
  }

  await prisma.$transaction(writes);

  // Publicar o despublicar cambia el grafo (solo vive sobre lo publicado). El
  // recalculo corre DESPUES de responder para no hacer esperar a Frida; si la
  // señal aun no tiene embedding entra al grafo cuando corra el embed local, pero
  // la vitalidad y los temas del resto ya quedan al dia.
  if ("publishStatus" in data) {
    after(async () => {
      try {
        await refreshGraph(user.userId, "publish");
      } catch (error) {
        console.error("[grafo] recalculo tras publicar fallo:", error);
      }
    });
  }

  const item = await prisma.likedItem.findFirst({
    where: { id, ownerId: user.userId },
    include: { customFields: true },
  });

  return NextResponse.json({ item });
}

// El GET tambien lleva guard: sin el, cualquiera con el id de un item lo leia
// completo (PLAN 3.13).
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUserApi();
  if (user instanceof NextResponse) return user;

  const { id } = await params;
  const item = await prisma.likedItem.findFirst({
    where: { id, ownerId: user.userId },
    include: { customFields: true },
  });

  if (!item) return NextResponse.json({ error: "No encontrado" }, { status: 404 });
  return NextResponse.json({ item });
}
