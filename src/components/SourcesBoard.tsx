import type { SourceCount, SourcesSummary } from "@/lib/sources";

// De dónde vienen las señales: top 15 de dominios enlazados y de cuentas de X.
// Server component puro: recibe el resumen ya calculado (src/lib/sources.ts).

function Ranking({
  title,
  hint,
  rows,
  color,
  href,
}: {
  title: string;
  hint: string;
  rows: SourceCount[];
  color: "bg-brand-blue" | "bg-brand-pink";
  href: (name: string) => string;
}) {
  const max = rows[0]?.count ?? 0;
  return (
    <div className="flex flex-1 flex-col gap-3">
      <div>
        <h3 className="label-mono text-ink">{title}</h3>
        <p className="text-xs text-ink-subtle">{hint}</p>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-ink-tertiary">Todavía no hay datos.</p>
      ) : (
        <ol className="flex flex-col gap-1.5">
          {rows.map((row, i) => (
            <li key={row.name} className="flex items-center gap-3 text-sm">
              <span className="w-5 shrink-0 text-right font-mono text-xs text-ink-tertiary">
                {i + 1}
              </span>
              <a
                href={href(row.name)}
                target="_blank"
                rel="noreferrer"
                className="w-44 shrink-0 truncate text-ink hover:text-brand-orange"
                title={row.name}
              >
                {row.name}
              </a>
              <div className="h-2 flex-1 bg-surface-2">
                <div
                  className={`h-2 ${color}`}
                  style={{ width: `${max > 0 ? (row.count / max) * 100 : 0}%` }}
                />
              </div>
              <span className="w-10 shrink-0 text-right font-mono text-xs text-ink-muted">
                {row.count}
              </span>
              <span className="w-10 shrink-0 text-right font-mono text-xs text-ink-tertiary">
                {Math.round(row.share * 100)}%
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function SourcesBoard({ summary }: { summary: SourcesSummary }) {
  const pct = (n: number) => (summary.total > 0 ? Math.round((n / summary.total) * 100) : 0);
  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2 className="section-heading text-ink">Fuentes</h2>
        <p className="text-sm text-ink-subtle">
          De dónde vienen las señales. {summary.total} en total: {summary.fromX} likes de X (
          {pct(summary.fromX)}%), {summary.manual} enlaces manuales ({pct(summary.manual)}%);{" "}
          {summary.withLink} con un link externo ({pct(summary.withLink)}%).
        </p>
      </div>
      <div className="flex flex-col gap-8 md:flex-row">
        <Ranking
          title="Top 15 dominios"
          hint="Sitios enlazados desde los tweets o pegados a mano. El % es sobre las señales con link."
          rows={summary.domains}
          color="bg-brand-blue"
          href={(name) => `https://${name}`}
        />
        <Ranking
          title="Top 15 cuentas de X"
          hint="Autores de los tweets que diste like. El % es sobre los likes de X."
          rows={summary.accounts}
          color="bg-brand-pink"
          href={(name) => `https://x.com/${name}`}
        />
      </div>
    </section>
  );
}
