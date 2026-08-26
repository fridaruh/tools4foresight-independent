/**
 * Test de integración del servidor completo: levanta el `McpServer` real contra
 * un `Client` real del SDK por un transporte en memoria, y comprueba que el
 * catálogo que ve un cliente MCP es el que debe ser.
 *
 * Es el único test que ejercita el registro entero. Los demás prueban piezas;
 * este prueba que las piezas están todas enchufadas.
 */
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { EXPECTED_TOOL_NAMES } from "../src/tools/index.js";
import type { Config } from "../src/config.js";

const CONFIG: Config = {
  baseUrl: "https://ejemplo.invalido/api/public/v1",
  apiKey: "clave-de-prueba",
  timeoutMs: 1000,
  retries: 0,
  cacheTtlMs: 0,
  cacheMaxEntries: 10,
  logLevel: "silent",
};

async function connected() {
  const server = createServer(CONFIG);
  const client = new Client({ name: "test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

describe("servidor MCP", () => {
  it("expone exactamente las 18 tools esperadas, ni una más ni una menos", async () => {
    const { client, server } = await connected();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...EXPECTED_TOOL_NAMES].sort());
    await server.close();
  });

  it("todas las tools se declaran de solo lectura", async () => {
    const { client, server } = await connected();
    const { tools } = await client.listTools();
    // La garantía formal de que este servidor no muta nada. Si alguien agrega
    // una tool que escribe, este test es lo que debería detenerlo.
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint, `${tool.name} no es readOnly`).toBe(true);
      expect(tool.annotations?.destructiveHint, `${tool.name} es destructiva`).toBe(false);
    }
    await server.close();
  });

  it("toda tool tiene una descripción con sustancia (es el prompt que lee el modelo)", async () => {
    const { client, server } = await connected();
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.description, `${tool.name} sin descripción`).toBeTruthy();
      expect(tool.description!.length, `${tool.name} con descripción demasiado corta`).toBeGreaterThan(80);
    }
    await server.close();
  });

  it("registra los 7 resources y los 6 prompts", async () => {
    const { client, server } = await connected();
    const [{ resources }, { resourceTemplates }, { prompts }] = await Promise.all([
      client.listResources(),
      client.listResourceTemplates(),
      client.listPrompts(),
    ]);
    expect(resources.length + resourceTemplates.length).toBe(7);
    expect(prompts.map((p) => p.name).sort()).toEqual(
      [
        "analizar_horizonte",
        "comparar_temas",
        "explorar_desde_senal",
        "informe_de_tema",
        "radar_semanal",
        "senales_debiles",
      ].sort(),
    );
    await server.close();
  });

  it("todo prompt arranca inyectando las reglas del dominio", async () => {
    const { client, server } = await connected();
    const { prompts } = await client.listPrompts();
    for (const prompt of prompts) {
      // Args mínimos: los obligatorios de cada prompt, con un valor cualquiera.
      const args = Object.fromEntries(
        (prompt.arguments ?? []).filter((a) => a.required).map((a) => [a.name, "H1"]),
      );
      const result = await client.getPrompt({ name: prompt.name, arguments: args });
      const first = result.messages[0]?.content;
      const text = first && first.type === "text" ? first.text : "";
      // Sin este bloque, el modelo tendría que deducir de la salida que la fecha
      // es estimada y que un fósil no es un borrado. No lo deduce.
      expect(text, `${prompt.name} no inyecta las reglas`).toContain("ESTIMACIÓN");
      expect(text, `${prompt.name} no advierte sobre el fósil`).toContain("FÓSIL");
    }
    await server.close();
  });

  it("una tool que no puede alcanzar la API devuelve un error de tool, no una excepción de protocolo", async () => {
    const { client, server } = await connected();
    // baseUrl apunta a un host inválido: el cliente HTTP falla, y el modelo debe
    // recibir un mensaje accionable en vez de que se corte la conversación.
    const result = await client.callTool({ name: "get_corpus_overview", arguments: {} });
    expect(result.isError).toBe(true);
    await server.close();
  });

  it("explain_foresight_term funciona sin red", async () => {
    const { client, server } = await connected();
    const result = await client.callTool({ name: "explain_foresight_term", arguments: { term: "vitalidad" } });
    expect(result.isError).toBeFalsy();
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
    expect(text.toLowerCase()).toContain("vitalidad");
    await server.close();
  });
});
