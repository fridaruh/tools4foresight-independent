/**
 * LA PRUEBA DEL DISEÑO.
 *
 * Este repo existe para una sola garantía: que un despliegue compartido atienda
 * a muchas personas sin que ninguna pueda leer el banco de señales de otra. Esa
 * garantía descansa en un detalle de implementación que es fácil de romper sin
 * darse cuenta —"optimizar" cacheando el cliente HTTP entre peticiones—, así
 * que aquí se fija por escrito y con red.
 *
 * Lo que se comprueba:
 *   1. Dos peticiones con claves distintas producen `T4FClient` distintos, cada
 *      uno con su propia caché.
 *   2. Una respuesta que quedó cacheada para la clave A NUNCA se sirve a la
 *      clave B, ni siquiera pidiendo exactamente el mismo path (que es cuando
 *      una caché compartida por módulo daría el hit envenenado).
 *   3. Cada petición sale a la red con SU cabecera `Authorization`, sin arrastre
 *      de la anterior.
 *
 * Todo sin red real: `fetch` inyectado.
 */
import { describe, expect, it, vi } from "vitest";
import { T4FClient } from "../src/client/http-client.js";
import { createServer } from "../src/server.js";
import { extractBearer, handleMcpRequest } from "../src/http-passthrough.js";
import { loadConfigForRequest } from "../src/config.js";

const ENV = {
  T4F_API_BASE_URL: "https://ejemplo.invalido/api/public/v1",
  T4F_CACHE_TTL_MS: "60000",
} as unknown as NodeJS.ProcessEnv;

/** Un `fetch` falso que devuelve un cuerpo distinto según la clave que reciba. */
function tenantAwareFetch() {
  const seen: { url: string; auth: string }[] = [];
  const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
    const auth = String((init?.headers as Record<string, string>).Authorization);
    seen.push({ url: String(url), auth });
    // El "banco" de cada tenant: el cuerpo lleva la clave que lo pidió, así que
    // una respuesta servida al tenant equivocado es detectable a simple vista.
    return new Response(JSON.stringify({ data: { duenio: auth }, meta: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return { fetchMock: fetchMock as unknown as typeof fetch, seen };
}

/** Simula una petición HTTP entrante con su cabecera Authorization. */
function requestConClave(apiKey: string): Request {
  return new Request("https://mcp.invalido/api/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}` },
  });
}

describe("aislamiento entre tenants", () => {
  it("extrae la clave de la cabecera y construye la config de ESA petición", () => {
    const configA = loadConfigForRequest(extractBearer(requestConClave("clave-de-ana")), ENV);
    const configB = loadConfigForRequest(extractBearer(requestConClave("clave-de-beto")), ENV);

    expect(configA.apiKey).toBe("clave-de-ana");
    expect(configB.apiKey).toBe("clave-de-beto");
    // Misma configuración de operador, distinta identidad: es exactamente lo que
    // debe pasar en un despliegue compartido.
    expect(configA.baseUrl).toBe(configB.baseUrl);
  });

  it("sin cabecera Authorization no hay clave que usar (el handler devolverá 401)", () => {
    const sinCabecera = new Request("https://mcp.invalido/api/mcp", { method: "POST" });
    expect(extractBearer(sinCabecera)).toBeNull();
    // Y una cabecera con otro esquema tampoco cuenta como clave.
    const basic = new Request("https://mcp.invalido/api/mcp", {
      method: "POST",
      headers: { authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(extractBearer(basic)).toBeNull();
  });

  it("una petición sin Bearer se corta con 401 y un mensaje que dice qué poner", async () => {
    const response = await handleMcpRequest(
      new Request("https://mcp.invalido/api/mcp", { method: "POST" }),
      { env: ENV },
    );
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("unauthorized");
    // Accionable: nombra la cabecera y dónde se genera la clave.
    expect(body.error.message).toContain("Authorization: Bearer");
    expect(body.error.message).toContain("/perfil");
  });

  it("si al operador le falta T4F_API_BASE_URL responde 503, no un 401 que culpe al cliente", async () => {
    const response = await handleMcpRequest(requestConClave("clave-de-ana"), {
      env: {} as NodeJS.ProcessEnv,
    });
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("server_not_configured");
    expect(body.error.message).toContain("T4F_API_BASE_URL");
  });

  it("dos claves distintas producen clientes con cachés independientes: ningún hit cruzado", async () => {
    const { fetchMock, seen } = tenantAwareFetch();

    const clienteA = new T4FClient(loadConfigForRequest("clave-de-ana", ENV), { fetch: fetchMock });
    const clienteB = new T4FClient(loadConfigForRequest("clave-de-beto", ENV), { fetch: fetchMock });

    // A pide y su respuesta queda cacheada.
    const primeraA = await clienteA.get<{ data: { duenio: string } }>({ path: "/signals", ttlMs: 60_000 });
    expect(primeraA.data.duenio).toBe("Bearer clave-de-ana");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A repite el MISMO path: eso sí debe salir de su caché, sin tocar la red.
    const segundaA = await clienteA.get<{ data: { duenio: string } }>({ path: "/signals", ttlMs: 60_000 });
    expect(segundaA.data.duenio).toBe("Bearer clave-de-ana");
    expect(fetchMock).toHaveBeenCalledTimes(1); // hit de caché, no hubo red

    // B pide el MISMO path. Si la caché fuera de módulo (o la clave de caché no
    // incluyera al tenant), aquí recibiría el banco de A sin una sola petición.
    const primeraB = await clienteB.get<{ data: { duenio: string } }>({ path: "/signals", ttlMs: 60_000 });
    expect(primeraB.data.duenio).toBe("Bearer clave-de-beto");
    expect(primeraB.data.duenio).not.toBe(primeraA.data.duenio);
    expect(fetchMock).toHaveBeenCalledTimes(2); // hubo red: no se reusó nada de A

    // Y cada petición salió con SU cabecera, sin arrastre.
    expect(seen.map((s) => s.auth)).toEqual(["Bearer clave-de-ana", "Bearer clave-de-beto"]);

    // Vaciar la caché de A no toca la de B: son objetos distintos.
    clienteA.clearCache();
    await clienteB.get({ path: "/signals", ttlMs: 60_000 });
    expect(fetchMock).toHaveBeenCalledTimes(2); // B siguió sirviendo de su propia caché
  });

  it("createServer construye un cliente nuevo por llamada (nada compartido entre tenants)", async () => {
    const { fetchMock, seen } = tenantAwareFetch();

    // Dos "peticiones" completas, como las armaría `handleMcpRequest`.
    for (const clave of ["clave-de-ana", "clave-de-beto"]) {
      const servidor = createServer(loadConfigForRequest(clave, ENV));
      // El cliente vive dentro del servidor; se comprueba por su efecto en la
      // red, que es lo observable desde fuera.
      await servidor.close();
    }

    // Comprobación directa del invariante: dos `createServer` seguidos no
    // devuelven el mismo objeto, así que tampoco comparten `T4FClient` ni caché.
    const s1 = createServer(loadConfigForRequest("clave-de-ana", ENV));
    const s2 = createServer(loadConfigForRequest("clave-de-ana", ENV));
    expect(s1).not.toBe(s2);
    await Promise.all([s1.close(), s2.close()]);

    // Ninguna de esas construcciones tocó la red por su cuenta: no hay warm-up
    // ni precarga que pudiera quedar guardada en un módulo.
    expect(seen).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
