import { NextRequest, NextResponse } from "next/server";
import { requireUserApi } from "@/lib/require-user";
import { withOwner } from "@/lib/tenant-db";
import {
  DEFAULT_ANTHROPIC_MODEL,
  invalidateAnthropicClient,
  saveAnthropicKey,
} from "@/lib/anthropic-client";

/**
 * BYOK de Anthropic (PLAN 4.2): cada tenant pega su propia key desde /conexion.
 * `saveAnthropicKey` ya hace la verificación (una llamada de 5 tokens a Haiku) y
 * el cifrado — esta ruta solo valida el shape del body y traduce el resultado a
 * HTTP.
 */

/** Únicos modelos que ofrece el selector de /conexion para el campo Foresight. */
const ALLOWED_MODELS = ["claude-sonnet-5", "claude-opus-5"] as const;

/**
 * Validación de forma de la key ANTES de gastar una llamada a Anthropic.
 *
 * No es seguridad —la key es del propio usuario y `saveAnthropicKey` la verifica
 * de verdad con un ping— pero sí evita dos cosas: mandarle a Anthropic cualquier
 * cosa que alguien pegue en el campo, y guardar/cifrar blobs enormes en
 * `user_secrets`. El prefijo `sk-ant-` es el formato público de las keys de
 * Anthropic; los topes son holgados a propósito para no romper si cambian de
 * longitud.
 */
const KEY_PREFIX = "sk-ant-";
const KEY_MIN_LENGTH = 32;
const KEY_MAX_LENGTH = 512;

function keyFormatError(apiKey: string): string | null {
  if (apiKey.length > KEY_MAX_LENGTH) {
    return "Esa key es demasiado larga para ser una API key de Anthropic.";
  }
  if (apiKey.length < KEY_MIN_LENGTH) {
    return "Esa key es demasiado corta. Copia la key completa desde console.anthropic.com.";
  }
  if (!apiKey.startsWith(KEY_PREFIX)) {
    return `Las API keys de Anthropic empiezan con "${KEY_PREFIX}". Revisa que copiaste la key correcta.`;
  }
  // Las keys son ASCII imprimible sin espacios; un salto de línea o un espacio
  // pegado por accidente rompería el header Authorization.
  if (!/^[A-Za-z0-9_-]+$/.test(apiKey)) {
    return "Esa key tiene caracteres que no van (¿un espacio o un salto de línea al copiar?).";
  }
  return null;
}

export async function POST(request: NextRequest) {
  const user = await requireUserApi();
  if (user instanceof NextResponse) return user;

  const body = (await request.json().catch(() => null)) as { apiKey?: string; model?: string } | null;
  const apiKey = body?.apiKey?.trim();
  if (!apiKey) {
    return NextResponse.json({ ok: false, error: "Pega tu API key de Anthropic" }, { status: 400 });
  }

  const formatError = keyFormatError(apiKey);
  if (formatError) {
    return NextResponse.json({ ok: false, error: formatError }, { status: 400 });
  }

  const model = body?.model?.trim();
  if (model && !(ALLOWED_MODELS as readonly string[]).includes(model)) {
    return NextResponse.json(
      { ok: false, error: `Modelo inválido. Válidos: ${ALLOWED_MODELS.join(", ")}` },
      { status: 400 },
    );
  }

  const result = await saveAnthropicKey(user.userId, apiKey, model);
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 400 });
  }

  const secret = await withOwner(user.userId, (tx) =>
    tx.userSecret.findUnique({
      where: { userId_provider: { userId: user.userId, provider: "anthropic" } },
      select: { last4: true, model: true, verifiedAt: true },
    }),
  );

  return NextResponse.json({
    ok: true,
    last4: secret?.last4 ?? null,
    model: secret?.model ?? DEFAULT_ANTHROPIC_MODEL,
    verifiedAt: secret?.verifiedAt ?? null,
  });
}

export async function DELETE() {
  const user = await requireUserApi();
  if (user instanceof NextResponse) return user;

  await withOwner(user.userId, (tx) =>
    tx.userSecret.deleteMany({ where: { userId: user.userId, provider: "anthropic" } }),
  );
  invalidateAnthropicClient(user.userId);

  return NextResponse.json({ ok: true });
}
