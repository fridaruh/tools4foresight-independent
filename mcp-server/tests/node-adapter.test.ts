import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isWebRequest, toWebRequest, writeNodeResponse } from '../src/node-adapter.js';

// Simula lo que el runtime de Vercel le pasa al handler: un IncomingMessage, no
// un Request web. Es exactamente el caso que hacía fallar el despliegue con
// `request.headers.get is not a function`.
function fakeIncoming(init: {
  method?: string;
  url?: string;
  headers?: Record<string, string | string[]>;
  body?: string;
}): IncomingMessage {
  const stream = new PassThrough();
  if (init.body !== undefined) stream.end(init.body);
  else stream.end();
  return Object.assign(stream, {
    method: init.method ?? 'GET',
    url: init.url ?? '/api/mcp',
    headers: init.headers ?? { host: 'ejemplo.vercel.app' },
  }) as unknown as IncomingMessage;
}

describe('node-adapter: isWebRequest', () => {
  it('distingue un Request web de un IncomingMessage de Node', () => {
    expect(isWebRequest(new Request('https://ejemplo.test/'))).toBe(true);
    expect(isWebRequest(fakeIncoming({}))).toBe(false);
    expect(isWebRequest(null)).toBe(false);
    expect(isWebRequest({ headers: { host: 'x' } })).toBe(false);
  });
});

describe('node-adapter: toWebRequest', () => {
  it('conserva método, cuerpo y cabeceras (el Bearer, sobre todo)', async () => {
    const request = await toWebRequest(
      fakeIncoming({
        method: 'POST',
        headers: { host: 'ejemplo.vercel.app', authorization: 'Bearer secreto', 'content-type': 'application/json' },
        body: '{"jsonrpc":"2.0"}',
      }),
    );
    expect(request.method).toBe('POST');
    expect(request.headers.get('authorization')).toBe('Bearer secreto');
    expect(await request.text()).toBe('{"jsonrpc":"2.0"}');
  });

  it('reconstruye la URL absoluta con el protocolo reenviado por la plataforma', async () => {
    const request = await toWebRequest(
      fakeIncoming({ url: '/api/mcp?x=1', headers: { host: 'ejemplo.vercel.app', 'x-forwarded-proto': 'https' } }),
    );
    expect(request.url).toBe('https://ejemplo.vercel.app/api/mcp?x=1');
  });

  it('un GET no lleva cuerpo: pasárselo a Request lanzaría', async () => {
    const request = await toWebRequest(fakeIncoming({ method: 'GET' }));
    expect(request.body).toBeNull();
  });
});

describe('node-adapter: writeNodeResponse', () => {
  it('copia status, cabeceras y cuerpo al ServerResponse', async () => {
    let status = 0;
    let headers: Record<string, unknown> = {};
    const chunks: Buffer[] = [];
    const res = {
      writeHead(code: number, hdrs: Record<string, unknown>) {
        status = code;
        headers = hdrs;
      },
      write(chunk: Buffer) {
        chunks.push(chunk);
      },
      end() {},
    } as unknown as ServerResponse;

    await writeNodeResponse(
      res,
      new Response('hola', { status: 401, headers: { 'content-type': 'text/plain' } }),
    );

    expect(status).toBe(401);
    expect(headers['content-type']).toBe('text/plain');
    expect(Buffer.concat(chunks).toString()).toBe('hola');
  });

  it('una respuesta sin cuerpo (204) no rompe', async () => {
    let ended = false;
    const res = {
      writeHead() {},
      write() {},
      end() {
        ended = true;
      },
    } as unknown as ServerResponse;
    await writeNodeResponse(res, new Response(null, { status: 204 }));
    expect(ended).toBe(true);
  });
});
