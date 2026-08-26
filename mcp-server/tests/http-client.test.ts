import { describe, expect, it, vi } from 'vitest';
import { T4FClient } from '../src/client/http-client.js';
import { T4FApiError } from '../src/client/errors.js';
import type { Config } from '../src/config.js';

// Config de prueba: sin red, sin timers reales. `retries` y `timeoutMs` se
// sobreescriben por test según el escenario (docs/PLAN.md §2.11).
function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    baseUrl: 'https://tools4foresight.example/api/public/v1',
    apiKey: 'test-key',
    timeoutMs: 15_000,
    retries: 2,
    cacheTtlMs: 60_000,
    cacheMaxEntries: 200,
    logLevel: 'silent',
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function htmlResponse(status: number, html: string): Response {
  return new Response(html, { status, headers: { 'content-type': 'text/html' } });
}

// Captura las llamadas de `sleep` en vez de esperar tiempo real: así los tests de
// backoff/reintentos son instantáneos y deterministas.
function fakeSleep() {
  const calls: number[] = [];
  const sleep = vi.fn(async (ms: number) => {
    calls.push(ms);
  });
  return { sleep, calls };
}

describe('T4FClient', () => {
  it('hace una petición exitosa con las cabeceras correctas', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { data: { ok: true }, meta: {} }));
    const client = new T4FClient(makeConfig(), { fetch: fetchMock as unknown as typeof fetch });

    const result = await client.get<{ data: { ok: boolean } }>({ path: '/meta', cache: false });

    expect(result.data.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://tools4foresight.example/api/public/v1/meta');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-key');
    expect(headers.Accept).toBe('application/json');
    expect(headers['User-Agent']).toMatch(/^mcp-t4f-multitenant\/\S+$/);
  });

  it('construye la query string: arrays repetidos, undefined/null omitidos, booleanos como texto', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { data: [], meta: {} }));
    const client = new T4FClient(makeConfig(), { fetch: fetchMock as unknown as typeof fetch });

    await client.get({
      path: '/signals',
      cache: false,
      query: {
        category: ['a', 'b'],
        q: undefined,
        theme: null,
        orphans: true,
        limit: 10,
      },
    });

    const [url] = fetchMock.mock.calls[0]!;
    const parsed = new URL(String(url));
    expect(parsed.searchParams.getAll('category')).toEqual(['a', 'b']);
    expect(parsed.searchParams.has('q')).toBe(false);
    expect(parsed.searchParams.has('theme')).toBe(false);
    expect(parsed.searchParams.get('orphans')).toBe('true');
    expect(parsed.searchParams.get('limit')).toBe('10');
  });

  it('no reintenta un 401 y traduce el error para el LLM', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(401, { error: { code: 'invalid_api_key', message: 'clave inválida', param: null } }),
    );
    const { sleep } = fakeSleep();
    const client = new T4FClient(makeConfig({ retries: 2 }), {
      fetch: fetchMock as unknown as typeof fetch,
      sleep,
    });

    await expect(client.get({ path: '/signals', cache: false })).rejects.toMatchObject({
      status: 401,
      code: 'invalid_api_key',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1); // ningún reintento

    try {
      await client.get({ path: '/signals', cache: false });
    } catch (err) {
      expect(err).toBeInstanceOf(T4FApiError);
      expect((err as T4FApiError).messageForModel()).toMatch(/No reintentes/);
    }
  });

  it('reintenta un 429 respetando Retry-After y luego tiene éxito', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { error: { code: 'rate_limited', message: 'despacio', param: null } }, { 'Retry-After': '1' }))
      .mockResolvedValueOnce(jsonResponse(200, { data: { ok: true }, meta: {} }));
    const { sleep, calls } = fakeSleep();
    const client = new T4FClient(makeConfig({ retries: 2 }), {
      fetch: fetchMock as unknown as typeof fetch,
      sleep,
    });

    const result = await client.get<{ data: { ok: boolean } }>({ path: '/signals', cache: false });

    expect(result.data.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(calls).toEqual([1000]); // Retry-After: 1 -> 1000ms, ignora el backoff calculado
  });

  it('reintenta un 500 con backoff exponencial y se agota tras acabar los reintentos', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(500, { error: { code: 'internal_error', message: 'boom', param: null } }),
    );
    const { sleep, calls } = fakeSleep();
    const client = new T4FClient(makeConfig({ retries: 2 }), {
      fetch: fetchMock as unknown as typeof fetch,
      sleep,
    });

    await expect(client.get({ path: '/signals', cache: false })).rejects.toMatchObject({ status: 500 });

    // retries=2 -> 3 intentos totales, 2 esperas entre intentos.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(calls).toHaveLength(2);
    // 300ms * 2^0 ± 30% y 300ms * 2^1 ± 30%.
    expect(calls[0]).toBeGreaterThanOrEqual(210);
    expect(calls[0]).toBeLessThanOrEqual(390);
    expect(calls[1]).toBeGreaterThanOrEqual(420);
    expect(calls[1]).toBeLessThanOrEqual(780);
  });

  it('un timeout aborta la petición y se traduce a T4FApiError sin status', async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        if (signal.aborted) {
          reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
          return;
        }
        signal.addEventListener('abort', () => {
          reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        });
      });
    });
    const client = new T4FClient(makeConfig({ timeoutMs: 15, retries: 0 }), {
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(client.get({ path: '/signals', cache: false })).rejects.toMatchObject({
      status: null,
      code: 'timeout',
    });
  });

  it('un cuerpo de error no-JSON produce un mensaje genérico sin filtrar HTML', async () => {
    const fetchMock = vi.fn(async () => htmlResponse(502, '<html><body>Bad Gateway</body></html>'));
    const client = new T4FClient(makeConfig({ retries: 0 }), {
      fetch: fetchMock as unknown as typeof fetch,
    });

    try {
      await client.get({ path: '/signals', cache: false });
      throw new Error('debía lanzar');
    } catch (err) {
      expect(err).toBeInstanceOf(T4FApiError);
      const apiErr = err as T4FApiError;
      expect(apiErr.status).toBe(502);
      expect(apiErr.message).not.toContain('<html>');
      expect(apiErr.message).not.toContain('Bad Gateway');
    }
  });

  it('sirve peticiones repetidas desde caché sin volver a llamar a fetch', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { data: [{ key: 'a', letter: 'A', label: 'Ambiental', signalCount: 1 }], meta: {} }));
    const client = new T4FClient(makeConfig(), { fetch: fetchMock as unknown as typeof fetch });

    await client.listPestel();
    await client.listPestel();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('con cache:false ignora la caché en lectura y escritura', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { data: { ok: true }, meta: {} }));
    const client = new T4FClient(makeConfig(), { fetch: fetchMock as unknown as typeof fetch });

    await client.get({ path: '/meta', cache: false });
    await client.get({ path: '/meta', cache: false });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
