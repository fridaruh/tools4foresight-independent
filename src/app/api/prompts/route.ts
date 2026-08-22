import { NextRequest, NextResponse } from "next/server";
import { requireUserApi } from "@/lib/require-user";
import { withOwner } from "@/lib/tenant-db";
import { getPromptOverrides, isPromptKey, PROMPT_DEFAULTS } from "@/lib/analysis-prompts";

// System prompts del análisis (PLAN 4.6), editables desde /conexion. La tabla
// `prompt_settings` solo guarda overrides: sin fila (o con texto en blanco) rige
// el default del código. Todo pasa por `withOwner`: es tabla de tenant.

export async function GET() {
  const user = await requireUserApi();
  if (user instanceof NextResponse) return user;

  const overrides = await withOwner(user.userId, (tx) => getPromptOverrides(tx, user.userId));
  return NextResponse.json({
    prompts: {
      tldr: { value: overrides.tldr, default: PROMPT_DEFAULTS.tldr },
      impact: { value: overrides.impact, default: PROMPT_DEFAULTS.impact },
      why_matters: { value: overrides.why_matters, default: PROMPT_DEFAULTS.why_matters },
    },
  });
}

/** Upsert de un override. Un texto en blanco se trata como "restaurar" (mismo efecto que DELETE). */
export async function PUT(request: NextRequest) {
  const user = await requireUserApi();
  if (user instanceof NextResponse) return user;

  const body = (await request.json().catch(() => null)) as { key?: unknown; value?: unknown } | null;
  const { key, value } = body ?? {};

  if (!isPromptKey(key)) {
    return NextResponse.json({ error: "Clave de prompt desconocida" }, { status: 400 });
  }
  if (typeof value !== "string") {
    return NextResponse.json({ error: "Falta el texto del prompt" }, { status: 400 });
  }

  if (value.trim() === "") {
    await withOwner(user.userId, (tx) =>
      tx.promptSetting.deleteMany({ where: { ownerId: user.userId, key } }),
    );
    return NextResponse.json({ ok: true, value: null });
  }

  await withOwner(user.userId, (tx) =>
    tx.promptSetting.upsert({
      where: { ownerId_key: { ownerId: user.userId, key } },
      update: { value },
      create: { ownerId: user.userId, key, value },
    }),
  );
  return NextResponse.json({ ok: true, value });
}

/** Restaura el default: borra el override guardado para `key`. */
export async function DELETE(request: NextRequest) {
  const user = await requireUserApi();
  if (user instanceof NextResponse) return user;

  const key = request.nextUrl.searchParams.get("key");
  if (!isPromptKey(key)) {
    return NextResponse.json({ error: "Clave de prompt desconocida" }, { status: 400 });
  }

  await withOwner(user.userId, (tx) =>
    tx.promptSetting.deleteMany({ where: { ownerId: user.userId, key } }),
  );
  return NextResponse.json({ ok: true, value: null });
}
