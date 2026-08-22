import { NextResponse } from "next/server";
import { isCronRequest } from "@/lib/cron-auth";
import { withPlatformBypass } from "@/lib/tenant-db";
import { sendAdminAlert } from "@/lib/alerts";

// Una sola query agregada; no hay fan-out por tenant que justifique más.
export const maxDuration = 60;

const DEFAULT_OLLAMA_CALLS_PER_DAY = 5000;
const DEFAULT_OPENAI_TOKENS_PER_DAY = 5_000_000;

function envLimit(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function todayStartUtc(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * `GET /api/jobs/alerts` (PLAN 5.2c): suma el gasto de HOY (Ollama, OpenAI) en
 * todos los tenants y avisa a Frida si algún umbral se pasó.
 *
 * Solo cron (`Authorization: Bearer CRON_SECRET`), como el resto de
 * `/api/jobs/*`. No es un job de tenant —no hay `ownerId` que despachar— así
 * que no pasa por el dispatcher ni por `runJob`: es una sola query agregada
 * con `withPlatformBypass`.
 *
 * Cron sugerido (línea para `vercel.json`, que no toca este agente):
 *   { "path": "/api/jobs/alerts", "schedule": "0 9 * * *" }
 */
export async function GET(request: Request) {
  if (!isCronRequest(request)) {
    return NextResponse.json({ ok: false, error: "No autorizado" }, { status: 401 });
  }

  const todayStart = todayStartUtc();

  const { ollamaCalls, openaiTokens } = await withPlatformBypass(async (tx) => {
    const rows = await tx.usageEvent.groupBy({
      by: ["kind"],
      where: { createdAt: { gte: todayStart } },
      _count: { _all: true },
      _sum: { tokensIn: true, tokensOut: true },
    });
    const ollama = rows.find((r) => r.kind === "ollama_call");
    const openai = rows.find((r) => r.kind === "openai_embed");
    return {
      ollamaCalls: ollama?._count._all ?? 0,
      openaiTokens: (openai?._sum.tokensIn ?? 0) + (openai?._sum.tokensOut ?? 0),
    };
  });

  const ollamaLimit = envLimit("ALERT_OLLAMA_CALLS_PER_DAY", DEFAULT_OLLAMA_CALLS_PER_DAY);
  const openaiLimit = envLimit("ALERT_OPENAI_TOKENS_PER_DAY", DEFAULT_OPENAI_TOKENS_PER_DAY);

  const triggered: string[] = [];

  if (ollamaCalls > ollamaLimit) {
    await sendAdminAlert(
      "daily_ollama_calls",
      "Gasto diario de Ollama por encima del umbral",
      `Hoy se contaron ${ollamaCalls} llamadas a Ollama (kind=ollama_call) entre todos los tenants, por encima del umbral de ${ollamaLimit} (ALERT_OLLAMA_CALLS_PER_DAY).`,
    );
    triggered.push("ollama_calls");
  }

  if (openaiTokens > openaiLimit) {
    await sendAdminAlert(
      "daily_openai_tokens",
      "Gasto diario de tokens OpenAI por encima del umbral",
      `Hoy se usaron ${openaiTokens} tokens de OpenAI (kind=openai_embed) entre todos los tenants, por encima del umbral de ${openaiLimit} (ALERT_OPENAI_TOKENS_PER_DAY).`,
    );
    triggered.push("openai_tokens");
  }

  return NextResponse.json({ ok: true, ollamaCalls, openaiTokens, ollamaLimit, openaiLimit, triggered });
}
