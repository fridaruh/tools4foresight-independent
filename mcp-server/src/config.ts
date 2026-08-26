// Carga y valida la configuración del servidor MCP.
//
// OJO A LA INVERSIÓN respecto al servidor single-tenant del que nace este repo:
// aquí la API key NO es una credencial del proceso, es la IDENTIDAD DEL BANCO de
// quien llama. Por eso hay dos cargadores:
//
//   - `loadConfigForRequest(apiKey, env)` — el camino soportado. La clave llega
//     en el `Authorization: Bearer` de CADA petición MCP y se combina con el
//     resto de la configuración del proceso (URL base, timeouts, caché). El
//     servidor remoto no guarda ninguna clave.
//   - `loadConfig(env)` — camino de DESARROLLO/self-host, usado SOLO por
//     `src/stdio.ts`, donde una sola persona corre el servidor para sí misma y
//     le pasa su clave por `T4F_API_KEY`. No es el modo soportado en producción.
//     (`src/http.ts` NO lo usa: el modo HTTP local es pass-through igual que
//     Vercel, a propósito.)
//
// Los mensajes de error están en español y son accionables: le dicen al operador
// humano (no al LLM) exactamente qué hacer, porque estos errores explotan antes
// de que exista ninguna conexión MCP útil.
import * as z from 'zod/v4';

export type LogLevel = 'silent' | 'error' | 'debug';

// SIN DEFAULT, a propósito. El servidor original apuntaba por defecto a
// `https://tools4foresight.com/api/public/v1`, que es el acervo ÚNICO de la app
// single-tenant. Este repo habla con el despliegue multi-tenant (proyecto de
// Vercel `tools4foresight-app`), cuyo dominio final no está fijado todavía. Un
// default que apunte al sitio equivocado es peor que un arranque fallido: en el
// mejor caso da 401 confusos, y en el peor manda la clave de un usuario a un
// host que no es el suyo. Así que la variable es obligatoria y el error dice
// exactamente qué poner.
const MISSING_BASE_URL_MESSAGE =
  'Falta T4F_API_BASE_URL: pon la URL base de la API pública de tu despliegue de tools4foresight, ' +
  'terminada en /api/public/v1 (por ejemplo "https://<tu-dominio>/api/public/v1"). ' +
  'No hay valor por defecto a propósito: este servidor es multi-tenant y no debe adivinar contra qué instancia habla.';

const EXAMPLE_BASE_URL = 'https://tu-dominio-de-tools4foresight/api/public/v1';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_CACHE_TTL_MS = 60_000;
// Sin variable de entorno propia: no es algo que un operador necesite tocar para
// operar el servidor; es un tope de memoria interno. Y en este repo el tope es
// POR PETICIÓN (cada petición crea su propio cliente y su propia caché), así que
// aún importa menos.
const DEFAULT_CACHE_MAX_ENTRIES = 200;
// 'error' es el punto medio seguro: por defecto no se inunda stderr con debug,
// pero tampoco se queda 'silent' y esconde fallos reales.
const DEFAULT_LOG_LEVEL: LogLevel = 'error';

/**
 * Error de configuración, distinto de un Error genérico para que los entry
 * points puedan atraparlo específicamente e imprimir solo el mensaje (sin stack
 * de zod) antes de hacer `process.exit(1)`, o devolverlo como cuerpo de error
 * HTTP sin filtrar internals.
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

// Recorta la(s) barra(s) final(es) de la base URL: los métodos de conveniencia del
// cliente concatenan `${baseUrl}${path}` donde `path` siempre empieza con "/", así
// que una base URL con barra final produciría "//signals" en vez de "/signals".
function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

// Trata las variables de entorno vacías ("") igual que si no estuvieran definidas,
// para que `FOO=` en un .env no se cuele como valor distinto del default.
function emptyToUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** Mensaje del camino de desarrollo: la clave sale del entorno. */
const MISSING_ENV_API_KEY_MESSAGE =
  'Falta T4F_API_KEY: genera tu clave en /perfil de tu instancia de tools4foresight y ponla en el entorno. ' +
  '(Este camino es solo para desarrollo/self-host: en el despliegue remoto la clave viaja en la cabecera Authorization de cada petición.)';

/** Mensaje del camino soportado: la clave llega en la cabecera. */
export const MISSING_REQUEST_API_KEY_MESSAGE =
  'Falta la cabecera Authorization: Bearer <tu API key de tools4foresight>. ' +
  'Genera una clave en /perfil de tu instancia de tools4foresight y ponla en el header de tu cliente MCP. ' +
  'Este servidor no guarda ninguna credencial: la clave que mandes ES tu identidad y determina qué banco de señales se lee.';

const configSchema = z.object({
  baseUrl: z
    .string({ error: MISSING_BASE_URL_MESSAGE })
    .trim()
    .min(1, { message: MISSING_BASE_URL_MESSAGE })
    .refine(
      (value) => {
        try {
          // eslint-disable-next-line no-new
          new URL(value);
          return true;
        } catch {
          return false;
        }
      },
      { message: `T4F_API_BASE_URL no es una URL válida. Ejemplo correcto: "${EXAMPLE_BASE_URL}".` },
    )
    // HTTPS obligatorio fuera de localhost. La razón vale MÁS aquí que en el
    // servidor single-tenant: por esta URL viaja `Authorization: Bearer <clave>`
    // en cada petición, y esa clave ya no es la del operador — es la de un
    // USUARIO FINAL, y es la llave de su banco de señales completo. Una clave
    // ajena en claro por la red es una clave ajena comprometida. Se permite http
    // contra localhost/127.0.0.1 para desarrollar contra la app en local.
    .refine(
      (value) => {
        try {
          const url = new URL(value);
          if (url.protocol === 'https:') return true;
          return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
        } catch {
          return false;
        }
      },
      {
        message:
          'T4F_API_BASE_URL debe usar https:// (solo se permite http:// contra localhost). ' +
          'Por esa URL viaja en cada petición la API key de un usuario, que es la llave de todo su banco de señales.',
      },
    )
    .transform(normalizeBaseUrl),
  apiKey: z
    .string({ error: 'Falta la API key de tools4foresight.' })
    .trim()
    .min(1, { message: 'Falta la API key de tools4foresight.' }),
  timeoutMs: z.coerce
    .number({ error: 'T4F_TIMEOUT_MS debe ser un número de milisegundos, por ejemplo 15000.' })
    .int({ message: 'T4F_TIMEOUT_MS debe ser un entero (milisegundos), sin decimales.' })
    .positive({ message: 'T4F_TIMEOUT_MS debe ser mayor que 0; si quieres desactivar el timeout, sube el valor en vez de ponerlo en 0.' }),
  retries: z.coerce
    .number({ error: 'T4F_RETRIES debe ser un número entero, por ejemplo 2.' })
    .int({ message: 'T4F_RETRIES debe ser un entero, sin decimales.' })
    .min(0, { message: 'T4F_RETRIES no puede ser negativo; usa 0 para desactivar los reintentos.' })
    .max(10, { message: 'T4F_RETRIES no puede ser mayor que 10: evita machacar la API de tools4foresight con reintentos descontrolados.' }),
  cacheTtlMs: z.coerce
    .number({ error: 'T4F_CACHE_TTL_MS debe ser un número de milisegundos. Usa 0 para desactivar la caché.' })
    .int({ message: 'T4F_CACHE_TTL_MS debe ser un entero (milisegundos), sin decimales.' })
    .min(0, { message: 'T4F_CACHE_TTL_MS no puede ser negativo.' }),
  cacheMaxEntries: z.coerce
    .number({ error: 'El tope de entradas de caché debe ser un entero positivo.' })
    .int({ message: 'El tope de entradas de caché debe ser un entero, sin decimales.' })
    .positive({ message: 'El tope de entradas de caché debe ser mayor que 0.' }),
  logLevel: z.enum(['silent', 'error', 'debug'], {
    error: "T4F_LOG_LEVEL debe ser uno de: 'silent', 'error' o 'debug'.",
  }),
});

export type Config = z.infer<typeof configSchema>;

/**
 * Núcleo compartido por los dos cargadores: valida TODO igual y solo cambia de
 * dónde sale la clave. Que sea una sola función es lo que garantiza que el modo
 * de desarrollo y el modo remoto no puedan divergir en validaciones (por
 * ejemplo, que uno exija https y el otro no).
 */
function buildConfig(apiKey: string | undefined, env: NodeJS.ProcessEnv, missingKeyMessage: string): Config {
  const raw = {
    baseUrl: emptyToUndefined(env.T4F_API_BASE_URL),
    apiKey: emptyToUndefined(apiKey),
    timeoutMs: emptyToUndefined(env.T4F_TIMEOUT_MS) ?? String(DEFAULT_TIMEOUT_MS),
    retries: emptyToUndefined(env.T4F_RETRIES) ?? String(DEFAULT_RETRIES),
    cacheTtlMs: emptyToUndefined(env.T4F_CACHE_TTL_MS) ?? String(DEFAULT_CACHE_TTL_MS),
    cacheMaxEntries: String(DEFAULT_CACHE_MAX_ENTRIES),
    logLevel: emptyToUndefined(env.T4F_LOG_LEVEL) ?? DEFAULT_LOG_LEVEL,
  };

  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const detalle = result.error.issues
      // El mensaje genérico de "falta la clave" se sustituye por el del camino
      // concreto (cabecera vs. variable de entorno): decirle a un usuario del
      // despliegue remoto que "ponga T4F_API_KEY" lo mandaría a tocar algo que
      // no controla.
      .map((issue) => (issue.path[0] === 'apiKey' ? missingKeyMessage : issue.message))
      .map((message) => `- ${message}`)
      .join('\n');
    throw new ConfigError(`Configuración del servidor MCP inválida:\n${detalle}`);
  }
  return result.data;
}

/**
 * Camino de DESARROLLO/self-host (stdio, `npm run dev:http`): la clave sale de
 * `T4F_API_KEY`. Sirve para el MCP Inspector y para que una sola persona corra
 * el servidor contra su propio banco. **No es el modo soportado**: un despliegue
 * compartido que use esto serviría el banco de una sola persona a todo el que
 * diera con la URL.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return buildConfig(env.T4F_API_KEY, env, MISSING_ENV_API_KEY_MESSAGE);
}

/**
 * Camino SOPORTADO (despliegue remoto multi-tenant): la clave la trae el cliente
 * en la cabecera `Authorization` de esta petición concreta y no se guarda en
 * ningún sitio. Todo lo demás (URL base, timeouts, caché) sale del entorno del
 * proceso, que es configuración del operador y no es secreta.
 *
 * Aquí NO se valida que la clave sea buena: eso lo decide la API de
 * tools4foresight, que es la única que sabe a qué dueño resuelve. Adivinarlo
 * aquí solo produciría dos verdades distintas sobre quién eres.
 */
export function loadConfigForRequest(apiKey: string | undefined, env: NodeJS.ProcessEnv = process.env): Config {
  return buildConfig(apiKey, env, MISSING_REQUEST_API_KEY_MESSAGE);
}
