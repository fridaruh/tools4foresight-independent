import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserApi } from "@/lib/require-user";
import { getPromptOverrides, isPromptKey, PROMPT_DEFAULTS } from "@/lib/analysis-prompts";

// System prompts del análisis, editables desde la pantalla de Sistema. La tabla solo
// guarda overrides: PUT con texto vacío borra la fila y regresa al default del código.

export async function GET() {
  const user = await requireUserApi();
  if (user instanceof NextResponse) return user;

  const overrides = await getPromptOverrides();
  return NextResponse.json({
    prompts: {
      tldr: { value: overrides.tldr, default: PROMPT_DEFAULTS.tldr },
      impact: { value: overrides.impact, default: PROMPT_DEFAULTS.impact },
      why_matters: { value: overrides.why_matters, default: PROMPT_DEFAULTS.why_matters },
    },
  });
}

export async function PUT(request: NextRequest) {
  const user = await requireUserApi();
  if (user instanceof NextResponse) return user;

  const { key, value } = (await request.json()) as { key?: unknown; value?: unknown };

  if (!isPromptKey(key)) {
    return NextResponse.json({ error: "Clave de prompt desconocida" }, { status: 400 });
  }
  if (typeof value !== "string") {
    return NextResponse.json({ error: "Falta el texto del prompt" }, { status: 400 });
  }

  if (value.trim() === "") {
    await prisma.promptSetting.deleteMany({ where: { ownerId: user.userId, key } });
    return NextResponse.json({ ok: true, value: null });
  }

  await prisma.promptSetting.upsert({
    where: { ownerId_key: { ownerId: user.userId, key } },
    update: { value },
    create: { ownerId: user.userId, key, value },
  });
  return NextResponse.json({ ok: true, value });
}
