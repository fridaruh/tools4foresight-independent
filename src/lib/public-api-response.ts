import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { PublicApiError, requirePublicApiKey } from "@/lib/public-api-auth";
import { checkPublicRateLimit } from "@/lib/public-rate-limit";

export const PUBLIC_API_VERSION = "v1";

export type ApiMeta = {
  nextCursor: string | null;
  hasMore: boolean;
  count: number;
  total?: number;
  generatedAt: string;
};

/**
 * El origen tenía además `api_disabled` (503), que salía de no haber claves de
 * entorno configuradas. Aquí no existen esas claves (PLAN_MCP §0.1), así que el
 * código se fue con ellas: sin clave válida la respuesta es 401, no "servicio
 * apagado".
 */
export type ErrorCode =
  | "unauthorized"
  | "invalid_api_key"
  | "rate_limited"
  | "not_found"
  | "invalid_parameter"
  | "internal_error";

/** "live" (no-store), "short" (60s), "graph" (300s), "static" (3600s). */
export type CacheProfile = "live" | "short" | "graph" | "static";

const CACHE_MAX_AGE: Record<Exclude<CacheProfile, "live">, number> = {
  short: 60,
  graph: 300,
  static: 3600,
};

function cacheControlFor(cache: CacheProfile): string {
  if (cache === "live") return "private, no-store";
  const maxAge = CACHE_MAX_AGE[cache];
  // `private` y nunca `public`: cada respuesta es el banco de UNA persona. Un CDN
  // intermedio que compartiera la respuesta de una clave con otra estaría
  // filtrando el material de un tenant a otro — es el peor fallo posible aquí.
  return `private, max-age=${maxAge}, stale-while-revalidate=${maxAge * 2}`;
}

/**
 * Refleja el origen solicitante solo si está en la lista blanca — nunca `*`.
 * Vacía la variable (default) y el CORS queda apagado: la API sigue funcionando
 * para server-to-server (el MCP), simplemente ningún navegador podrá leer la
 * respuesta desde JS.
 */
export function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin");
  const allowed = (process.env.T4F_PUBLIC_API_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

  const headers: Record<string, string> = { Vary: "Authorization, Origin" };
  if (origin && allowed.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function applyStandardHeaders(
  response: NextResponse,
  request: Request | undefined,
  cache: CacheProfile,
): void {
  response.headers.set("Content-Type", "application/json; charset=utf-8");
  response.headers.set("Cache-Control", cacheControlFor(cache));
  response.headers.set("X-T4F-Api-Version", PUBLIC_API_VERSION);
  const cors = request ? corsHeaders(request) : { Vary: "Authorization, Origin" };
  for (const [key, value] of Object.entries(cors)) {
    response.headers.set(key, value);
  }
}

/** Respuesta OPTIONS del preflight de CORS. Sin auth: un preflight no manda Authorization. */
export function handleOptions(request: Request): NextResponse {
  const response = new NextResponse(null, { status: 204 });
  for (const [key, value] of Object.entries(corsHeaders(request))) {
    response.headers.set(key, value);
  }
  response.headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  response.headers.set("Access-Control-Max-Age", "86400");
  return response;
}

/**
 * Envelope de éxito `{ data, meta }`. `meta` siempre lleva `apiVersion` y
 * `generatedAt`; los campos de paginación (`nextCursor`, `hasMore`, `count`) se
 * completan con defaults razonables si el caller no los pasa (un detalle —"objeto
 * plano" en el sentido de que `data` no es una lista— igual queda envuelto en el
 * mismo `{ data, meta }` para que el cliente MCP parsee todo con una sola forma).
 */
export function ok<T>(
  data: T,
  init: { meta?: Partial<ApiMeta>; cache?: CacheProfile; request: Request },
): NextResponse {
  const { meta, cache = "short", request } = init;
  const generatedAt = meta?.generatedAt ?? new Date().toISOString();
  const fullMeta = {
    apiVersion: PUBLIC_API_VERSION,
    nextCursor: null,
    hasMore: false,
    count: Array.isArray(data) ? data.length : 1,
    ...meta,
    generatedAt,
  };

  const response = NextResponse.json({ data, meta: fullMeta }, { status: 200 });
  applyStandardHeaders(response, request, cache);
  return response;
}

/**
 * Envelope de error uniforme. `param` lleva el nombre del query param que falló
 * cuando aplica (p.ej. "cursor", "horizon"); `null` en el resto de los casos.
 */
export function fail(
  code: ErrorCode,
  message: string,
  status: number,
  request?: Request,
  param: string | null = null,
): NextResponse {
  const response = NextResponse.json(
    {
      error: { code, message, param },
      meta: { apiVersion: PUBLIC_API_VERSION, generatedAt: new Date().toISOString() },
    },
    { status },
  );
  applyStandardHeaders(response, request, "live");
  return response;
}

/**
 * El tercer argumento del handler es el tenant ya resuelto. Se pasa así —y no como
 * algo que el handler tenga que ir a buscar— para que la ruta a `withOwner()` sea
 * la de menor resistencia: `ownerId` está a mano, no hay que llamar a nada, y
 * escribir un query sin dueño requiere ignorarlo activamente.
 */
type PublicApiHandler<Ctx> = (
  request: NextRequest,
  ctx: Ctx,
  auth: { ownerId: string; keyId: string },
) => Promise<NextResponse> | NextResponse;

/**
 * Envuelve un route handler de `/api/public/v1/**`: valida la API key, resuelve el
 * tenant, aplica el rate limit por dueño, y traduce cualquier `PublicApiError` (o
 * cualquier otro throw) a la respuesta que corresponde. Ningún route handler
 * individual repite esta plomería.
 *
 * `options.expensive` usa el límite reducido de 10/min (public-rate-limit.ts) para
 * endpoints costosos como `/graph` o `/snapshots/[id]?includeMembers`.
 */
export function withPublicApi<Ctx = unknown>(
  handler: PublicApiHandler<Ctx>,
  options?: { expensive?: boolean },
) {
  return async function publicApiRoute(request: NextRequest, ctx: Ctx): Promise<NextResponse> {
    // `await`: la validación va a Postgres (es la única fuente de claves) y el
    // rate limit también. La firma de los route handlers no cambia — los `await`
    // viven aquí y solo aquí.
    const authResult = await requirePublicApiKey(request);
    if (authResult instanceof NextResponse) {
      for (const [key, value] of Object.entries(corsHeaders(request))) {
        authResult.headers.set(key, value);
      }
      return authResult;
    }

    const rate = await checkPublicRateLimit(authResult.key, { expensive: options?.expensive });
    if (rate.limited) {
      const response = fail(
        "rate_limited",
        "Límite de peticiones alcanzado. Espera antes de reintentar.",
        429,
        request,
      );
      for (const [key, value] of Object.entries(rate.headers)) response.headers.set(key, value);
      response.headers.set("Retry-After", String(rate.retryAfterSeconds));
      return response;
    }

    try {
      const response = await handler(request, ctx, {
        ownerId: authResult.key.ownerId,
        keyId: authResult.key.keyId,
      });
      for (const [key, value] of Object.entries(rate.headers)) response.headers.set(key, value);
      return response;
    } catch (error) {
      if (error instanceof PublicApiError) {
        return fail(error.code, error.message, error.status, request, error.param);
      }
      // Nunca se expone el stack ni el mensaje crudo de Prisma (puede filtrar
      // nombres de columnas/tablas del esquema real): solo queda en el log del
      // servidor, la respuesta siempre es el genérico.
      console.error("[public-api] error interno no controlado:", error);
      return fail("internal_error", "Error interno del servidor.", 500, request);
    }
  };
}
