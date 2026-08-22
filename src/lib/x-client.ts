import { decryptToken, encryptToken } from "@/lib/token-crypto";
import { refreshAccessToken } from "@/lib/x-oauth";
import { withOwner } from "@/lib/tenant-db";

const REFRESH_MARGIN_MS = 60_000; // refrescar si expira en menos de 1 min

// Un token por usuario: x_auth_tokens tiene user_id unico. El userId es obligatorio
// a proposito — no existe "la" cuenta de X de la app, existe la de cada tenant.
//
// Refresh con lock optimista: si dos jobs del mismo tenant corren a la vez y
// ambos ven el access_token vencido, solo uno debe gastar el refresh_token (X
// lo invalida despues de usarlo una vez). El `updateMany` de abajo solo escribe
// si `updatedAt` sigue siendo el que se leyo; si otro proceso ya refresco entre
// medio, la condicion no matchea ninguna fila y se relee la fila fresca en vez
// de pisarla con un refresh_token ya quemado.
export async function getValidAccessToken(
  userId: string,
): Promise<{ xUserId: string; accessToken: string }> {
  return withOwner(userId, async (tx) => {
    const tokenRow = await tx.xAuthToken.findUnique({ where: { userId } });
    if (!tokenRow) {
      throw new Error("No hay ninguna cuenta de X conectada. Conecta tu cuenta en /conexion.");
    }

    if (tokenRow.expiresAt.getTime() - REFRESH_MARGIN_MS > Date.now()) {
      return { xUserId: tokenRow.xUserId, accessToken: decryptToken(tokenRow.accessToken) };
    }

    const refreshToken = decryptToken(tokenRow.refreshToken);
    const refreshed = await refreshAccessToken(refreshToken);
    const expiresAt = new Date(Date.now() + refreshed.expires_in * 1000);

    const updated = await tx.xAuthToken.updateMany({
      where: { userId, updatedAt: tokenRow.updatedAt },
      data: {
        accessToken: encryptToken(refreshed.access_token),
        refreshToken: encryptToken(refreshed.refresh_token ?? refreshToken),
        expiresAt,
      },
    });

    if (updated.count === 0) {
      // Otro proceso ya refresco concurrentemente: usar lo que el dejo, no lo
      // que acabamos de pedir (ese refresh_token nuevo se descarta sin usar).
      const fresh = await tx.xAuthToken.findUniqueOrThrow({ where: { userId } });
      return { xUserId: fresh.xUserId, accessToken: decryptToken(fresh.accessToken) };
    }

    return { xUserId: tokenRow.xUserId, accessToken: refreshed.access_token };
  });
}

type XApiUser = {
  id: string;
  username: string;
  name: string;
};

type XApiMedia = {
  media_key: string;
  type: string;
  url?: string;
  preview_image_url?: string;
};

type XApiTweet = {
  id: string;
  text: string;
  author_id: string;
  created_at: string;
  entities?: { urls?: { expanded_url: string; url: string }[] };
  attachments?: { media_keys?: string[] };
};

export type LikedTweetsPage = {
  tweets: XApiTweet[];
  users: Map<string, XApiUser>;
  media: Map<string, XApiMedia>;
  nextToken: string | undefined;
};

const LIKED_TWEETS_FIELDS = {
  "tweet.fields": "created_at,entities,attachments,author_id",
  expansions: "author_id,attachments.media_keys",
  "user.fields": "username,name",
  "media.fields": "url,preview_image_url,type",
  max_results: "100",
};

// --- Errores de X que el job de ingesta trata distinto de un fallo cualquiera ---

/** 429: la X App compartida (o el tenant) pego contra el rate limit. */
export class XRateLimited extends Error {
  resetAt: Date;
  constructor(resetAt: Date, message = "Rate limited por la X API") {
    super(message);
    this.name = "XRateLimited";
    this.resetAt = resetAt;
  }
}

/** 402, o 4xx cuyo cuerpo menciona "credits depleted": la X App (pay-per-use)
 *  se quedo sin saldo. Es un flag GLOBAL — afecta a todos los tenants por
 *  igual, no solo al que estaba corriendo cuando se detecto. */
export class XCreditsDepleted extends Error {
  constructor(message = "La X App se quedo sin creditos (pay-per-use)") {
    super(message);
    this.name = "XCreditsDepleted";
  }
}

const DEFAULT_RATE_LIMIT_BACKOFF_MS = 15 * 60 * 1000;

function creditsDepletedInText(text: string): boolean {
  return /credits[\s-]?depleted/i.test(text);
}

export async function fetchLikedTweetsPage(params: {
  xUserId: string;
  accessToken: string;
  paginationToken?: string;
}): Promise<LikedTweetsPage> {
  const url = new URL(`https://api.x.com/2/users/${params.xUserId}/liked_tweets`);
  for (const [key, value] of Object.entries(LIKED_TWEETS_FIELDS)) {
    url.searchParams.set(key, value);
  }
  if (params.paginationToken) {
    url.searchParams.set("pagination_token", params.paginationToken);
  }

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${params.accessToken}` },
  });

  if (res.status === 429) {
    const resetHeader = res.headers.get("x-rate-limit-reset");
    const resetEpochSeconds = resetHeader ? Number(resetHeader) : NaN;
    const resetAt = Number.isFinite(resetEpochSeconds)
      ? new Date(resetEpochSeconds * 1000)
      : new Date(Date.now() + DEFAULT_RATE_LIMIT_BACKOFF_MS);
    throw new XRateLimited(resetAt);
  }

  if (!res.ok) {
    const text = await res.text();
    if (res.status === 402 || creditsDepletedInText(text)) {
      throw new XCreditsDepleted(text || undefined);
    }
    throw new Error(`Fallo liked_tweets (${res.status}): ${text}`);
  }

  const json = (await res.json()) as {
    data?: XApiTweet[];
    includes?: { users?: XApiUser[]; media?: XApiMedia[] };
    meta?: { next_token?: string };
  };

  const users = new Map((json.includes?.users ?? []).map((u) => [u.id, u]));
  const media = new Map((json.includes?.media ?? []).map((m) => [m.media_key, m]));

  return {
    tweets: json.data ?? [],
    users,
    media,
    nextToken: json.meta?.next_token,
  };
}

// Primera URL externa distinta del propio tweet (v1: solo se procesa una por item).
export function extractContentUrl(tweet: XApiTweet): string | null {
  const urls = tweet.entities?.urls ?? [];
  const external = urls.find((u) => !/(?:x|twitter)\.com\//.test(u.expanded_url));
  return external?.expanded_url ?? null;
}

export function extractMediaUrls(tweet: XApiTweet, media: Map<string, XApiMedia>): string[] {
  const keys = tweet.attachments?.media_keys ?? [];
  return keys
    .map((key) => media.get(key))
    .filter((m): m is XApiMedia => Boolean(m))
    .map((m) => m.url ?? m.preview_image_url)
    .filter((u): u is string => Boolean(u));
}
