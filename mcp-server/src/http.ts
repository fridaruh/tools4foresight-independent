/**
 * Entry point HTTP local (`npm run dev:http`): el MISMO transporte y la MISMA
 * auth pass-through que el despliegue de Vercel, pero sobre `node:http` puro —
 * sin Express, sin dependencias extra.
 *
 * Sirve para probar el modo remoto en local con el MCP Inspector antes de
 * desplegar. Comparte `handleMcpRequest` con `api/mcp.ts` a propósito: la regla
 * original sigue valiendo —si el modo remoto se prueba con otra auth, el
 * despliegue acaba con la auth que nadie probó— y en multi-tenant es peor,
 * porque lo que no se probaría es justo el aislamiento entre tenants.
 *
 * O sea: aquí tampoco se lee `T4F_API_KEY`. La clave la manda el cliente en la
 * cabecera `Authorization`, igual que en producción.
 */
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { ConfigError, loadConfigForRequest } from "./config.js";
import { SERVER_NAME, SERVER_VERSION } from "./server.js";
import { handleMcpRequest } from "./http-passthrough.js";

const PORT = Number(process.env.MCP_PORT ?? 3333);
const HOST = "127.0.0.1";

/** `node:http` habla en streams; el transporte habla en `Request`/`Response` web. */
async function toWebRequest(req: IncomingMessage): Promise<Request> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${HOST}:${PORT}`}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(key, value);
    else if (Array.isArray(value)) for (const v of value) headers.append(key, v);
  }

  // `exactOptionalPropertyTypes` no acepta `method: undefined`; node siempre
  // trae uno, pero el tipo lo declara opcional.
  const method = req.method ?? "GET";

  if (method === "GET" || method === "HEAD") {
    return new Request(url, { method, headers });
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return new Request(url, { method, headers, body: Buffer.concat(chunks) });
}

async function writeWebResponse(response: Response, res: ServerResponse): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  if (!response.body) return void res.end();
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
  }
  res.end();
}

/**
 * Comprobación de arranque de la configuración del OPERADOR (URL base,
 * timeouts, caché) con una clave ficticia: la clave real llega por cabecera y
 * aquí no la tenemos, pero todo lo demás sí se puede validar ya. Sin esto, un
 * `T4F_API_BASE_URL` mal puesto no se descubriría hasta la primera petición, en
 * forma de 503 que parece un fallo del cliente.
 */
function checkOperatorConfig(): string {
  const config = loadConfigForRequest("comprobacion-de-arranque");
  return config.baseUrl;
}

function main(): void {
  let baseUrl: string;
  try {
    baseUrl = checkOperatorConfig();
  } catch (error) {
    console.error(`[${SERVER_NAME}] no se pudo iniciar:\n${error instanceof ConfigError ? error.message : String(error)}`);
    process.exit(1);
  }

  const httpServer = createHttpServer((req, res) => {
    void (async () => {
      try {
        if (req.url === "/health") {
          res.writeHead(200, { "content-type": "application/json" });
          return void res.end(JSON.stringify({ status: "ok", server: SERVER_NAME, version: SERVER_VERSION }));
        }

        const request = await toWebRequest(req);
        const response = await handleMcpRequest(request, {
          logTag: SERVER_NAME,
          transport: {
            // Protección contra DNS rebinding: en local hay que declararlo a
            // mano (en Vercel el host lo controla la plataforma).
            allowedHosts: [`${HOST}:${PORT}`, `localhost:${PORT}`],
            enableDnsRebindingProtection: true,
          },
        });
        await writeWebResponse(response, res);
      } catch (error) {
        console.error(`[${SERVER_NAME}] error atendiendo la petición:`, error);
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "internal_error", message: "Error interno." } }));
      }
    })();
  });

  httpServer.listen(PORT, HOST, () => {
    console.error(
      `[${SERVER_NAME}] v${SERVER_VERSION} escuchando en http://${HOST}:${PORT}/mcp → ${baseUrl}\n` +
        `[${SERVER_NAME}] manda tu API key de tools4foresight en la cabecera Authorization: Bearer <clave>.`,
    );
  });
}

main();
