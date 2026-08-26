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
    const transport = new WebStandardStreamableHTTPServerTransport(opts.transport);
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
