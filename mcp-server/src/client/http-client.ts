// Cliente HTTP contra la API pública de tools4foresight (docs/PLAN.md §2.5).
// Único punto de entrada de red del servidor MCP: auth, timeout, reintentos,
// parseo de errores y caché en memoria viven aquí, no en las tools.
//
// MULTI-TENANT: una instancia de esta clase = un tenant = una petición. La clave
// que lleva `config.apiKey` es la de quien hizo ESTA petición, y `this.cache` es
// un campo de instancia (nunca un `Map` de módulo), así que dos tenants no
// comparten ni una entrada de caché. Ver `src/http-passthrough.ts`.
import { createRequire } from 'node:module';
import { Cache } from './cache.js';
import { T4FApiError, isRetryable, type T4FErrorCode } from './errors.js';
import type { Config } from '../config.js';
import type {
  ApiErrorBody,
  ApiItemResponse,
  ApiListResponse,
  CategoryDTO,
  GraphDTO,
  HealthDTO,
  HorizonDetailDTO,
  HorizonDTO,
  HorizonKey,
  MacroThemeDTO,
  MetaDTO,
  NeighborDTO,
  PestelDTO,
  SignalDetailDTO,
  SignalSummaryDTO,
  SnapshotDetailDTO,
  SnapshotSummaryDTO,
  ThemeDetailDTO,
  ThemeHistoryDTO,
  ThemeSummaryDTO,
} from './types.js';

// `createRequire` en vez de un import JSON (`import pkg from '../../package.json'
// with { type: 'json' }`): ese import attribute todavía es reciente y varía entre
// Node 20/22 y entre tsx/tsc, y nos obligaría a fijar una sintaxis frágil. Con
// `createRequire` leemos el JSON de forma síncrona y estable en cualquier
// combinación de runtime, sin duplicar la versión como literal (que se
// desincronizaría de `package.json` en cada release). El cálculo de la ruta
// relativa funciona igual en dev (`src/client/http-client.ts` → `../../package.json`
// = raíz del repo) y en build (`dist/client/http-client.js` → `../../package.json`
// = raíz del árbol compilado), porque ambos árboles tienen la misma profundidad.
const require = createRequire(import.meta.url);

function readPackageVersion(): string {
  try {
    const pkg = require('../../package.json') as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const PACKAGE_VERSION = readPackageVersion();

// TTLs de caché por dominio (§2.5). No dependen del valor exacto de
// `config.cacheTtlMs`: ese valor solo actúa como interruptor global
// (0 = caché desactivada por completo) y como TTL por defecto para llamadas a
// `get()` que no pasan `ttlMs` explícito. Los métodos de conveniencia siempre
// pasan uno de estos, calcado del perfil de caché HTTP que ya define §1.5 para
// cada endpoint (live/short/graph/static) traducido a las cuatro categorías de §2.5.
const TTL_TAXONOMY_MS = 10 * 60_000; // categorías, PESTEL: catálogos casi estáticos
const TTL_GRAPH_MS = 5 * 60_000; // temas, horizontes, macro-temas, grafo, vecinos, snapshots (lista)
const TTL_SIGNALS_MS = 60_000; // señales y meta: se mueven con cada corrida/publicación
const TTL_IMMUTABLE_MS = Infinity; // snapshot por id: una corrida pasada no cambia nunca
const TTL_NO_CACHE_MS = 0; // health: siempre en vivo, nunca servido desde caché

export type QueryValue = string | number | boolean | string[] | null | undefined;

export type RequestOpts = {
  path: string;
  query?: Record<string, QueryValue>;
  signal?: AbortSignal;
  /** `false` fuerza a saltarse la caché (lectura y escritura) para esta petición. */
  cache?: boolean;
  /**
   * TTL de caché en ms para esta petición concreta. Si se omite, se usa
   * `config.cacheTtlMs`. No está en el contrato mínimo de §2.5, pero es lo que
   * permite que `get()` siga siendo el único punto de entrada al transporte y a
   * la vez cada método de conveniencia declare el TTL de su propio dominio.
   */
  ttlMs?: number;
};

type Deps = {
  fetch?: typeof fetch;
  now?: () => number;
  /** Inyectable para que los tests de reintentos/backoff no esperen tiempo real. */
  sleep?: (ms: number) => Promise<void>;
};

// Construye la query string de forma determinista: claves ordenadas (para que la
// clave de caché no dependa del orden de inserción del objeto), `undefined`/`null`
// omitidos, arrays repetidos (`?a=1&a=2`) y booleanos como texto literal.
function buildQueryString(query: Record<string, QueryValue> | undefined): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const key of Object.keys(query).sort()) {
    const value = query[key];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === undefined || item === null) continue;
        params.append(key, String(item));
      }
      continue;
    }
    if (typeof value === 'boolean') {
      params.append(key, value ? 'true' : 'false');
      continue;
    }
    params.append(key, String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

// `Retry-After` puede venir como segundos o como fecha HTTP (RFC 9110 §10.2.3).
// Si no se puede interpretar, se devuelve `null` y el llamador cae al backoff
// calculado.
function parseRetryAfterMs(header: string | null, now: () => number): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(header);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - now());
  return null;
}

export class T4FClient {
  private readonly config: Config;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly cache: Cache<unknown>;

  constructor(config: Config, deps: Deps = {}) {
    this.config = config;
    // `fetch.bind(globalThis)`: en Node 20+ `fetch` es global (undici); enlazarlo
    // evita perder el `this` si algún día se pasa como referencia suelta.
    this.fetchFn = deps.fetch ?? fetch.bind(globalThis);
    this.now = deps.now ?? (() => Date.now());
    this.sleepFn = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.cache = new Cache({ maxEntries: config.cacheMaxEntries, now: this.now });
  }

  /** Punto de entrada genérico: transporte + caché. Los métodos de abajo son azúcar tipado sobre este. */
  async get<T>(opts: RequestOpts): Promise<T> {
    const ttlMs = opts.ttlMs ?? this.config.cacheTtlMs;
    const queryString = buildQueryString(opts.query);
    // T4F_CACHE_TTL_MS=0 es el interruptor global (§2.4/§2.5): apaga la caché
    // para TODAS las peticiones, sin importar el TTL de dominio que pida cada
    // método de conveniencia.
    const useCache = opts.cache !== false && this.config.cacheTtlMs !== 0 && ttlMs !== 0;
    const cacheKey = `GET ${opts.path}${queryString}`;

    if (useCache) {
      const cached = this.cache.get(cacheKey);
      if (cached !== undefined) return cached as T;
    }

    const data = await this.performRequest<T>(opts, queryString);

    if (useCache) {
      this.cache.set(cacheKey, data, ttlMs);
    }
    return data;
  }

  clearCache(): void {
    this.cache.clear();
  }

  private buildHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.apiKey}`,
      Accept: 'application/json',
      'User-Agent': `mcp-t4f-multitenant/${PACKAGE_VERSION}`,
    };
  }

  private async performRequest<T>(opts: RequestOpts, queryString: string): Promise<T> {
    const url = `${this.config.baseUrl}${opts.path}${queryString}`;
    const maxAttempts = this.config.retries + 1;
    let lastError: T4FApiError | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const timeoutSignal = AbortSignal.timeout(this.config.timeoutMs);
      const signal = opts.signal ? AbortSignal.any([timeoutSignal, opts.signal]) : timeoutSignal;

      let response: Response;
      try {
        response = await this.fetchFn(url, {
          method: 'GET',
          headers: this.buildHeaders(),
          signal,
        });
      } catch (err) {
        // Si fue el CALLER quien canceló su propia señal, no es un error de
        // transporte nuestro: se relanza tal cual, sin reintentar ni envolver en
        // T4FApiError (el llamador ya sabe que canceló).
        if (opts.signal?.aborted) {
          throw err;
        }
        const isTimeout = timeoutSignal.aborted;
        const code: T4FErrorCode = isTimeout ? 'timeout' : 'network_error';
        lastError = new T4FApiError({
          status: null,
          code,
          message:
            err instanceof Error
              ? err.message
              : 'Error de red desconocido al llamar a la API de tools4foresight.',
          attempts: attempt + 1,
        });
        if (attempt < maxAttempts - 1 && isRetryable(null)) {
          await this.delay(attempt, null);
          continue;
        }
        throw lastError;
      }

      if (response.ok) {
        try {
          return (await response.json()) as T;
        } catch {
          // 2xx con cuerpo no-JSON: no es un caso de reintento (no es 429/5xx/red),
          // es una respuesta mal formada del servidor.
          throw new T4FApiError({
            status: response.status,
            code: 'invalid_response',
            message: 'tools4foresight respondió con éxito pero el cuerpo no es JSON válido.',
            attempts: attempt + 1,
          });
        }
      }

      const apiError = await this.parseErrorResponse(response, attempt + 1);
      lastError = apiError;
      if (attempt < maxAttempts - 1 && isRetryable(response.status)) {
        await this.delay(attempt, response.headers.get('retry-after'));
        continue;
      }
      throw apiError;
    }

    // Inalcanzable: el bucle siempre retorna o lanza. Satisface a TypeScript.
    throw (
      lastError ??
      new T4FApiError({ status: null, code: 'network_error', message: 'Fallo desconocido al llamar a tools4foresight.' })
    );
  }

  // Cuerpo `{ error: { code, message, param } }` (§1.6). Si el cuerpo no es JSON
  // (HTML de un proxy, 502 de la plataforma, etc.) se genera un mensaje genérico
  // SIN incluir el cuerpo crudo: nunca se filtra HTML/markup arbitrario al LLM.
  private async parseErrorResponse(response: Response, attempts: number): Promise<T4FApiError> {
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      try {
        const body = (await response.json()) as Partial<ApiErrorBody>;
        return new T4FApiError({
          status: response.status,
          code: body.error?.code ?? 'internal_error',
          message: body.error?.message ?? `tools4foresight devolvió HTTP ${response.status}.`,
          param: body.error?.param ?? null,
          attempts,
        });
      } catch {
        // JSON anunciado en el content-type pero cuerpo corrupto: cae al genérico.
      }
    }
    return new T4FApiError({
      status: response.status,
      code: response.status === 429 ? 'rate_limited' : 'internal_error',
      message: `tools4foresight respondió con HTTP ${response.status} sin un cuerpo de error legible.`,
      attempts,
    });
  }

  // Backoff exponencial con jitter: `300ms * 2^intento ± 30%`, salvo que el
  // servidor mande `Retry-After` (§2.5), que siempre gana porque es información
  // explícita del servidor sobre cuánto esperar.
  private async delay(attempt: number, retryAfterHeader: string | null): Promise<void> {
    const retryAfterMs = parseRetryAfterMs(retryAfterHeader, this.now);
    const ms = retryAfterMs ?? this.computeBackoffMs(attempt);
    await this.sleepFn(ms);
  }

  private computeBackoffMs(attempt: number): number {
    const base = 300 * 2 ** attempt;
    const jitter = 1 + (Math.random() * 0.6 - 0.3); // factor en [0.7, 1.3]
    return Math.round(base * jitter);
  }

  // ---------------------------------------------------------------------------
  // Métodos de conveniencia, uno por endpoint de §1.5. Todos GET, todos con el
  // TTL de caché de su dominio (comentario junto a las constantes TTL_* arriba).
  // ---------------------------------------------------------------------------

  listSignals(params: ListSignalsParams = {}): Promise<ApiListResponse<SignalSummaryDTO>> {
    return this.get({
      path: '/signals',
      query: {
        cursor: params.cursor,
        limit: params.limit,
        q: params.q,
        category: params.category,
        pestel: params.pestel,
        horizon: params.horizon,
        theme: params.theme,
        macroTheme: params.macroTheme,
        status: params.status,
        from: params.from,
        to: params.to,
        minVitality: params.minVitality,
        orphans: params.orphans,
        sort: params.sort,
      },
      ttlMs: TTL_SIGNALS_MS,
    });
  }

  getSignal(signalId: string): Promise<ApiItemResponse<SignalDetailDTO>> {
    return this.get({ path: `/signals/${encodeURIComponent(signalId)}`, ttlMs: TTL_SIGNALS_MS });
  }

  getSignalNeighbors(
    signalId: string,
    params: { limit?: number; minScore?: number } = {},
  ): Promise<ApiListResponse<NeighborDTO>> {
    return this.get({
      path: `/signals/${encodeURIComponent(signalId)}/neighbors`,
      query: { limit: params.limit, minScore: params.minScore },
      ttlMs: TTL_GRAPH_MS,
    });
  }

  listThemes(params: ListThemesParams = {}): Promise<ApiListResponse<ThemeSummaryDTO>> {
    return this.get({
      path: '/themes',
      query: {
        cursor: params.cursor,
        limit: params.limit,
        status: params.status,
        horizon: params.horizon,
        macroTheme: params.macroTheme,
        q: params.q,
        sort: params.sort,
        minVitality: params.minVitality,
      },
      ttlMs: TTL_GRAPH_MS,
    });
  }

  getTheme(themeId: string): Promise<ApiItemResponse<ThemeDetailDTO>> {
    return this.get({ path: `/themes/${encodeURIComponent(themeId)}`, ttlMs: TTL_GRAPH_MS });
  }

  listThemeSignals(
    themeId: string,
    params: { cursor?: string; limit?: number; sort?: 'vitality' | 'likedAt' } = {},
  ): Promise<ApiListResponse<SignalSummaryDTO>> {
    return this.get({
      path: `/themes/${encodeURIComponent(themeId)}/signals`,
      query: { cursor: params.cursor, limit: params.limit, sort: params.sort },
      ttlMs: TTL_GRAPH_MS,
    });
  }

  getThemeHistory(
    themeId: string,
    params: { from?: string; to?: string; limit?: number } = {},
  ): Promise<ApiItemResponse<ThemeHistoryDTO>> {
    return this.get({
      path: `/themes/${encodeURIComponent(themeId)}/history`,
      query: { from: params.from, to: params.to, limit: params.limit },
      ttlMs: TTL_GRAPH_MS,
    });
  }

  listMacroThemes(params: { horizon?: HorizonKey } = {}): Promise<ApiListResponse<MacroThemeDTO>> {
    return this.get({ path: '/macro-themes', query: { horizon: params.horizon }, ttlMs: TTL_GRAPH_MS });
  }

  getHorizons(): Promise<ApiListResponse<HorizonDTO>> {
    return this.get({ path: '/horizons', ttlMs: TTL_GRAPH_MS });
  }

  getHorizon(key: HorizonKey): Promise<ApiItemResponse<HorizonDetailDTO>> {
    return this.get({ path: `/horizons/${encodeURIComponent(key)}`, ttlMs: TTL_GRAPH_MS });
  }

  listCategories(): Promise<ApiListResponse<CategoryDTO>> {
    return this.get({ path: '/categories', ttlMs: TTL_TAXONOMY_MS });
  }

  listPestel(): Promise<ApiListResponse<PestelDTO>> {
    return this.get({ path: '/pestel', ttlMs: TTL_TAXONOMY_MS });
  }

  getGraph(
    params: { horizon?: HorizonKey; minVitality?: number; minScore?: number; limit?: number } = {},
  ): Promise<ApiItemResponse<GraphDTO>> {
    return this.get({
      path: '/graph',
      query: {
        horizon: params.horizon,
        minVitality: params.minVitality,
        minScore: params.minScore,
        limit: params.limit,
      },
      ttlMs: TTL_GRAPH_MS,
    });
  }

  listSnapshots(
    params: { cursor?: string; limit?: number; from?: string; to?: string } = {},
  ): Promise<ApiListResponse<SnapshotSummaryDTO>> {
    return this.get({
      path: '/snapshots',
      query: { cursor: params.cursor, limit: params.limit, from: params.from, to: params.to },
      ttlMs: TTL_GRAPH_MS,
    });
  }

  getSnapshot(
    snapshotId: string,
    params: { includeMembers?: boolean } = {},
  ): Promise<ApiItemResponse<SnapshotDetailDTO>> {
    return this.get({
      path: `/snapshots/${encodeURIComponent(snapshotId)}`,
      query: { includeMembers: params.includeMembers },
      // Inmutable: una corrida pasada no cambia nunca. Es el único TTL que no es
      // un número finito (§2.5: "snapshot por id ∞").
      ttlMs: TTL_IMMUTABLE_MS,
    });
  }

  getMeta(): Promise<ApiItemResponse<MetaDTO>> {
    return this.get({ path: '/meta', ttlMs: TTL_SIGNALS_MS });
  }

  getHealth(): Promise<ApiItemResponse<HealthDTO>> {
    // Nunca se cachea: un health check cacheado deja de servir para lo que sirve.
    return this.get({ path: '/health', ttlMs: TTL_NO_CACHE_MS, cache: false });
  }
}

export type ListSignalsParams = {
  cursor?: string;
  limit?: number;
  q?: string;
  category?: string[];
  pestel?: string[];
  horizon?: HorizonKey;
  theme?: string;
  macroTheme?: string;
  status?: 'alive' | 'dead' | 'any';
  from?: string;
  to?: string;
  minVitality?: number;
  orphans?: boolean;
  /** §4.3: enum cerrado del servidor; cualquier otro valor es 400. */
  sort?: 'likedAt' | 'vitality';
};

export type ListThemesParams = {
  cursor?: string;
  limit?: number;
  status?: 'alive' | 'dead' | 'any';
  horizon?: HorizonKey;
  macroTheme?: string;
  q?: string;
  sort?: 'vitality' | 'size' | 'velocity' | 'lastSignal';
  minVitality?: number;
};
