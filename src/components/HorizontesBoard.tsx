"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { HORIZONS, HORIZON_LABELS, type HorizonKey } from "@/lib/horizons";
import { formatDate } from "@/lib/format";

export type HorizonteCluster = {
  id: string;
  name: string;
  summary: string;
  size: number;
  status: string;
  vitality: number;
  horizon: string | null;
  horizonSuggested: string | null;
  horizonSource: string;
  velocity30d: number;
  velocityPrev30d: number;
  density: number | null;
  connectivity: number | null;
  bridgeClusters: number;
  novelty: number | null;
  firstSeenAt: string;
  lastSignalAt: string | null;
  diedAt: string | null;
  revivedCount: number;
  /** Vitalidad por snapshot (ultimos 90 dias), de mas viejo a mas nuevo. */
  series: { at: string; vitality: number }[];
};

export type HorizontesPayload = {
  clusters: HorizonteCluster[];
  snapshots: {
    id: string;
    takenAt: string;
    trigger: string;
    nodes: number;
    clustersAlive: number;
    clustersDead: number;
    orphans: number;
  }[];
  orphans: number;
  unembedded: number;
};

const HORIZON_COLORS: Record<HorizonKey, string> = {
  H1: "#0a0a0a",
  H2: "#2456d9",
  H3: "#ff4d00",
};

/**
 * Los temas del grafo leidos como tendencias. Sin porcentajes ni probabilidades
 * (decision de Frida): los indicadores se muestran como numeros crudos y flechas,
 * y el horizonte es una hipotesis que se sugiere y se corrige, no una etiqueta
 * que el modelo impone.
 */
export function HorizontesBoard({ payload, canEdit }: { payload: HorizontesPayload; canEdit: boolean }) {
  const alive = payload.clusters.filter((c) => c.status === "alive");
  const dead = payload.clusters.filter((c) => c.status !== "alive");
  const latest = payload.snapshots[0] ?? null;
  const byHorizon = (h: HorizonKey) => alive.filter((c) => c.horizon === h).length;

  const stats = [
    { label: "Temas vivos", value: alive.length },
    { label: "Temas muertos", value: dead.length },
    { label: "Señales huérfanas", value: payload.orphans },
    { label: "Snapshots", value: payload.snapshots.length },
  ];

  return (
    <>
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="section-title text-ink">Horizontes</h1>
          <p className="mt-1 max-w-2xl text-sm text-ink-subtle">
            Los temas del grafo leídos como tendencias: qué ya está pasando, qué está en transición y qué
            es todavía una señal débil.{" "}
            {canEdit
              ? "El horizonte se sugiere a partir de los indicadores; tú lo confirmas o lo corriges."
              : "El horizonte se sugiere a partir de los indicadores y lo confirma la curadora."}
            {latest && (
              <>
                {" "}
                Última corrida: {formatDate(latest.takenAt)} ({latest.trigger}).
              </>
            )}
            {canEdit && payload.unembedded > 0 && (
              <span className="text-brand-orange">
                {" "}
                · {payload.unembedded} publicadas sin embeber aún: corre el job de embeddings local para que
                entren.
              </span>
            )}
          </p>
        </div>
        <ExportMenu />
      </header>

      <section className="grid gap-3 sm:grid-cols-4">
        {stats.map((stat) => (
          <div key={stat.label} className="rounded-xl border border-hairline bg-surface-1 p-4">
            <p className="label-mono text-ink-tertiary">{stat.label}</p>
            <p className="mt-1 text-3xl font-semibold tabular-nums tracking-tight text-ink">{stat.value}</p>
          </div>
        ))}
      </section>

      <section className="grid gap-3 md:grid-cols-3">
        {HORIZONS.map((h) => (
          <div key={h} className="rounded-xl border border-hairline bg-surface-1 p-4">
            <p className="label-mono flex items-center gap-2 text-ink-tertiary">
              <span aria-hidden className="h-2 w-2" style={{ backgroundColor: HORIZON_COLORS[h] }} />
              {HORIZON_LABELS[h].short}
              <span className="ml-auto tabular-nums text-ink">{byHorizon(h)}</span>
            </p>
            <p className="mt-1 text-xs text-ink-subtle">{HORIZON_LABELS[h].long}</p>
          </div>
        ))}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="section-heading text-ink">Temas vivos</h2>
        <ClusterTable clusters={alive} alive canEdit={canEdit} />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="section-heading text-ink">Temas muertos</h2>
        <p className="text-xs text-ink-subtle">
          Perdieron vitalidad (vida media de 30 días sin señales nuevas cerca) o dejaron de detectarse. No se
          borran: si llegan señales nuevas, resucitan y aquí queda registrado.
        </p>
        <ClusterTable clusters={dead} alive={false} canEdit={false} />
      </section>

      {payload.snapshots.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="section-heading text-ink">Corridas recientes</h2>
          <div className="overflow-x-auto rounded-xl border border-hairline">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="label-mono border-b border-ink bg-surface-1 text-left text-ink-subtle">
                  <th className="px-3 py-2 font-medium">Fecha</th>
                  <th className="px-3 py-2 font-medium">Disparador</th>
                  <th className="px-3 py-2 text-right font-medium">Señales</th>
                  <th className="px-3 py-2 text-right font-medium">Vivos</th>
                  <th className="px-3 py-2 text-right font-medium">Muertos</th>
                  <th className="px-3 py-2 text-right font-medium">Huérfanas</th>
                </tr>
              </thead>
              <tbody>
                {payload.snapshots.slice(0, 10).map((s) => (
                  <tr key={s.id} className="border-b border-hairline last:border-b-0">
                    <td className="px-3 py-2 text-ink">{new Date(s.takenAt).toLocaleString("es-MX")}</td>
                    <td className="px-3 py-2">
                      <span className="label-mono text-[10px] text-ink-muted">{s.trigger}</span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-ink-subtle">{s.nodes}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-ink-subtle">{s.clustersAlive}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-ink-subtle">{s.clustersDead}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-ink-subtle">{s.orphans}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}

function ClusterTable({
  clusters,
  alive,
  canEdit,
}: {
  clusters: HorizonteCluster[];
  /** Tabla de vivos (columna "Desde") o de muertos (columna "Murió"). */
  alive: boolean;
  /** Solo admin: el select que fija el horizonte; member ve la etiqueta. */
  canEdit: boolean;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-hairline">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="label-mono border-b border-ink bg-surface-1 text-left text-ink-subtle">
            <th className="px-3 py-2 font-medium">Tema</th>
            <th className="px-3 py-2 font-medium">Horizonte</th>
            <th className="px-3 py-2 text-right font-medium" title="Suma de la vitalidad de sus señales">
              Vitalidad
            </th>
            <th className="px-3 py-2 font-medium" title="Vitalidad en las últimas corridas">
              Tendencia
            </th>
            <th className="px-3 py-2 text-right font-medium" title="Señales likeadas en los últimos 30 días vs. los 30 anteriores">
              Velocidad
            </th>
            <th className="px-3 py-2 text-right font-medium" title="Cohesión: qué tan cerca están sus señales del centro del tema">
              Densidad
            </th>
            <th className="px-3 py-2 text-right font-medium" title="Proporción de enlaces que salen hacia otros temas · temas vecinos">
              Conectividad
            </th>
            <th className="px-3 py-2 text-right font-medium" title="Distancia del tema al centro de todo el mapa">
              Novedad
            </th>
            <th className="px-3 py-2 text-right font-medium">Señales</th>
            <th className="px-3 py-2 font-medium">{alive ? "Desde" : "Murió"}</th>
          </tr>
        </thead>
        <tbody>
          {clusters.map((c) => (
            <tr key={c.id} className="border-b border-hairline align-top last:border-b-0">
              <td className="max-w-xs px-3 py-2 text-ink">
                <p className="font-medium">
                  {c.name}
                  {c.revivedCount > 0 && (
                    <span className="label-mono ml-2 text-[10px] text-brand-orange" title="Veces que resucitó">
                      ↺{c.revivedCount}
                    </span>
                  )}
                </p>
                {c.summary && <p className="mt-0.5 text-xs text-ink-subtle">{c.summary}</p>}
              </td>
              <td className="px-3 py-2">
                {canEdit ? <HorizonSelect cluster={c} /> : <HorizonTag cluster={c} dim={!alive} />}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-ink">{c.vitality.toFixed(1)}</td>
              <td className="px-3 py-2">
                <Sparkline series={c.series} />
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-ink-subtle">
                <Velocity now={c.velocity30d} prev={c.velocityPrev30d} />
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-ink-subtle">{fmt(c.density)}</td>
              <td className="px-3 py-2 text-right tabular-nums text-ink-subtle">
                {fmt(c.connectivity)}
                {c.bridgeClusters > 0 && <span className="text-ink-tertiary"> · {c.bridgeClusters}</span>}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-ink-subtle">{fmt(c.novelty)}</td>
              <td className="px-3 py-2 text-right tabular-nums text-ink-subtle">{c.size}</td>
              <td className="px-3 py-2 text-ink-subtle">
                {alive ? formatDate(c.firstSeenAt) : formatDate(c.diedAt)}
              </td>
            </tr>
          ))}
          {clusters.length === 0 && (
            <tr>
              <td colSpan={10} className="px-3 py-8 text-center text-sm text-ink-subtle">
                {!alive
                  ? "Ningún tema ha muerto todavía."
                  : canEdit
                    ? "Todavía no hay temas. Corre el job del grafo desde Sistema (o el de embeddings en local)."
                    : "Todavía no hay temas: el mapa se construye conforme se publican señales."}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/** Horizonte en solo lectura (member, y temas muertos para todos). */
function HorizonTag({ cluster, dim }: { cluster: HorizonteCluster; dim: boolean }) {
  const h = cluster.horizon as HorizonKey | null;
  if (!h) return <span className="text-ink-tertiary">—</span>;
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-sm ${dim ? "text-ink-tertiary" : "text-ink"}`}
      title={HORIZON_LABELS[h].long}
    >
      <span aria-hidden className="h-2 w-2" style={{ backgroundColor: dim ? "#bfbfbf" : HORIZON_COLORS[h] }} />
      {HORIZON_LABELS[h].short}
    </span>
  );
}

function HorizonSelect({ cluster }: { cluster: HorizonteCluster }) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const manual = cluster.horizonSource === "manual";

  async function save(value: string) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/clusters/${cluster.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ horizon: value === "auto" ? null : value }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "No se pudo guardar");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <select
        aria-label={`Horizonte de ${cluster.name}`}
        value={manual ? (cluster.horizon ?? "auto") : "auto"}
        disabled={saving}
        onChange={(e) => save(e.target.value)}
        className="rounded-md border border-hairline bg-canvas px-2 py-1 text-sm text-ink"
        style={{ borderLeftWidth: 3, borderLeftColor: cluster.horizon ? HORIZON_COLORS[cluster.horizon as HorizonKey] : "#bfbfbf" }}
      >
        <option value="auto">
          Sugerido{cluster.horizonSuggested ? `: ${cluster.horizonSuggested}` : ""}
        </option>
        {HORIZONS.map((h) => (
          <option key={h} value={h}>
            {HORIZON_LABELS[h].short}
          </option>
        ))}
      </select>
      {manual && cluster.horizonSuggested && cluster.horizonSuggested !== cluster.horizon && (
        <span className="label-mono text-[10px] text-ink-tertiary">heurística: {cluster.horizonSuggested}</span>
      )}
      {error && <span className="text-[10px] text-brand-orange">{error}</span>}
    </div>
  );
}

function Velocity({ now, prev }: { now: number; prev: number }) {
  const arrow = now > prev ? "↑" : now < prev ? "↓" : "→";
  const color = now > prev ? "text-brand-orange" : now < prev ? "text-ink-tertiary" : "text-ink-subtle";
  return (
    <span title={`${now} en los últimos 30 días · ${prev} en los 30 anteriores`}>
      {now} <span className={color}>{arrow}</span>
    </span>
  );
}

/** Chispa de vitalidad sobre los snapshots. Con un solo punto dibuja un punto:
 *  la serie empieza a valer cuando el cron lleve unos dias tomando fotos. */
function Sparkline({ series }: { series: { at: string; vitality: number }[] }) {
  const w = 72;
  const h = 18;
  if (series.length === 0) return <span className="text-ink-tertiary">—</span>;
  const max = Math.max(...series.map((p) => p.vitality), 0.001);
  const pts = series.map((p, i) => {
    const x = series.length === 1 ? w / 2 : (i / (series.length - 1)) * (w - 2) + 1;
    const y = h - 1 - (p.vitality / max) * (h - 2);
    return [x, y] as const;
  });
  const d = pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const [lx, ly] = pts[pts.length - 1];
  return (
    <svg width={w} height={h} aria-label={`${series.length} corridas`} className="block">
      {pts.length > 1 && <path d={d} fill="none" stroke="#8a8a85" strokeWidth={1} />}
      <circle cx={lx} cy={ly} r={1.8} fill="#ff4d00" />
    </svg>
  );
}

function ExportMenu() {
  const kinds = [
    { kind: "temas", label: "Temas" },
    { kind: "senales", label: "Señales" },
    { kind: "historial", label: "Historial" },
  ];
  return (
    <div className="flex flex-col items-end gap-2">
      <Link
        href="/metodologia"
        className="nav-label border border-ink bg-ink px-3 py-1.5 text-brand-white transition-colors duration-150 hover:border-brand-orange hover:bg-brand-orange"
      >
        Metodología →
      </Link>
      <div className="flex items-center gap-2">
        <span className="label-mono text-ink-tertiary">CSV</span>
      {kinds.map((k) => (
        <a
          key={k.kind}
          href={`/api/horizontes/export?kind=${k.kind}`}
          className="nav-label border border-hairline px-3 py-1.5 text-ink transition-colors duration-150 hover:border-ink"
        >
          {k.label}
        </a>
      ))}
      </div>
    </div>
  );
}

function fmt(n: number | null): string {
  return n === null ? "—" : n.toFixed(2);
}
