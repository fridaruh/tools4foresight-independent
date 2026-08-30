/**
 * EL CORAZÓN DE ESTE REPO: atender una petición MCP en modo pass-through, sin
 * que el servidor custodie ninguna credencial.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Por qué existe este archivo y no la auth del servidor single-tenant
 * ─────────────────────────────────────────────────────────────────────────────
 * El servidor del que nace este repo tenía DOS credenciales: `T4F_API_KEY`
 * (la clave del servidor contra la API, guardada en el despliegue) y
 * `MCP_ACCESS_TOKEN` (la clave que el servidor exigía a quien lo llamara). Eso
 * funcionaba porque el acervo era UNO: la clave de dentro leía el único banco
 * que había, y el token de fuera solo decidía quién podía mirarlo.
 *
 * Aquí cada persona tiene su propio banco de señales y la API key ES la
 * identidad del banco: resuelve a un dueño y solo devuelve lo suyo. Un
 * despliegue con una clave dentro sería exactamente lo prohibido — todo el
 * mundo leería el banco de una sola persona. Así que:
 *
 *   El `Authorization: Bearer <clave>` que llega del cliente ES su clave de
 *   tools4foresight, y se usa —solo para esta petición— para construir el
 *   cliente HTTP. Este servidor no guarda credenciales de nadie.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ ESTO AÍSLA DE VERDAD A LOS TENANTS (verificado, no supuesto)
 * ─────────────────────────────────────────────────────────────────────────────
 * La caché de respuestas vive en `src/client/cache.ts` como un campo `private`
 * de instancia (`private readonly cache = new Cache(...)` dentro del
 * constructor de `T4FClient`, `src/client/http-client.ts`). No hay ni un `Map`,
 * ni un `let`, ni un singleton a nivel de MÓDULO en todo `src/` — verificado a
 * mano y protegido por `tests/tenant-isolation.test.ts`, que comprueba que la
 * respuesta cacheada de una clave nunca se sirve a otra.
 *
 * La cadena completa es:
 *
 *   petición → `loadConfigForRequest(bearer)` → `createServer(config)` →
 *   `new T4FClient(config)` → `new Cache(...)`
 *
 * Es decir: **una petición, un `T4FClient`, una caché**, y todo eso muere con
 * la respuesta. Dos tenants no comparten ninguna estructura de datos. Si alguna
 * vez alguien "optimiza" esto sacando el cliente o la caché a nivel de módulo
 * —un `const clientCache = new Map<apiKey, T4FClient>()`, por ejemplo—, esa es
 * la fuga que este diseño existe para hacer imposible: la clave de A serviría
 * datos de B en cuanto coincidieran dos claves en la misma instancia caliente,
 * o simplemente en cuanto la clave dejara de formar parte de la clave de caché.
 *
 * El transporte sigue STATELESS (sin `sessionIdGenerator`) por la razón
 * original —en Vercel cada petición puede caer en otra instancia, y una sesión
 * en memoria se perdería a mitad de conversación con un fallo intermitente,
 * lo peor de depurar— y ahora además por una segunda razón que la refuerza:
 * sin sesiones no hay estado de conversación que sobreviva entre peticiones y,
 * por tanto, no hay nada que pueda quedarse asociado al tenant equivocado.
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { ConfigError, MISSING_REQUEST_API_KEY_MESSAGE, loadConfigForRequest } from "./config.js";
import { createServer } from "./server.js";

/**
 * Extrae el Bearer entrante. Devuelve `null` si no hay cabecera o no tiene la
 * forma `Bearer <algo>`.
 *
 * Lo que NO hace, a propósito: comprobar que la clave sea válida. Aquí no se
 * adivina. Una clave presente pero mala se manda igual a la API de
 * tools4foresight, que es la única que sabe a qué dueño resuelve, y su 401 se
 * propaga tal cual. Cualquier heurística local (largo, prefijo `t4f_`) solo
 * podría equivocarse en la dirección peor: rechazar una clave buena.
 */
export function extractBearer(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

function jsonError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** 401 accionable: le dice a una persona qué poner y dónde generarlo. */
export function missingApiKeyResponse(): Response {
  return jsonError(401, "unauthorized", MISSING_REQUEST_API_KEY_MESSAGE);
}

/**
 * 405 al `GET /mcp`, ANTES de mirar la auth: es un rechazo de método, no de
 * identidad, y así un cliente sin clave tampoco se queda colgado.
 *
 * Por qué es obligatorio y no una optimización: en stateless (sin
 * `sessionIdGenerator`) el SDK deja pasar la validación de sesión, así que un
 * GET entra al handler del stream SSE "standalone", abre un `ReadableStream`
 * con keep-alive y NO lo cierra nunca — solo se cerraría al cerrar el
 * transporte, cosa que aquí no pasa porque el transporte muere con la
 * petición. En una función serverless eso es una función viva hasta agotar
 * `maxDuration`, contada como Timeout y facturada como memoria aprovisionada
 * todo ese rato. El cliente ve la conexión caída, reconecta, y el bucle se
 * repite una vez por minuto, 24/7, esté alguien usando el servidor o no.
 * (Pasó: 351 GB-Hrs y la cuota mensual entera en cuatro días.)
 *
 * Y no perdemos nada: ese stream solo sirve para notificaciones
 * servidor→cliente fuera del ciclo de una petición, que este servidor stateless
 * ya renunció a tener a propósito. La spec de Streamable HTTP contempla
 * exactamente esto: un servidor que no ofrece stream en GET debe responder 405.
 */
export function getNotAllowedResponse(): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: "method_not_allowed",
        // Sin ruta literal: este archivo lo comparten el servidor local (`/mcp`)
        // y Vercel (`/api/mcp`), así que nombrar una sería mentirle a la mitad.
        message: "Este servidor MCP es stateless: no ofrece stream SSE en GET. Usa POST en esta misma ruta.",
      },
    }),
    {
      status: 405,
      headers: { "content-type": "application/json; charset=utf-8", allow: "POST, DELETE" },
    },
  );
}

export type PassthroughOpts = {
  /** Opciones extra del transporte (p. ej. `allowedHosts` en el servidor local). */
  transport?: ConstructorParameters<typeof WebStandardStreamableHTTPServerTransport>[0];
  /** Entorno del proceso; inyectable para tests. */
  env?: NodeJS.ProcessEnv;
  /** Etiqueta de los logs de error. */
  logTag?: string;
};

/**
 * Atiende una petición MCP completa en pass-through. Lo usan **los dos** entry
 * points HTTP (`api/mcp.ts` en Vercel y `src/http.ts` en local) para que no
 * puedan divergir: si el modo remoto se probara en local con otra auth, el
 * despliegue acabaría con la auth que nadie probó.
 */
export async function handleMcpRequest(request: Request, opts: PassthroughOpts = {}): Promise<Response> {
  // Antes que nada, y antes que la auth: ver `getNotAllowedResponse`.
  if (request.method === "GET" || request.method === "HEAD") return getNotAllowedResponse();

  const apiKey = extractBearer(request);
  if (!apiKey) return missingApiKeyResponse();

  let config;
  try {
    // La clave de ESTA petición y nada más. No se guarda, no se registra, no se
    // reutiliza en la siguiente.
    config = loadConfigForRequest(apiKey, opts.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      // Config del OPERADOR mal puesta (falta T4F_API_BASE_URL, por ejemplo):
      // no es culpa de quien llama, y el mensaje es accionable para quien
      // administra el despliegue, así que se devuelve tal cual.
      return jsonError(503, "server_not_configured", error.message);
    }
    throw error;
  }

  try {
    // Transporte, servidor y cliente HTTP nuevos por petición: es lo que hace
    // que dos tenants no compartan ni una estructura de datos (ver la cabecera
    // de este archivo).
    //
    // `enableJsonResponse: true`: la respuesta al POST se devuelve como JSON de
    // una pieza en vez de como un stream SSE que hay que cerrar. El SDK sí
    // cierra ese stream al mandar la respuesta, así que no colgaba — pero
    // mantener viva una conexión SSE para entregar un único objeto no aporta
    // nada cuando todas las tools son lecturas cortas, y sí añade un camino en
    // el que un fallo deja la función respirando hasta `maxDuration`. Va aquí y
    // no en cada entry point para que local y Vercel no puedan divergir; el
    // resto de `opts.transport` (p. ej. `allowedHosts` en local) se respeta.
    const transport = new WebStandardStreamableHTTPServerTransport({
      ...opts.transport,
      enableJsonResponse: true,
    });
    const server = createServer(config);
    await server.connect(transport);
    return await transport.handleRequest(request);
  } catch (error) {
    // El error real solo al log del servidor: al cliente no le sirve el stack y
    // podría filtrar configuración. Nunca se registra la clave.
    console.error(`[${opts.logTag ?? "mcp-t4f-multitenant"}] error en el handler HTTP:`, error);
    return jsonError(500, "internal_error", "Error interno del servidor MCP.");
  }
}
