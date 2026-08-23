const FETCH_TIMEOUT_MS = 8000;

// UA amigable con robots.txt: identifica al bot y da una URL de contacto (PLAN 3.3).
// NEXT_PUBLIC_APP_URL es la misma que ya usa el resto de la app para construir links
// absolutos; el fallback solo aplica en scripts locales que no la definen.
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://tools4foresight.app";
const USER_AGENT = `tools4foresight-bot/1.0 (+${APP_URL})`;

export type FetchedContent = {
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  publishedAt: Date | null;
};

const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#x27;": "'",
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;|&lt;|&gt;|&quot;|&#x27;|&#39;|&apos;|&nbsp;/g, (entity) => HTML_ENTITIES[entity])
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function extractMetaContent(html: string, property: string): string | null {
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${property}["'][^>]*content=["']([^"']*)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${property}["']`, "i"),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return decodeHtmlEntities(match[1]);
  }
  return null;
}

function extractTitleTag(html: string): string | null {
  const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return match?.[1] ? decodeHtmlEntities(match[1]).trim() : null;
}

/**
 * Fecha de publicación del contenido, no de cuando lo detectamos: la mayoría de
 * los sitios (sobre todo .gob.mx) no traen `article:published_time`, así que se
 * intentan varias fuentes en orden de confianza antes de rendirse.
 */
function extractPublishedDate(html: string): Date | null {
  const metaCandidates = [
    "article:published_time",
    "og:article:published_time",
    "datePublished",
    "date",
    "publish-date",
    "publishdate",
    "pubdate",
    "sailthru.date",
    "parsely-pub-date",
    "article.published",
    "dc.date",
    "dc.date.issued",
    "og:updated_time",
    "article:modified_time",
  ];
  for (const name of metaCandidates) {
    const raw = extractMetaContent(html, name);
    if (raw && !Number.isNaN(Date.parse(raw))) return new Date(raw);
  }

  // itemprop="datePublished" (Schema.org microdata inline, sin ir por JSON-LD).
  const itemprop = html.match(
    /<[^>]+itemprop=["']datePublished["'][^>]*content=["']([^"']*)["']/i,
  );
  if (itemprop?.[1] && !Number.isNaN(Date.parse(itemprop[1]))) return new Date(itemprop[1]);

  // JSON-LD: "datePublished":"..." dentro de cualquier <script type="application/ld+json">.
  const ldJsonBlocks = html.matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  );
  for (const block of ldJsonBlocks) {
    const match = block[1].match(/"datePublished"\s*:\s*"([^"]+)"/);
    if (match?.[1] && !Number.isNaN(Date.parse(match[1]))) return new Date(match[1]);
  }

  // <time datetime="..."> como último recurso — a veces es la fecha del comentario
  // más reciente y no la de publicación, por eso va al final.
  const time = html.match(/<time[^>]+datetime=["']([^"']+)["']/i);
  if (time?.[1] && !Number.isNaN(Date.parse(time[1]))) return new Date(time[1]);

  return null;
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
    });
  } finally {
    clearTimeout(timeout);
  }
}

// Server-side (evita CORS y no expone la IP del cliente). 1 reintento ante fallos de red.
export async function fetchContentMetadata(url: string): Promise<FetchedContent> {
  let res: Response;
  try {
    res = await fetchWithTimeout(url);
  } catch {
    res = await fetchWithTimeout(url); // un reintento
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} al hacer fetch de ${url}`);
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html")) {
    throw new Error(`Content-Type no es HTML (${contentType})`);
  }

  const html = await res.text();

  return {
    title: extractMetaContent(html, "og:title") ?? extractTitleTag(html),
    description: extractMetaContent(html, "og:description") ?? extractMetaContent(html, "description"),
    imageUrl: extractMetaContent(html, "og:image"),
    publishedAt: extractPublishedDate(html),
  };
}
