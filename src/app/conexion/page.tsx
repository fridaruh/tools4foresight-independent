import { prisma } from "@/lib/prisma";
import { formatLongDate, truncate } from "@/lib/format";
import { RunPipelineButton } from "@/components/RunPipelineButton";
import { RetryFetchButton } from "@/components/RetryFetchButton";
import { AnalysisPromptsEditor } from "@/components/AnalysisPromptsEditor";
import { getPromptOverrides, PROMPT_DEFAULTS } from "@/lib/analysis-prompts";
import { requireUserPage } from "@/lib/require-user";
import { withOwner } from "@/lib/tenant-db";

export const dynamic = "force-dynamic";

const STATUS_LABELS: Record<string, string> = {
  idle: "Sin correr todavía",
  ok: "Última corrida sin problemas",
  error_credits_depleted: "Se acabaron los créditos de la X API",
  error: "La última corrida falló",
};

export default async function ConexionPage() {
  const user = await requireUserPage();

  const [token, cursor, byFetchStatus, failed, total, promptOverrides] = await Promise.all([
    prisma.xAuthToken.findFirst({ select: { xUserId: true, expiresAt: true, updatedAt: true } }),
    prisma.ingestionCursor.findFirst(),
    prisma.likedItem.groupBy({ by: ["fetchStatus"], _count: { _all: true } }),
    prisma.likedItem.findMany({
      where: { fetchStatus: "failed" },
      orderBy: { likedAt: "desc" },
      take: 25,
      select: { id: true, tweetText: true, contentUrl: true, authorHandle: true },
    }),
    prisma.likedItem.count(),
    withOwner(user.userId, (tx) => getPromptOverrides(tx, user.userId)),
  ]);

  const counts = Object.fromEntries(byFetchStatus.map((row) => [row.fetchStatus, row._count._all]));

  return (
    <div
      data-section="conexion"
      className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-8 px-6 py-8 sm:px-10"
    >
      <header>
        <h1 className="section-title text-ink">Conexión</h1>
        <p className="text-sm text-ink-subtle">
          Estado de la cuenta de X, de la ingesta y de los links que no se pudieron leer.
        </p>
      </header>

      <section className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-hairline bg-surface-1 p-4">
          <p className="label-mono text-ink-tertiary">Cuenta de X</p>
          {token ? (
            <>
              <p className="mt-1 text-sm font-medium text-ink">Conectada</p>
              <p className="text-xs text-ink-subtle">
                user id {token.xUserId} · token renovado el {formatLongDate(token.updatedAt)}
              </p>
            </>
          ) : (
            <>
              <p className="mt-1 text-sm font-medium text-ink">Sin conectar</p>
              <a
                href="/api/auth/x/login"
                className="mt-2 inline-block rounded-md border border-hairline bg-canvas px-3 py-1.5 text-xs font-medium text-ink hover:bg-surface-2"
              >
                Conectar con X
              </a>
            </>
          )}
        </div>

        <div className="rounded-xl border border-hairline bg-surface-1 p-4">
          <p className="label-mono text-ink-tertiary">Última ingesta</p>
          <p className="mt-1 text-sm font-medium text-ink">
            {STATUS_LABELS[cursor?.lastStatus ?? "idle"] ?? cursor?.lastStatus}
          </p>
          <p className="text-xs text-ink-subtle">
            {cursor?.lastRunAt ? formatLongDate(cursor.lastRunAt) : "—"} · {total} likes guardados
          </p>
          {cursor?.lastError && (
            <p className="mt-1 text-xs text-danger">{truncate(cursor.lastError, 160)}</p>
          )}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="section-heading text-ink">Correr los jobs a mano</h2>
        <p className="text-sm text-ink-subtle">
          Trae los likes nuevos, lee los links pendientes, categoriza y escribe el análisis
          (impacto y «por qué importa») de corrido. Todo esto corre solo por cron todos los días;
          el botón es para no esperar. Puede tardar varios minutos: deja la pestaña abierta.
        </p>
        <RunPipelineButton />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="section-heading text-ink">Prompts del análisis</h2>
        <p className="text-sm text-ink-subtle">
          Los system prompts con los que el modelo escribe el «TL;DR», el «Impacto» y el «¿Por qué importa?».
          Edítalos y guarda: la siguiente generación (cron o botón) los usa tal cual. Lo ya
          generado no se reescribe. «Restaurar el original» vuelve al prompt con el que arrancó
          el sistema.
        </p>
        <AnalysisPromptsEditor
          tldr={{ value: promptOverrides.tldr, default: PROMPT_DEFAULTS.tldr }}
          impact={{ value: promptOverrides.impact, default: PROMPT_DEFAULTS.impact }}
          whyMatters={{ value: promptOverrides.why_matters, default: PROMPT_DEFAULTS.why_matters }}
          foresight={{ value: promptOverrides.foresight, default: PROMPT_DEFAULTS.foresight }}
        />
      </section>


      <section className="flex flex-col gap-3">
        <h2 className="section-heading text-ink">Extracción de contenido</h2>
        <ul className="flex flex-wrap gap-2 text-xs">
          {(["success", "pending", "failed", "not_applicable"] as const).map((status) => (
            <li
              key={status}
              className="label-mono border border-hairline bg-surface-1 px-3 py-1 text-ink-subtle"
            >
              {status}: <span className="tabular-nums text-ink">{counts[status] ?? 0}</span>
            </li>
          ))}
        </ul>

        {failed.length > 0 && (
          <>
            <p className="text-sm text-ink-subtle">
              Estos links fallaron (paywall, bloqueo de bots, sitio caído). El job automático no los
              reintenta solo:
            </p>
            <ul className="flex flex-col gap-2">
              {failed.map((item) => (
                <li
                  key={item.id}
                  className="flex items-center gap-3 rounded-lg border border-hairline bg-surface-1 p-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-ink">{truncate(item.tweetText, 100)}</p>
                    <p className="truncate text-xs text-ink-tertiary">
                      @{item.authorHandle} · {item.contentUrl}
                    </p>
                  </div>
                  <RetryFetchButton id={item.id} />
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}
