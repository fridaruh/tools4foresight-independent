import Link from "next/link";
import { formatLongDate, truncate } from "@/lib/format";
import { RetryFetchButton } from "@/components/RetryFetchButton";
import { RunJobButton } from "@/components/RunJobButton";
import { DisconnectXButton } from "@/components/DisconnectXButton";
import { AnthropicKeyForm } from "@/components/AnthropicKeyForm";
import { PipelineToggle } from "@/components/PipelineToggle";
import { AnalysisPromptsEditor } from "@/components/AnalysisPromptsEditor";
import { getPromptOverrides, PROMPT_DEFAULTS } from "@/lib/analysis-prompts";
import { requireUserPage } from "@/lib/require-user";
import { withOwner } from "@/lib/tenant-db";
import { isXCreditsDepleted } from "@/lib/platform-flags";

export const dynamic = "force-dynamic";

const STATUS_LABELS: Record<string, string> = {
  idle: "Sin correr todavía",
  ok: "Última corrida sin problemas",
  error_credits_depleted: "Se acabaron los créditos de la X API",
  error: "La última corrida falló",
};

const JOB_LABELS: Record<string, string> = {
  ingest: "Ingesta de likes",
  fetch: "Lectura de links",
  categorize: "Categorización",
  analyze: "Análisis",
  embed: "Embeddings",
  graph: "Grafo",
};

const RUN_STATUS_LABELS: Record<string, string> = {
  queued: "en cola",
  running: "corriendo",
  ok: "ok",
  error: "error",
  budget: "cortado por tiempo",
};

const X_ERROR_LABELS: Record<string, string> = {
  state: "La conexión con X expiró o no se pudo verificar. Intenta de nuevo.",
  cuenta_ya_conectada: "Esa cuenta de X ya está conectada a otro usuario.",
};

export default async function ConexionPage({
  searchParams,
}: {
  searchParams: Promise<{ x_error?: string; x_connected?: string }>;
}) {
  const user = await requireUserPage();
  const { x_error } = await searchParams;
  const ownerId = user.userId;

  const [tenant, xCreditsDepleted] = await Promise.all([
    withOwner(ownerId, async (tx) => {
      const [token, cursor, quota, jobRuns, secret, byFetchStatus, failed, total, promptOverrides] =
        await Promise.all([
          tx.xAuthToken.findFirst({
            where: { userId: ownerId },
            select: { xUserId: true, xUsername: true, createdAt: true, updatedAt: true },
          }),
          tx.ingestionCursor.findFirst({ where: { userId: ownerId } }),
          tx.userQuota.findFirst({ where: { userId: ownerId } }),
          tx.jobRun.findMany({
            where: { ownerId },
            orderBy: { createdAt: "desc" },
            take: 10,
          }),
          tx.userSecret.findUnique({
            where: { userId_provider: { userId: ownerId, provider: "anthropic" } },
            select: { last4: true, model: true, verifiedAt: true },
          }),
          tx.likedItem.groupBy({ by: ["fetchStatus"], where: { ownerId }, _count: { _all: true } }),
          tx.likedItem.findMany({
            where: { ownerId, fetchStatus: "failed" },
            orderBy: { likedAt: "desc" },
            take: 25,
            select: { id: true, tweetText: true, contentUrl: true, authorHandle: true },
          }),
          tx.likedItem.count({ where: { ownerId } }),
          getPromptOverrides(tx, ownerId),
        ]);
      return { token, cursor, quota, jobRuns, secret, byFetchStatus, failed, total, promptOverrides };
    }),
    isXCreditsDepleted(),
  ]);

  const { token, cursor, quota, jobRuns, secret, byFetchStatus, failed, total, promptOverrides } =
    tenant;
  const counts = Object.fromEntries(byFetchStatus.map((row) => [row.fetchStatus, row._count._all]));

  return (
    <div
      data-section="conexion"
      className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-8 px-6 py-8 sm:px-10"
    >
      <header>
        <h1 className="section-title text-ink">Sistema</h1>
        <p className="text-sm text-ink-subtle">
          Tu cuenta de X, tus ajustes de IA, tus cuotas del día y el historial de corridas.
        </p>
      </header>

      {xCreditsDepleted && (
        <div className="border border-ink border-l-4 border-l-brand-orange bg-surface-1 p-4 text-sm">
          <p className="label-mono text-brand-orange">status: x credits depleted</p>
          <p className="mt-1 text-ink-subtle">
            La cuenta de X compartida por la plataforma se quedó sin créditos de API. La ingesta de
            todos los usuarios está pausada hasta que se recargue — no es un problema de tu cuenta.
          </p>
        </div>
      )}

      {x_error && (
        <div className="border border-ink border-l-4 border-l-danger bg-surface-1 p-4 text-sm">
          <p className="label-mono text-danger">status: error</p>
          <p className="mt-1 text-ink-subtle">
            {X_ERROR_LABELS[x_error] ?? "No se pudo completar la conexión con X."}
          </p>
        </div>
      )}

      <section className="grid gap-3 sm:grid-cols-2">
        <div className="border border-hairline bg-surface-1 p-4">
          <p className="label-mono text-ink-tertiary">Cuenta de X</p>
          {token ? (
            <>
              <p className="mt-1 text-sm font-medium text-ink">
                Conectada · @{token.xUsername ?? token.xUserId}
              </p>
              <p className="text-xs text-ink-subtle">
                token renovado el {formatLongDate(token.updatedAt)}
              </p>
              <div className="mt-2">
                <DisconnectXButton />
              </div>
            </>
          ) : (
            <>
              <p className="mt-1 text-sm font-medium text-ink">Sin conectar</p>
              <Link
                href="/api/auth/x/login"
                className="label-mono mt-2 inline-block border border-ink bg-ink px-3 py-2 text-brand-white transition-colors duration-150 hover:border-brand-orange hover:bg-brand-orange"
              >
                Conectar con X
              </Link>
            </>
          )}
        </div>

        <div className="border border-hairline bg-surface-1 p-4">
          <p className="label-mono text-ink-tertiary">Última ingesta</p>
          <p className="mt-1 text-sm font-medium text-ink">
            {STATUS_LABELS[cursor?.lastStatus ?? "idle"] ?? cursor?.lastStatus}
          </p>
          <p className="text-xs text-ink-subtle">
            {cursor?.lastRunAt ? formatLongDate(cursor.lastRunAt) : "—"} · {total} likes guardados
          </p>
          {cursor?.retryAfter && new Date(cursor.retryAfter) > new Date() && (
            <p className="mt-1 text-xs text-ink-tertiary">
              X pidió esperar hasta {formatLongDate(cursor.retryAfter)}.
            </p>
          )}
          {cursor?.backfillReachedWindow === false && (
            <p className="mt-1 text-xs text-ink-tertiary">Backfill en progreso.</p>
          )}
          {cursor?.lastError && (
            <p className="mt-1 text-xs text-danger">{truncate(cursor.lastError, 160)}</p>
          )}
        </div>
      </section>

      <AnthropicKeyForm
        initial={{
          last4: secret?.last4 ?? null,
          model: secret?.model ?? null,
          verifiedAt: secret?.verifiedAt?.toISOString() ?? null,
        }}
      />

      <section className="flex flex-col gap-3">
        <h2 className="section-heading text-ink">Cuotas del día</h2>
        {quota ? (
          <>
            <ul className="grid gap-2 sm:grid-cols-3">
              <li className="border border-hairline bg-surface-1 p-3">
                <p className="label-mono text-ink-tertiary">Páginas de X</p>
                <p className="text-sm text-ink tabular-nums">
                  {quota.xPagesUsedToday} / {quota.xPagesPerDay}
                </p>
              </li>
              <li className="border border-hairline bg-surface-1 p-3">
                <p className="label-mono text-ink-tertiary">Análisis</p>
                <p className="text-sm text-ink tabular-nums">
                  {quota.analyzeUsedToday} / {quota.analyzeItemsPerDay}
                </p>
              </li>
              <li className="border border-hairline bg-surface-1 p-3">
                <p className="label-mono text-ink-tertiary">Backfill</p>
                <p className="text-sm text-ink tabular-nums">
                  {quota.xBackfillMonths} meses · {quota.xBackfillPages} páginas
                </p>
              </li>
            </ul>
            <p className="text-xs text-ink-tertiary">
              Se reinicia el {formatLongDate(quota.windowResetAt)}.
            </p>
            <PipelineToggle initialEnabled={quota.pipelineEnabled} />
          </>
        ) : (
          <p className="text-sm text-ink-subtle">Todavía no hay cuota asignada a tu cuenta.</p>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="section-heading text-ink">Correr los jobs a mano</h2>
        <p className="text-sm text-ink-subtle">
          Todo esto corre solo por cron todos los días; los botones son para no esperar.
        </p>
        <div className="flex flex-wrap gap-3">
          <RunJobButton path="/api/sync" label="Correr mi pipeline" />
          <RunJobButton path="/api/jobs/graph/now" label="Recalcular grafo" />
        </div>
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
                  className="flex items-center gap-3 border border-hairline bg-surface-1 p-3"
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

      <section className="flex flex-col gap-3">
        <h2 className="section-heading text-ink">Últimas corridas</h2>
        {jobRuns.length === 0 ? (
          <p className="text-sm text-ink-subtle">Todavía no corrió ningún job para tu cuenta.</p>
        ) : (
          <div className="overflow-x-auto border border-hairline">
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead>
                <tr className="label-mono border-b border-hairline text-ink-tertiary">
                  <th className="px-3 py-2">Job</th>
                  <th className="px-3 py-2">Estado</th>
                  <th className="px-3 py-2">Procesado</th>
                  <th className="px-3 py-2">Restante</th>
                  <th className="px-3 py-2">Fecha</th>
                  <th className="px-3 py-2">Error</th>
                </tr>
              </thead>
              <tbody>
                {jobRuns.map((run) => (
                  <tr key={run.id} className="border-b border-hairline last:border-b-0">
                    <td className="px-3 py-2 text-ink">{JOB_LABELS[run.job] ?? run.job}</td>
                    <td className="px-3 py-2 text-ink-subtle">
                      {RUN_STATUS_LABELS[run.status] ?? run.status}
                    </td>
                    <td className="px-3 py-2 tabular-nums text-ink-subtle">{run.processed}</td>
                    <td className="px-3 py-2 tabular-nums text-ink-subtle">{run.remaining}</td>
                    <td className="px-3 py-2 text-ink-subtle">
                      {formatLongDate(run.startedAt ?? run.createdAt)}
                    </td>
                    <td className="max-w-[200px] truncate px-3 py-2 text-xs text-danger">
                      {run.error ? truncate(run.error, 80) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
