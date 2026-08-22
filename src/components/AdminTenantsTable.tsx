"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** DTO serializable de `AdminTenantRow` (src/lib/admin-service.ts): fechas como ISO string. */
export type AdminTenantDTO = {
  userId: string;
  name: string;
  email: string;
  role: string;
  xConnected: boolean;
  xUsername: string | null;
  itemsTotal: number;
  itemsPublished: number;
  lastJobRun: { job: string; status: string; at: string } | null;
  pipelineEnabled: boolean;
  quota: {
    xPagesPerDay: number;
    xBackfillPages: number;
    xBackfillMonths: number;
    analyzeItemsPerDay: number;
  } | null;
  usage30d: {
    xPageCalls: number;
    ollamaCalls: number;
    anthropic: { calls: number; tokensIn: number; tokensOut: number };
    openaiEmbed: { calls: number; tokensIn: number; tokensOut: number };
  };
};

const RUN_STATUS_LABELS: Record<string, string> = {
  queued: "en cola",
  running: "corriendo",
  ok: "ok",
  error: "error",
  budget: "cortado por tiempo",
};

const dateFormatter = new Intl.DateTimeFormat("es-MX", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

function fmtDate(iso: string): string {
  return dateFormatter.format(new Date(iso));
}

type QuotaFields = {
  xPagesPerDay: number;
  xBackfillPages: number;
  xBackfillMonths: number;
  analyzeItemsPerDay: number;
};

const QUOTA_FIELD_LABELS: Array<{ key: keyof QuotaFields; label: string }> = [
  { key: "xPagesPerDay", label: "X páginas/día" },
  { key: "xBackfillPages", label: "Backfill páginas" },
  { key: "xBackfillMonths", label: "Backfill meses" },
  { key: "analyzeItemsPerDay", label: "Análisis/día" },
];

function AdminTenantRow({ tenant }: { tenant: AdminTenantDTO }) {
  const router = useRouter();
  const initialQuota: QuotaFields = tenant.quota ?? {
    xPagesPerDay: 0,
    xBackfillPages: 0,
    xBackfillMonths: 0,
    analyzeItemsPerDay: 0,
  };
  const [quota, setQuota] = useState<QuotaFields>(initialQuota);
  const [pipelineEnabled, setPipelineEnabled] = useState(tenant.pipelineEnabled);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const dirty =
    QUOTA_FIELD_LABELS.some(({ key }) => quota[key] !== initialQuota[key]) ||
    pipelineEnabled !== tenant.pipelineEnabled;

  async function save() {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/tenants/${tenant.userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...quota, pipelineEnabled }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || data.ok === false) {
        throw new Error(data.error ?? "No se pudo guardar");
      }
      setMessage("Guardado");
      router.refresh();
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const usage = tenant.usage30d;

  return (
    <tr className="border-b border-hairline align-top last:border-b-0">
      <td className="min-w-[180px] px-3 py-3">
        <p className="text-sm font-medium text-ink">{tenant.name}</p>
        <p className="text-xs text-ink-tertiary">{tenant.email}</p>
        {tenant.role === "platform_admin" && (
          <p className="label-mono mt-1 text-brand-orange">platform_admin</p>
        )}
      </td>

      <td className="min-w-[120px] px-3 py-3 text-xs text-ink-subtle">
        {tenant.xConnected ? `@${tenant.xUsername ?? "—"}` : "no conectado"}
      </td>

      <td className="px-3 py-3 text-sm tabular-nums text-ink-subtle">
        {tenant.itemsTotal}
        <span className="text-ink-tertiary"> / {tenant.itemsPublished} pub.</span>
      </td>

      <td className="min-w-[160px] px-3 py-3 text-xs text-ink-subtle">
        {tenant.lastJobRun ? (
          <>
            <p className="text-ink">
              {tenant.lastJobRun.job} · {RUN_STATUS_LABELS[tenant.lastJobRun.status] ?? tenant.lastJobRun.status}
            </p>
            <p className="text-ink-tertiary">{fmtDate(tenant.lastJobRun.at)}</p>
          </>
        ) : (
          "—"
        )}
      </td>

      <td className="min-w-[220px] px-3 py-3 text-xs text-ink-subtle">
        <ul className="flex flex-col gap-0.5 tabular-nums">
          <li>x_page: {usage.xPageCalls}</li>
          <li>ollama_call: {usage.ollamaCalls}</li>
          <li>
            anthropic: {usage.anthropic.calls} llamadas · {usage.anthropic.tokensIn}/{usage.anthropic.tokensOut}{" "}
            tok
          </li>
          <li>openai_embed: {usage.openaiEmbed.tokensIn + usage.openaiEmbed.tokensOut} tok</li>
        </ul>
      </td>

      <td className="min-w-[280px] px-3 py-3">
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
          {QUOTA_FIELD_LABELS.map(({ key, label }) => (
            <label key={key} className="flex flex-col gap-0.5">
              <span className="label-mono text-ink-tertiary">{label}</span>
              <input
                type="number"
                min={0}
                value={quota[key]}
                onChange={(e) =>
                  setQuota((q) => ({ ...q, [key]: Math.max(0, Number(e.target.value) || 0) }))
                }
                className="w-full border border-hairline bg-surface-1 px-2 py-1 text-sm tabular-nums text-ink focus-visible:outline-none"
              />
            </label>
          ))}
        </div>
        <label className="label-mono mt-2 flex items-center gap-2 text-ink-subtle">
          <input
            type="checkbox"
            checked={pipelineEnabled}
            onChange={(e) => setPipelineEnabled(e.target.checked)}
          />
          pipeline activo
        </label>
      </td>

      <td className="min-w-[140px] px-3 py-3">
        <div className="flex flex-col items-start gap-1.5">
          <button
            type="button"
            onClick={save}
            disabled={saving || !dirty}
            className="label-mono border border-ink bg-ink px-3 py-1.5 text-brand-white transition-colors duration-150 hover:border-brand-orange hover:bg-brand-orange disabled:cursor-default disabled:opacity-40"
          >
            {saving ? "Guardando…" : "Guardar"}
          </button>
          {message && (
            <span className={`text-xs ${message === "Guardado" ? "text-ink-subtle" : "text-danger"}`}>
              {message}
            </span>
          )}
        </div>
      </td>
    </tr>
  );
}

export function AdminTenantsTable({ tenants }: { tenants: AdminTenantDTO[] }) {
  if (tenants.length === 0) {
    return <p className="text-sm text-ink-subtle">Todavía no hay tenants registrados.</p>;
  }

  return (
    <div className="overflow-x-auto border border-hairline">
      <table className="w-full min-w-[1100px] text-left text-sm">
        <thead>
          <tr className="label-mono border-b border-hairline text-ink-tertiary">
            <th className="px-3 py-2">Tenant</th>
            <th className="px-3 py-2">X</th>
            <th className="px-3 py-2">Items</th>
            <th className="px-3 py-2">Último JobRun</th>
            <th className="px-3 py-2">Uso 30d</th>
            <th className="px-3 py-2">Cuota</th>
            <th className="px-3 py-2">-</th>
          </tr>
        </thead>
        <tbody>
          {tenants.map((tenant) => (
            <AdminTenantRow key={tenant.userId} tenant={tenant} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
