#!/usr/bin/env node
/**
 * Entry point local (stdio) — herramienta de DESARROLLO / self-host, **no el
 * modo soportado**.
 *
 * Este paquete no se publica en npm: el modo soportado es el despliegue HTTP
 * remoto (`api/mcp.ts`), donde cada persona manda su propia clave por cabecera
 * y un solo despliegue atiende a todos los tenants. Este archivo existe para
 * levantar el servidor contra tu propio banco desde el MCP Inspector o desde un
 * clon local, y por eso —y solo por eso— sí lee la clave de `T4F_API_KEY`: un
 * proceso stdio sirve a una sola persona, la que lo lanzó.
 *
 * REGLA DURA: en stdio, `stdout` es el canal JSON-RPC. Un solo `console.log`
 * en cualquier archivo que se cargue desde aquí inyecta texto en medio del
 * protocolo y el cliente se desconecta con un error de parseo que no apunta a
 * la línea culpable. Todo log va a `stderr` (`console.error`).
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigError, loadConfig } from "./config.js";
import { SERVER_NAME, SERVER_VERSION, createServer } from "./server.js";

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    // Un fallo de configuración se explica y se sale: intentar arrancar sin
    // clave solo produciría 401 en cada tool, que es mucho más difícil de
    // diagnosticar desde el cliente MCP que un mensaje al arrancar.
    const message = error instanceof ConfigError ? error.message : String(error);
    console.error(`[${SERVER_NAME}] no se pudo iniciar:\n${message}`);
    process.exit(1);
  }

  const server = createServer(config);
  await server.connect(new StdioServerTransport());
  console.error(`[${SERVER_NAME}] v${SERVER_VERSION} listo (stdio, modo desarrollo) → ${config.baseUrl}`);

  const shutdown = async (signal: string): Promise<void> => {
    console.error(`[${SERVER_NAME}] ${signal}: cerrando…`);
    await server.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void main();
