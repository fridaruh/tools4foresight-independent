export const X_AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
export const X_TOKEN_URL = "https://api.x.com/2/oauth2/token";
export const X_ME_URL = "https://api.x.com/2/users/me";

export const X_OAUTH_SCOPES = "tweet.read users.read like.read offline.access";

function getEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Falta la variable de entorno ${name}`);
  }
  return value;
}

function basicAuthHeader(): string {
  const clientId = getEnv("X_OAUTH_CLIENT_ID");
  const clientSecret = getEnv("X_OAUTH_CLIENT_SECRET");
  return "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
}

export function buildAuthorizeUrl(params: { state: string; codeChallenge: string }): string {
  const url = new URL(X_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", getEnv("X_OAUTH_CLIENT_ID"));
  url.searchParams.set("redirect_uri", getEnv("X_OAUTH_REDIRECT_URI"));
  url.searchParams.set("scope", X_OAUTH_SCOPES);
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export type XTokenResponse = {
  token_type: string;
  expires_in: number;
  access_token: string;
  scope: string;
  refresh_token?: string;
};

export async function exchangeCodeForTokens(params: {
  code: string;
  codeVerifier: string;
}): Promise<XTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: getEnv("X_OAUTH_REDIRECT_URI"),
    code_verifier: params.codeVerifier,
  });

  const res = await fetch(X_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: basicAuthHeader(),
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Fallo el intercambio de codigo por tokens (${res.status}): ${text}`);
  }

  return res.json();
}

export async function refreshAccessToken(refreshToken: string): Promise<XTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

  const res = await fetch(X_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: basicAuthHeader(),
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Fallo el refresh de token (${res.status}): ${text}`);
  }

  return res.json();
}

export async function fetchAuthenticatedUserId(accessToken: string): Promise<string> {
  const res = await fetch(X_ME_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Fallo al obtener el usuario autenticado (${res.status}): ${text}`);
  }

  const json = (await res.json()) as { data: { id: string } };
  return json.data.id;
}
