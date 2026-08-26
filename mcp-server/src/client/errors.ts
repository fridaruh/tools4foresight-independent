// Errores del cliente HTTP, traducidos para que el LLM sepa QUÉ HACER, no solo qué
// pasó (docs/PLAN.md §2.5). Se devuelven desde las tools como `{ content: [...],
// isError: true }` — nunca como una excepción de protocolo MCP — así que el texto
// de `messageForModel()` es lo único que el modelo llega a leer.
import type { ErrorCode } from './types.js';

/** Códigos de error que puede llevar un T4FApiError, más allá de los `ErrorCode` de la API. */
export type T4FErrorCode = ErrorCode | 'network_error' | 'timeout' | 'invalid_response';

export type T4FApiErrorOptions = {
  /** `null` cuando nunca hubo respuesta HTTP (red caída, timeout). */
  status: number | null;
  code: T4FErrorCode;
  message: string;
  param?: string | null;
  /** Número de reintentos ya realizados antes de rendirse; solo relevante en 5xx/red. */
  attempts?: number;
};

/**
 * Traducción del vocabulario del CONTRATO HTTP al vocabulario de las TOOLS.
 *
 * Los parámetros públicos de las tools son snake_case (`min_score`,
 * `theme_id`, …) y el cliente los mapea al camelCase que espera la API pública
 * (`minScore`, `theme`, …) antes de salir a la red. Cuando la API rechaza uno,
 * responde con SU nombre: el 400 real de producción dice
 * `Parámetro inválido ("minScore")`, un nombre que el modelo no puede corregir
 * porque no existe en ninguna tool — así que reintenta con la palabra
 * equivocada y vuelve a fallar.
 *
 * Se resuelve aquí, en la frontera, y no caso por caso en cada tool: es el
 * único punto por el que pasan TODOS los errores de la API, y una tabla se
 * revisa de un vistazo cuando se agrega un parámetro. Solo entran los nombres
 * que DIFIEREN; `limit`, `cursor`, `from`, `to`, `horizon`, `sort`, `q`,
 * `category`, `pestel` y `status` se llaman igual en los dos lados y no
 * necesitan fila.
 *
 * `q` merece una nota: es literal en `list_signals` pero se llama `query` en
 * `search_signals`. Como `q` SÍ es un nombre de parámetro válido de una tool,
 * traducirlo sería cambiar un nombre correcto por otro correcto solo la mitad
 * de las veces. Se deja tal cual.
 *
 * Tampoco entra `publishStatus`, que la API sí valida: ninguna tool lo manda
 * (la persona ve el 100% de su banco, no hay filtro por curación), así que
 * darle una traducción sería inventar un parámetro que no existe.
 */
const HTTP_PARAM_TO_TOOL_PARAM: Readonly<Record<string, string>> = {
  minScore: 'min_score',
  minVitality: 'min_vitality',
  theme: 'theme_id',
  macroTheme: 'macro_theme_id',
  orphans: 'orphans_only',
  includeMembers: 'include_members',
};

/** El nombre con el que una tool conoce ese parámetro, o el mismo si no cambia. */
export function toolParamName(param: string): string {
  return HTTP_PARAM_TO_TOOL_PARAM[param] ?? param;
}

/**
 * El nombre del parámetro no viaja solo en el campo `param`: el `message` de la
 * API lo repite entrecomillado (`El parámetro "minScore" debe ser un número
 * entre 0 y 1.`). Traducir uno sin el otro dejaría el mensaje contradiciéndose
 * a sí mismo, así que se sustituyen las apariciones entrecomilladas — el
 * entrecomillado es lo que hace segura la sustitución: no toca prosa suelta.
 */
function translateMessageParams(message: string): string {
  let out = message;
  for (const [httpName, toolName] of Object.entries(HTTP_PARAM_TO_TOOL_PARAM)) {
    out = out.split(`"${httpName}"`).join(`"${toolName}"`);
  }
  return out;
}

export class T4FApiError extends Error {
  readonly status: number | null;
  readonly code: T4FErrorCode;
  readonly param: string | null;
  readonly attempts: number;

  constructor(opts: T4FApiErrorOptions) {
    super(opts.message);
    this.name = 'T4FApiError';
    this.status = opts.status;
    this.code = opts.code;
    this.param = opts.param ?? null;
    this.attempts = opts.attempts ?? 0;
  }

  /**
   * Traduce el error a instrucciones accionables para el LLM (tabla de §2.5).
   * Deliberadamente NO es solo `this.message`: un modelo que solo sabe "hubo un
   * 404" reintenta a ciegas; uno que sabe "usa list_signals para un id válido"
   * puede recuperarse.
   */
  messageForModel(): string {
    switch (this.status) {
      case 401:
        return 'La API key de tools4foresight es inválida, fue revocada o falta. Es la clave que identifica TU banco de señales: revísala en la cabecera Authorization de tu cliente MCP, o genera una nueva en /perfil. No reintentes.';
      case 403:
        return 'tools4foresight rechazó el acceso con esa clave. No reintentes: no es un problema pasajero. (Ojo: pedir algo de otro banco NO da 403, da 404.)';
      case 404:
        // En multi-tenant, un id que existe en el banco de OTRA persona también
        // cae aquí: la API responde 404, nunca 403 (un 403 confirmaría que ese id
        // existe en algún sitio). Para el modelo, las dos situaciones son la misma.
        return 'No existe ese id en tu banco de señales. Usa list_signals o list_themes para obtener ids válidos.';
      case 429:
        return 'Límite de peticiones alcanzado. Espera unos segundos antes de volver a pedir.';
      case 400: {
        // Se habla SIEMPRE el vocabulario de la tool: el modelo solo puede
        // corregir un argumento cuyo nombre exista en el `inputSchema` que él ve.
        const param = this.param ? toolParamName(this.param) : null;
        return `Parámetro inválido${param ? ` ("${param}")` : ''}: ${translateMessageParams(this.message)} Corrige el argumento de la tool y vuelve a intentar.`;
      }
      case 503:
        return 'La API pública de tools4foresight está deshabilitada temporalmente del lado del servidor. No es un problema de tu petición; intenta más tarde.';
      default:
        if (this.status === null) {
          return `tools4foresight no respondió (error de red${this.code === 'timeout' ? '/timeout' : ''}). Ya se reintentó ${this.attempts} veces. Si persiste, informa al usuario que el servicio podría estar caído.`;
        }
        if (this.status >= 500) {
          return `tools4foresight no respondió correctamente (HTTP ${this.status}). Ya se reintentó ${this.attempts} veces.`;
        }
        return `tools4foresight devolvió un error inesperado (HTTP ${this.status}): ${this.message}`;
    }
  }
}

/**
 * Solo se reintenta 429, 5xx y errores de red (`status === null`, sin respuesta
 * HTTP que lo descarte). Un 401 no se reintenta nunca: la clave no va a cambiar
 * sola entre un intento y el siguiente, y machacar la API con credenciales malas
 * es lo contrario de "buen ciudadano de red". Lo mismo para 400/404/403: son
 * errores del caller (parámetro malo, id inexistente, permisos), no del transporte.
 */
export function isRetryable(status: number | null): boolean {
  if (status === null) return true;
  if (status === 429) return true;
  return status >= 500 && status <= 599;
}
