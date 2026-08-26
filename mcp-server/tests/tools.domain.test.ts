/**
 * `explain_foresight_term` es la única tool del catálogo que no toca la red.
 * Este test lo comprueba de la única forma convincente: registrándola sobre un
 * `McpServer` real conectado a un `T4FClient` FALSO que lanza si cualquiera de
 * sus métodos se invoca. Si la tool alguna vez empezara a llamar a la API, el
 * test fallaría de inmediato con el error del cliente falso, no con un timeout
 * de red silencioso.
 */
import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerDomainTools } from "../src/tools/domain.js";
import type { ToolContext } from "../src/tools/context.js";
import type { T4FClient } from "../src/client/http-client.js";
import { GLOSSARY_KEYS, lookupTerm } from "../src/domain/glossary.js";

// Proxy en vez de un objeto con métodos individuales: cualquier propiedad que
// se lea (no solo las que ya conocemos, como `getMeta` o `listSignals`) lanza.
// Así el test no depende de mantener sincronizada una lista de métodos de
// `T4FClient` — CUALQUIER intento de tocar el cliente es una falla del test.
const NETWORK_FORBIDDEN_CLIENT = new Proxy(
  {},
  {
    get(_target, prop) {
      throw new Error(`explain_foresight_term no debe tocar el cliente HTTP (se accedió a "${String(prop)}").`);
    },
  },
) as unknown as T4FClient;

async function connectedDomainServer() {
  const server = new McpServer({ name: "test-domain", version: "0.0.0" });
  const ctx: ToolContext = { client: NETWORK_FORBIDDEN_CLIENT };
  registerDomainTools(server, ctx);

  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

describe("explain_foresight_term (sin red)", () => {
  it("responde con la definición completa sin tocar el cliente HTTP", async () => {
    const { client, server } = await connectedDomainServer();
    const result = await client.callTool({ name: "explain_foresight_term", arguments: { term: "vitalidad" } });
    expect(result.isError).toBeFalsy();

    const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
    expect(text).toContain("Vitalidad");
    // La entrada "vitalidad" del glosario trae fórmula y constantes: deben
    // aparecer en el markdown, no solo el resumen corto.
    expect(text).toContain("Fórmula");
    expect(text).toContain("Constantes reales");

    const structured = result.structuredContent as { data?: { key?: string } } | undefined;
    expect(structured?.data?.key).toBe("vitalidad");

    await server.close();
  });

  it("responde para cada una de las 25 claves del glosario", async () => {
    const { client, server } = await connectedDomainServer();
    for (const key of GLOSSARY_KEYS) {
      const result = await client.callTool({ name: "explain_foresight_term", arguments: { term: key } });
      expect(result.isError, `"${key}" devolvió error`).toBeFalsy();
    }
    expect(GLOSSARY_KEYS.length).toBe(25);
    await server.close();
  });

  it("rechaza un término fuera del enum ya en la validación de argumentos del SDK", async () => {
    const { client, server } = await connectedDomainServer();
    // `term` es un `z.enum` cerrado sobre las 25 claves del glosario: un valor
    // fuera de esa lista ni siquiera llega al handler del tool — el SDK lo
    // rechaza al validar los argumentos (McpError InvalidParams) ANTES de
    // ejecutar el callback, y el `Client` lo entrega como un resultado con
    // `isError: true` en vez de tirar la conexión.
    const result = await client.callTool({ name: "explain_foresight_term", arguments: { term: "no_existe" } });
    expect(result.isError).toBe(true);
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
    expect(text).toContain("Invalid arguments for tool explain_foresight_term");
    await server.close();
  });
});

describe("lookupTerm (tolerancia a acentos y mayúsculas)", () => {
  it("resuelve 'fósil', 'FOSIL' y 'fosil' al mismo término", () => {
    const withAccent = lookupTerm("fósil");
    const upperCase = lookupTerm("FOSIL");
    const plain = lookupTerm("fosil");

    expect(withAccent).not.toBeNull();
    expect(withAccent?.key).toBe("fosil");
    expect(upperCase?.key).toBe("fosil");
    expect(plain?.key).toBe("fosil");

    // Las tres formas deben resolver a la MISMA entrada, no a entradas
    // distintas que casualmente compartan clave.
    expect(withAccent).toBe(upperCase);
    expect(upperCase).toBe(plain);
  });

  it("devuelve null para un término que no existe en ninguna forma", () => {
    expect(lookupTerm("esto-no-es-un-termino-del-glosario")).toBeNull();
  });
});
