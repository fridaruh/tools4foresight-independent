import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

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

// --- state firmado (fase 2.1) ---------------------------------------------
//
// El `state` de OAuth ya no es un valor aleatorio que se compara contra una
// cookie: lleva el userId de la sesión que inició el flujo, firmado con
// HMAC-SHA256(AUTH_SECRET). El callback verifica la firma y que el userId
// coincida con la sesión actual, así que aunque alguien reutilice o intercepte
// un `state` viejo no puede colarlo en la cuenta de otro usuario. `ts` acota la
// validez a 10 minutos, lo mismo que la cookie del code_verifier.

const STATE_MAX_AGE_MS = 10 * 60 * 1000;

type OAuthStatePayload = {
  userId: string;
  nonce: string;
  ts: number;
};

function base64url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(input: string): Buffer {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded, "base64");
}

function signPayload(payloadB64: string): string {
  const sig = createHmac("sha256", getEnv("AUTH_SECRET")).update(payloadB64).digest();
  return base64url(sig);
}

/** Firma un `state` ligado a `userId`: solo la sesión que lo generó lo puede usar. */
export function signOAuthState(userId: string): string {
  const payload: OAuthStatePayload = {
    userId,
    nonce: randomBytes(16).toString("hex"),
    ts: Date.now(),
  };
  const payloadB64 = base64url(Buffer.from(JSON.stringify(payload)));
  return `${payloadB64}.${signPayload(payloadB64)}`;
}

/**
 * Verifica que `state` esté firmado por esta app, no tenga más de 10 minutos y
 * pertenezca a `expectedUserId` (el usuario de la sesión actual del callback).
 */
export function verifyOAuthState(state: string, expectedUserId: string): boolean {
  const [payloadB64, sigB64] = state.split(".");
  if (!payloadB64 || !sigB64) return false;

  const expectedSig = base64urlDecode(signPayload(payloadB64));
  const actualSig = base64urlDecode(sigB64);
  if (expectedSig.length !== actualSig.length || !timingSafeEqual(expectedSig, actualSig)) {
    return false;
  }

  let payload: OAuthStatePayload;
  try {
    payload = JSON.parse(base64urlDecode(payloadB64).toString("utf8"));
  } catch {
    return false;
  }

  if (payload.userId !== expectedUserId) return false;
  if (Date.now() - payload.ts > STATE_MAX_AGE_MS) return false;

  return true;
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

export type AuthenticatedXUser = {
  id: string;
  /** @handle sin arroba, tal como lo devuelve /2/users/me. */
  username: string;
};

/**
 * Trae id + @handle de la cuenta que acaba de autorizar. El callback guarda los
 * dos: `id` es la clave estable (lo que ya usaba el chequeo de "cuenta ya
 * conectada"), `username` es lo único legible que /conexion le puede mostrar al
 * usuario (PLAN 4.2).
 */
export async function fetchAuthenticatedXUser(accessToken: string): Promise<AuthenticatedXUser> {
  const res = await fetch(X_ME_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Fallo al obtener el usuario autenticado (${res.status}): ${text}`);
  }

  const json = (await res.json()) as { data: { id: string; username: string } };
  return { id: json.data.id, username: json.data.username };
}
