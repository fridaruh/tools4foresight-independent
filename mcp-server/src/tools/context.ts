/**
 * Contrato compartido por todos los módulos de tools.
 *
 * Cada módulo exporta un `registerXTools(server, ctx)` y no sabe nada del
 * transporte ni de cómo se construyó el cliente: así el mismo core sirve a
 * stdio y a HTTP sin una sola rama.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { T4FClient } from "../client/http-client.js";

export type ToolContext = { client: T4FClient };

export type ToolModule = (server: McpServer, ctx: ToolContext) => void;

/**
 * Anotaciones que llevan TODAS las tools de este servidor. `readOnlyHint: true`
 * no es decorativo: es la señal formal al cliente MCP (y a quien audite) de que
 * aquí no hay nada que pueda mutar el estado de tools4foresight.
 */
export const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

/**
 * Respuesta estándar de una tool: markdown para que el modelo lo lea, y
 * `structuredContent` con el DTO crudo para un agente que quiera parsearlo.
 * Los dos canales a la vez — el markdown solo se lee bien, el JSON solo se
 * procesa bien.
 */
export function toolResult(text: string, structured?: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text }],
    ...(structured ? { structuredContent: structured } : {}),
  };
}

/**
 * Traduce un fallo del cliente HTTP a un ERROR DE TOOL (`isError: true`), no a
 * una excepción de protocolo. La diferencia importa: una excepción corta la
 * conversación, mientras que un error de tool vuelve al modelo, que puede leer
 * el mensaje y corregir el rumbo (pedir otro id, esperar, avisar de la clave).
 */
export function toolError(error: unknown) {
  const message =
    error && typeof error === "object" && "messageForModel" in error
      ? String((error as { messageForModel: () => string }).messageForModel())
      : error instanceof Error
        ? error.message
        : "Error desconocido al consultar tools4foresight.";
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

/** Envuelve el handler de una tool para que ningún fallo escape como excepción. */
export function guarded<A>(handler: (args: A) => Promise<ReturnType<typeof toolResult>>) {
  return async (args: A) => {
    try {
      return await handler(args);
    } catch (error) {
      return toolError(error);
    }
  };
}

/**
 * Quita las claves con valor `undefined`.
 *
 * `exactOptionalPropertyTypes: true` distingue "la propiedad no está" de "está
 * y vale undefined", y los params del cliente son de la primera clase. Los
 * argumentos que llegan de una tool MCP son de la segunda (zod deja la clave
 * con `undefined` cuando el campo es opcional y no vino), así que hay que
 * limpiarlos antes de pasarlos. Sin esto no compila, y con un `as any` se
 * perdería justo la validación que hace útil el tipado.
 */
export function compact<T extends Record<string, unknown>>(input: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value;
  }
  return out as { [K in keyof T]: Exclude<T[K], undefined> };
}
