/**
 * Entry point HTTP remoto (Vercel Function): el ÚNICO modo soportado de este
 * servidor. Streamable HTTP, multi-tenant, pass-through.
 *
 * Un solo despliegue compartido atiende a todas las personas: la clave de
 * tools4foresight que cada quien manda en `Authorization: Bearer` decide qué
 * banco de señales se lee. Este despliegue **no lleva ninguna credencial
 * dentro** — ni una clave contra la API, ni un token de acceso propio. Toda la
 * lógica (y el porqué del aislamiento entre tenants) vive en
 * `src/http-passthrough.ts`, compartida con el servidor HTTP local para que no
 * puedan divergir.
 *
 * STATELESS a propósito (sin `sessionIdGenerator`): en Vercel cada petición
 * puede caer en una instancia distinta, así que una sesión guardada en memoria
 * se perdería a mitad de conversación. Sin sesión no hay sesión que perder — y
 * en multi-tenant, tampoco hay estado que pueda quedarse pegado al tenant
 * equivocado. El precio —ni resumabilidad ni notificaciones del servidor fuera
 * del ciclo de una petición— no importa aquí: todas las tools son lecturas
 * cortas.
 *
 * `runtime: nodejs` y no edge: el SDK usa APIs de Node.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleMcpRequest } from "../src/http-passthrough.js";
import { SERVER_NAME } from "../src/server.js";
import { isWebRequest, toWebRequest, writeNodeResponse } from "../src/node-adapter.js";

export const config = { runtime: "nodejs" };

/**
 * El runtime de funciones de Vercel invoca esto con la firma de Node
 * (`req`, `res`), no con un `Request` web. `respond` es la lógica real —
 * escrita contra la API web, como el resto del servidor— y este handler solo
 * traduce (ver src/node-adapter.ts). Acepta las dos formas: si algún día
 * llega un `Request` nativo, se atiende directo.
 */
export default async function handler(
  incoming: Request | IncomingMessage,
  res?: ServerResponse,
): Promise<Response | void> {
  if (isWebRequest(incoming)) return respond(incoming);

  const request = await toWebRequest(incoming);
  const response = await respond(request);
  if (!res) return response;
  await writeNodeResponse(res, response);
}

function respond(request: Request): Promise<Response> {
  // Sin `transport.allowedHosts`: en Vercel el host lo controla la plataforma,
  // así que la protección contra DNS rebinding no aporta y una lista fija de
  // hosts rompería los dominios de preview.
  return handleMcpRequest(request, { logTag: SERVER_NAME });
}
