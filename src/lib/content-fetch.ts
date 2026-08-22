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
  const publishedRaw = extractMetaContent(html, "article:published_time");

  return {
    title: extractMetaContent(html, "og:title") ?? extractTitleTag(html),
    description: extractMetaContent(html, "og:description") ?? extractMetaContent(html, "description"),
    imageUrl: extractMetaContent(html, "og:image"),
    publishedAt: publishedRaw && !Number.isNaN(Date.parse(publishedRaw)) ? new Date(publishedRaw) : null,
  };
}
