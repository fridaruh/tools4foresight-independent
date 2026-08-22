// De dónde vienen las señales: ranking de dominios enlazados y de cuentas de X.
// Lógica pura para que la página de categorías (y cualquier otra) solo pase filas.

export type SourceRow = {
  source: string; // x_like | manual
  authorHandle: string;
  contentUrl: string | null;
  tweetUrl: string;
};

export type SourceCount = { name: string; count: number; share: number };

export type SourcesSummary = {
  total: number;
  withLink: number;
  fromX: number;
  manual: number;
  domains: SourceCount[];
  accounts: SourceCount[];
};

export const SOURCES_TOP_N = 15;

// Dominios que son "el transporte", no la fuente: un tweet que enlaza a otro
// tweet o a un acortador no aporta como dominio.
const TRANSPORT_HOSTS = new Set(["x.com", "twitter.com", "t.co", "mobile.twitter.com"]);

// Alias del mismo sitio que conviene contar juntos.
const HOST_ALIASES: Record<string, string> = {
  "youtu.be": "youtube.com",
  "m.youtube.com": "youtube.com",
  "gist.github.com": "github.com",
  "arxiv.org": "arxiv.org",
};

export function normalizeDomain(url: string | null | undefined): string | null {
  if (!url) return null;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  host = host.replace(/^www\./, "").replace(/^m\./, "").replace(/^amp\./, "");
  if (!host || TRANSPORT_HOSTS.has(host)) return null;
  return HOST_ALIASES[host] ?? host;
}

function rank(counter: Map<string, number>, total: number, topN: number): SourceCount[] {
  return [...counter.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, topN)
    .map(([name, count]) => ({ name, count, share: total > 0 ? count / total : 0 }));
}

export function summarizeSources(rows: SourceRow[], topN = SOURCES_TOP_N): SourcesSummary {
  const domains = new Map<string, number>();
  const accounts = new Map<string, number>();
  let withLink = 0;
  let fromX = 0;
  let manual = 0;

  for (const row of rows) {
    const isManual = row.source === "manual";
    if (isManual) manual += 1;
    else fromX += 1;

    // Para un enlace manual la URL vive en tweetUrl y contentUrl; para un like
    // de X solo contentUrl trae el link externo (si lo hay).
    const domain = normalizeDomain(row.contentUrl ?? (isManual ? row.tweetUrl : null));
    if (domain) {
      withLink += 1;
      domains.set(domain, (domains.get(domain) ?? 0) + 1);
    }

    // Las cuentas solo cuentan para likes reales: en un item manual authorHandle
    // es el dominio, no una cuenta.
    if (!isManual && row.authorHandle) {
      const handle = row.authorHandle.replace(/^@/, "").toLowerCase();
      accounts.set(handle, (accounts.get(handle) ?? 0) + 1);
    }
  }

  return {
    total: rows.length,
    withLink,
    fromX,
    manual,
    domains: rank(domains, withLink, topN),
    accounts: rank(accounts, fromX, topN),
  };
}
