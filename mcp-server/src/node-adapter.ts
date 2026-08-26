/**
 * Puente entre la firma de función de Node (`req`, `res`) y la web estándar
 * (`Request` -> `Response`).
 *
 * Por qué existe: todo este servidor está escrito contra la API web —
 * `WebStandardStreamableHTTPServerTransport` recibe un `Request` y devuelve un
 * `Response`— pero el runtime de funciones de Vercel invoca el handler con un
 * `IncomingMessage` y un `ServerResponse` de Node. Sin este puente, la primera
 * línea del handler explota con `request.headers.get is not a function`.
 *
 * El handler exportado acepta las DOS formas y decide en tiempo de ejecución,
 * en vez de depender de que la plataforma detecte la firma correcta: si mañana
 * Vercel empieza a pasar un `Request` nativo, el mismo archivo sigue
 * funcionando sin tocarlo.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

/** Un `Request` web se distingue por tener `headers.get`; el de Node no lo tiene. */
export function isWebRequest(value: unknown): value is Request {
  const headers = (value as { headers?: unknown } | null)?.headers as { get?: unknown } | undefined;
  return typeof headers?.get === 'function';
}

function absoluteUrl(req: IncomingMessage): string {
  // `x-forwarded-proto` lo pone la plataforma; en local siempre es http.
  const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim() ?? 'http';
  const host = (req.headers.host ?? 'localhost') as string;
  return `${proto}://${host}${req.url ?? '/'}`;
}

async function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  // GET y HEAD no llevan cuerpo: pasarle uno a `new Request` lanza.
  const method = req.method ?? 'GET';
  if (method === 'GET' || method === 'HEAD') return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  const body = Buffer.concat(chunks);
  return body.length > 0 ? body : undefined;
}

/** `IncomingMessage` -> `Request`. */
export async function toWebRequest(req: IncomingMessage): Promise<Request> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else headers.set(name, value);
  }

  const body = await readBody(req);
  return new Request(absoluteUrl(req), {
    method: req.method ?? 'GET',
    headers,
    ...(body ? { body: new Uint8Array(body) } : {}),
  });
}

/**
 * `Response` -> `ServerResponse`. El cuerpo se copia en streaming y no de
 * golpe: una respuesta de Streamable HTTP puede ser un `text/event-stream` que
 * no termina hasta que el servidor cierra, y bufferizarla entera dejaría al
 * cliente esperando sin ver un solo evento.
 */
export async function writeNodeResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, key) => {
    headers[key] = key.toLowerCase() === 'set-cookie' ? [value] : value;
  });
  res.writeHead(response.status, headers);

  if (!response.body) {
    res.end();
    return;
  }

  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) res.write(Buffer.from(value));
    }
  } finally {
    res.end();
  }
}
