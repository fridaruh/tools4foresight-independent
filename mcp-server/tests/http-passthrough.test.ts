/**
 * LA PRUEBA DE LA FACTURA.
 *
 * Un fallo REAL, medido en producción: el despliegue se comió los 360 GB-Hrs de
 * memoria aprovisionada del mes en cuatro días, con 10.455 invocaciones muertas
 * por timeout de 10.929 totales. Nada estaba "caído" —las tools respondían y el
 * markdown se veía bien—, así que ningún test de formato ni de tipos lo iba a
 * ver: el servidor se estaba desangrando por el transporte.
 *
 * La causa: en stateless (sin `sessionIdGenerator`) el SDK deja pasar la
 * validación de sesión, así que un `GET /mcp` abría el stream SSE "standalone",
 * que no se cierra nunca, y la función vivía hasta agotar `maxDuration`. El
 * cliente veía la conexión caída, reconectaba, y el bucle daba una invocación
 * por minuto, todo el día, sin que nadie estuviera usando el servidor.
 *
 * Por eso esto se fija con red: la regresión no se nota mirando respuestas —se
 * nota en el recibo, un mes tarde.
 */
import { describe, expect, it } from "vitest";
import { handleMcpRequest } from "../src/http-passthrough.js";

const ENV = {
  T4F_API_BASE_URL: "https://ejemplo.invalido/api/public/v1",
} as unknown as NodeJS.ProcessEnv;

function initializeRequest(headers: Record<string, string>): Request {
  return new Request("https://mcp.invalido/api/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      },
    }),
  });
}

describe("el GET no abre un stream que nadie cierra", () => {
  it("responde 405 al GET en vez de colgarse hasta el timeout", async () => {
    const response = await handleMcpRequest(
      new Request("https://mcp.invalido/api/mcp", {
        method: "GET",
        headers: { accept: "text/event-stream", authorization: "Bearer clave-de-ana" },
      }),
      { env: ENV },
    );

    expect(response.status).toBe(405);
    // La regresión concreta: devolver `text/event-stream` es volver a colgar la
    // función 60 segundos por cada cliente conectado.
    expect(response.headers.get("content-type")).not.toContain("text/event-stream");
    expect(response.headers.get("allow")).toContain("POST");
  });

  it("rechaza el método ANTES de mirar la clave, para que un cliente sin auth tampoco se cuelgue", async () => {
    const response = await handleMcpRequest(
      new Request("https://mcp.invalido/api/mcp", {
        method: "GET",
        headers: { accept: "text/event-stream" },
      }),
      { env: ENV },
    );

    // Sin cabecera Authorization: si esto fuera 401, el 405 estaría detrás de la
    // auth y el rechazo dependería de que el cliente mande clave.
    expect(response.status).toBe(405);
  });

  it("el HEAD tampoco abre stream", async () => {
    const response = await handleMcpRequest(
      new Request("https://mcp.invalido/api/mcp", { method: "HEAD" }),
      { env: ENV },
    );
    expect(response.status).toBe(405);
  });
});

describe("el POST responde JSON de una pieza, no un stream SSE", () => {
  it("contesta al initialize con application/json", async () => {
    const response = await handleMcpRequest(
      initializeRequest({ authorization: "Bearer clave-de-ana" }),
      { env: ENV },
    );

    expect(response.status).toBe(200);
    // La regresión: perder `enableJsonResponse` devuelve la respuesta por SSE y
    // reintroduce un camino donde la función sigue respirando tras contestar.
    expect(response.headers.get("content-type")).toContain("application/json");

    const body = (await response.json()) as { result?: { serverInfo?: unknown } };
    expect(body.result?.serverInfo).toBeDefined();
  });

  it("el POST sigue exigiendo clave: el 405 del GET no aflojó la auth", async () => {
    const response = await handleMcpRequest(initializeRequest({}), { env: ENV });
    expect(response.status).toBe(401);
  });
});
