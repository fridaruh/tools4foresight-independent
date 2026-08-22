import { prisma } from "@/lib/prisma";
import { decryptToken, encryptToken } from "@/lib/token-crypto";
import { refreshAccessToken } from "@/lib/x-oauth";

const REFRESH_MARGIN_MS = 60_000; // refrescar si expira en menos de 1 min

// Un token por usuario: x_auth_tokens tiene user_id unico. El userId es obligatorio
// a proposito — no existe "la" cuenta de X de la app, existe la de cada tenant.
// TODO(fase2.2): refresh con lock optimista (chequeo de updatedAt) para que dos
// jobs concurrentes del mismo tenant no quemen el refresh_token dos veces.
export async function getValidAccessToken(
  userId: string,
): Promise<{ xUserId: string; accessToken: string }> {
  const tokenRow = await prisma.xAuthToken.findUnique({ where: { userId } });
  if (!tokenRow) {
    throw new Error("No hay ninguna cuenta de X conectada. Conecta tu cuenta en /conexion.");
  }

  if (tokenRow.expiresAt.getTime() - REFRESH_MARGIN_MS > Date.now()) {
    return { xUserId: tokenRow.xUserId, accessToken: decryptToken(tokenRow.accessToken) };
  }

  const refreshToken = decryptToken(tokenRow.refreshToken);
  const refreshed = await refreshAccessToken(refreshToken);
  const expiresAt = new Date(Date.now() + refreshed.expires_in * 1000);

  await prisma.xAuthToken.update({
    where: { userId },
    data: {
      accessToken: encryptToken(refreshed.access_token),
      refreshToken: encryptToken(refreshed.refresh_token ?? refreshToken),
      expiresAt,
    },
  });

  return { xUserId: tokenRow.xUserId, accessToken: refreshed.access_token };
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

  if (!res.ok) {
    const text = await res.text();
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
