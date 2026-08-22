// BYOK de Anthropic (PLAN 3.7): cada tenant guarda su propia API key cifrada en
// `UserSecret(provider="anthropic")`. foresight.ts es el único consumidor hoy, pero
// esto queda listo para mover más etapas del análisis a Claude si el costo de Ollama
// Cloud crece demasiado (ver PLAN §5 "riesgos").
import Anthropic from "@anthropic-ai/sdk";
import { decryptToken, encryptToken } from "@/lib/token-crypto";
import { recordUsage } from "@/lib/quota";
import { withOwner } from "@/lib/tenant-db";

const PROVIDER = "anthropic";

/** Modelo default cuando el usuario no eligió uno explícito en /conexion. */
export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5";

/** Modelo barato y rápido, solo para el botón "Probar" (5 tokens de respuesta). */
const VERIFY_MODEL = "claude-haiku-4-5";

export type AnthropicClientInfo = {
  client: Anthropic;
  model: string;
};

type CacheEntry = {
  info: AnthropicClientInfo;
  expiresAt: number;
};

/**
 * Cache LRU-ish por ownerId con TTL de 5 min: evita descifrar la key y construir un
 * `Anthropic` nuevo en cada item de la corrida de análisis. No es un singleton
 * global de un solo cliente (eso mezclaría tenants) — cada entrada es por tenant.
 */
const CACHE_TTL_MS = 5 * 60 * 1000;
const clientCache = new Map<string, CacheEntry>();

/**
 * Descifra la key Anthropic del tenant y arma un cliente listo para usar, o `null`
 * si no tiene key guardada o la última verificación falló (`verifiedAt = null`).
 * El job de foresight debe saltarse al tenant en ese caso, sin error (PLAN 3.6).
 */
export async function getAnthropicClient(ownerId: string): Promise<AnthropicClientInfo | null> {
  const cached = clientCache.get(ownerId);
  if (cached && cached.expiresAt > Date.now()) return cached.info;

  const secret = await withOwner(ownerId, (tx) =>
    tx.userSecret.findUnique({ where: { userId_provider: { userId: ownerId, provider: PROVIDER } } }),
  );

  if (!secret || !secret.verifiedAt) {
    clientCache.delete(ownerId);
    return null;
  }

  const apiKey = decryptToken(secret.encrypted);
  const info: AnthropicClientInfo = {
    client: new Anthropic({ apiKey }),
    model: secret.model ?? DEFAULT_ANTHROPIC_MODEL,
  };
  clientCache.set(ownerId, { info, expiresAt: Date.now() + CACHE_TTL_MS });
  return info;
}

/** Tira la entrada de cache de un tenant: tras guardar una key nueva o marcarla inválida. */
export function invalidateAnthropicClient(ownerId: string): void {
  clientCache.delete(ownerId);
}

/** `true` si el tenant tiene una key Anthropic guardada y verificada. */
export async function hasVerifiedAnthropicKey(ownerId: string): Promise<boolean> {
  const secret = await withOwner(ownerId, (tx) =>
    tx.userSecret.findUnique({ where: { userId_provider: { userId: ownerId, provider: PROVIDER } } }),
  );
  return Boolean(secret?.verifiedAt);
}

export type VerifyResult = { ok: true } | { ok: false; error: string };

/**
 * Prueba una key con la llamada más barata posible (5 tokens de salida). La usan
 * tanto `saveAnthropicKey` como el botón "Probar" de /conexion.
 */
export async function verifyAnthropicKey(apiKey: string): Promise<VerifyResult> {
  try {
    const client = new Anthropic({ apiKey });
    await client.messages.create({
      model: VERIFY_MODEL,
      max_tokens: 5,
      messages: [{ role: "user", content: "ping" }],
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: describeAnthropicError(error) };
  }
}

/**
 * Verifica, cifra y guarda la key del tenant. No guarda nada si la verificación
 * falla — mejor un tenant sin key que uno con una key rota marcada como "lista".
 */
export async function saveAnthropicKey(
  ownerId: string,
  apiKey: string,
  model?: string,
): Promise<VerifyResult> {
  const verified = await verifyAnthropicKey(apiKey);
  if (!verified.ok) return verified;

  const encrypted = encryptToken(apiKey);
  const last4 = apiKey.slice(-4);
  const now = new Date();

  await withOwner(ownerId, (tx) =>
    tx.userSecret.upsert({
      where: { userId_provider: { userId: ownerId, provider: PROVIDER } },
      create: {
        userId: ownerId,
        provider: PROVIDER,
        encrypted,
        last4,
        model: model ?? null,
        verifiedAt: now,
      },
      update: { encrypted, last4, model: model ?? null, verifiedAt: now },
    }),
  );

  invalidateAnthropicClient(ownerId);
  return { ok: true };
}

/**
 * Un 401 de Anthropic significa que la key dejó de ser válida (revocada, rotada).
 * Se marca `verifiedAt = null` para que el job de foresight deje de intentarla y
 * /conexion pueda avisarle al usuario, sin tirar la fila de UserSecret.
 */
export async function markAnthropicKeyInvalid(ownerId: string): Promise<void> {
  await withOwner(ownerId, (tx) =>
    tx.userSecret.updateMany({
      where: { userId: ownerId, provider: PROVIDER },
      data: { verifiedAt: null },
    }),
  );
  invalidateAnthropicClient(ownerId);
}

/**
 * Registra una llamada a Claude en `UsageEvent`. Abre su propia transacción corta
 * (no reutiliza una abierta por el caller) porque se llama justo después de una
 * llamada de red que puede haber tardado hasta unos segundos — igual que el resto
 * del pipeline, no hay que mantener una tx de tenant abierta durante esa espera.
 */
export async function recordAnthropicUsage(
  ownerId: string,
  tokensIn?: number,
  tokensOut?: number,
): Promise<void> {
  await withOwner(ownerId, (tx) => recordUsage(tx, ownerId, "anthropic_call", 1, tokensIn, tokensOut));
}

function describeAnthropicError(error: unknown): string {
  if (error instanceof Anthropic.APIError) {
    return `Anthropic respondió ${error.status}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}
