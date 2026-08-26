/**
 * Filtros de la API pública: parseo de query params -> `where` de Prisma.
 *
 * ═══ ESTE ARCHIVO NO PROTEGE NADA ════════════════════════════════════════════
 * Los `where` que salen de aquí **no llevan `ownerId`, y no deben llevarlo**.
 * El aislamiento entre bancos lo dan `withOwner()` (que fija `app.owner_id` y deja
 * que RLS haga el filtrado en Postgres) y `tenantClient()` (que inyecta el dueño en
 * el `where` de cada operación del ORM) — ver `src/lib/tenant-db.ts`.
 *
 * La tentación aquí es agregar `ownerId` "por si acaso". No hacerlo, por dos
 * razones: media barrera repartida en dos sitios es peor que una barrera entera en
 * uno (nadie sabe cuál de las dos está fallando cuando falla), y sobre todo porque
 * quien lea este archivo creyendo que aísla tenants bajará la guardia en el route
 * handler, que es donde el aislamiento SÍ vive. Un `buildPublicWhere` sin dueño
 * corriendo fuera de `withOwner` debe devolver el banco vacío o fallar — nunca el
 * de otra persona —, y eso es responsabilidad de RLS, no de este archivo.
 *
 * En el origen de este código existía además `PUBLISHED_ONLY`, una cláusula que
 * SIEMPRE se metía en el `where` para acotar a `publishStatus: 'published'`: allá el
 * scope era el estado de publicación, porque la API servía el acervo de una persona
 * a lectores ajenos. Aquí el scope es el tenant, y la persona ve su banco completo
 * (PLAN_MCP §0.2). Esa constante se eliminó por entero; en su lugar hay un filtro
 * `publishStatus` OPCIONAL que el usuario pide cuando quiere, y que por omisión no
 * filtra nada.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * Reutiliza `buildWhere` de `src/lib/liked-items-query.ts` para no duplicar la
 * lógica de búsqueda de texto y de categorías/PESTEL (ese archivo no se toca, y en
 * este repo tiene exactamente la misma forma que en el origen: `{ range, categories,
 * pestel, search }` -> `Prisma.LikedItemWhereInput`, sin noción de dueño). Se le pasa
 * `range: "all"` porque el rango real de fechas de la API pública son los parámetros
 * explícitos `from`/`to` (ISO), no los presets `week|month|6months` de la UI interna.
 */
import type { Prisma } from "@/generated/prisma/client";
import { PublicApiError } from "@/lib/public-api-auth";
import { buildWhere } from "@/lib/liked-items-query";
import { isHorizon, type HorizonKey } from "@/lib/horizons";
import { pestelDimension } from "@/config/pestel";

/** Estado del TEMA (`semantic_clusters.status`). No confundir con el de la señal. */
export type ThemeStatusFilter = "alive" | "dead" | "any";

/**
 * Estado de publicación de la SEÑAL (`liked_items.publish_status`, cuyos únicos
 * valores en el schema son `pending` —el default— y `published`).
 *
 * Va bajo el query param `publishStatus` y no bajo `status` a propósito: `status` ya
 * significa "estado del tema" en toda la API (`/themes?status=alive`, y el mismo
 * parámetro en `/signals` filtra por el tema al que pertenece la señal). Reciclar esa
 * palabra para dos cosas distintas haría que `/signals?status=published` y
 * `/signals?status=alive` fueran el mismo parámetro con dos vocabularios — el tipo de
 * ambigüedad que un agente resuelve mal y en silencio.
 */
export type PublishStatusFilter = "published" | "pending" | "any";

export type PublicSignalFilters = {
  /** Vacío = todas. Acepta `?category=a&category=b` (repetible) o `?categories=a,b`. */
  categories: string[];
  /** Vacío = todas. `?pestel=social,legal`; cada valor debe ser una clave conocida
   *  de `config/pestel.ts` o se rechaza con 400 (no se filtra en silencio: un typo
   *  en el parámetro no debe devolver "todo" sin avisar). */
  pestel: string[];
  horizon: HorizonKey | null;
  /** `?theme=<id>` — filtra por `clusterId` exacto. */
  themeId: string | null;
  /** `?macroTheme=<id>` — filtra por `cluster.macroClusterId`. */
  macroThemeId: string | null;
  /** Estado del TEMA al que pertenece la señal (no de la señal misma). */
  status: ThemeStatusFilter;
  /** `?publishStatus=published|pending`. `any` (el default) = el banco entero. */
  publishStatus: PublishStatusFilter;
  from: Date | null;
  to: Date | null;
  search: string;
  minVitality: number | null;
  /** `?orphans=true` — señales sin tema (`clusterId: null`). */
  orphansOnly: boolean;
};

// ------------------------------- Parseo de parámetros --------------------------------

/** Junta valores repetidos (`?x=a&x=b`) y/o separados por coma (`?x=a,b`) bajo la
 *  misma clave, recorta y descarta vacíos. */
function splitParamValues(params: URLSearchParams, key: string): string[] {
  return params
    .getAll(key)
    .flatMap((raw) => raw.split(","))
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

/**
 * Cota de la búsqueda de texto. Cada `q` se convierte en cinco `ILIKE '%…%'`
 * sobre columnas de texto sin índice trigram: no hay forma barata de que
 * Postgres descarte filas, así que el coste crece con la longitud del patrón
 * multiplicada por el corpus. 200 caracteres es más de lo que nadie busca a
 * mano y menos de lo que sirve para quemar CPU.
 */
const MAX_SEARCH_LENGTH = 200;

function parseSearchParam(params: URLSearchParams): string {
  const raw = params.get("q") ?? "";
  if (raw.length > MAX_SEARCH_LENGTH) {
    throw new PublicApiError(
      "invalid_parameter",
      `El parámetro "q" no puede superar los ${MAX_SEARCH_LENGTH} caracteres.`,
      400,
      "q",
    );
  }
  return raw;
}

/**
 * Cota del filtro por categorías. `category` es repetible y `categories` es
 * csv, así que una sola URL puede traer decenas de miles de valores: el `in`
 * resultante revienta el tope de parámetros de Postgres y sale un 500 que no
 * filtra nada pero es gratis de provocar. Un catálogo de tenant tiene ~11 filas.
 */
const MAX_CATEGORY_VALUES = 50;

function parseCategoriesParam(params: URLSearchParams): string[] {
  // "category" (repetible, forma canónica de la UI interna) y "categories" (csv,
  // forma canónica de la API pública) son alias del mismo filtro.
  const merged = [...splitParamValues(params, "category"), ...splitParamValues(params, "categories")];
  const unique = Array.from(new Set(merged));
  if (unique.length > MAX_CATEGORY_VALUES) {
    throw new PublicApiError(
      "invalid_parameter",
      `El parámetro "category" no admite más de ${MAX_CATEGORY_VALUES} valores distintos.`,
      400,
      "category",
    );
  }
  return unique;
}

function parsePestelParam(params: URLSearchParams): string[] {
  const values = Array.from(new Set(splitParamValues(params, "pestel")));
  for (const value of values) {
    if (!pestelDimension(value)) {
      throw new PublicApiError(
        "invalid_parameter",
        `El parámetro "pestel" tiene un valor desconocido: "${value}".`,
        400,
        "pestel",
      );
    }
  }
  return values;
}

function parseHorizonParam(raw: string | null): HorizonKey | null {
  if (!raw) return null;
  if (!isHorizon(raw)) {
    throw new PublicApiError("invalid_parameter", 'El parámetro "horizon" debe ser H1, H2 o H3.', 400, "horizon");
  }
  return raw;
}

function parseStatusParam(raw: string | null): ThemeStatusFilter {
  if (!raw) return "any";
  if (raw === "alive" || raw === "dead" || raw === "any") return raw;
  throw new PublicApiError("invalid_parameter", 'El parámetro "status" debe ser alive, dead o any.', 400, "status");
}

/** Sin valor = `any` = sin filtro. Es un filtro que el usuario pide, no uno impuesto. */
function parsePublishStatusParam(raw: string | null): PublishStatusFilter {
  if (!raw) return "any";
  if (raw === "published" || raw === "pending" || raw === "any") return raw;
  throw new PublicApiError(
    "invalid_parameter",
    'El parámetro "publishStatus" debe ser published, pending o any.',
    400,
    "publishStatus",
  );
}

function parseDateParam(raw: string | null, param: string): Date | null {
  if (!raw) return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw new PublicApiError(
      "invalid_parameter",
      `El parámetro "${param}" no es una fecha ISO válida.`,
      400,
      param,
    );
  }
  return date;
}

function parseMinVitalityParam(raw: string | null): number | null {
  if (raw === null || raw === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new PublicApiError(
      "invalid_parameter",
      'El parámetro "minVitality" debe ser numérico.',
      400,
      "minVitality",
    );
  }
  return value;
}

function parseBooleanParam(raw: string | null): boolean {
  return raw === "true";
}

export function publicFiltersFromSearchParams(params: URLSearchParams): PublicSignalFilters {
  return {
    categories: parseCategoriesParam(params),
    pestel: parsePestelParam(params),
    horizon: parseHorizonParam(params.get("horizon")),
    themeId: params.get("theme") || null,
    macroThemeId: params.get("macroTheme") || null,
    status: parseStatusParam(params.get("status")),
    publishStatus: parsePublishStatusParam(params.get("publishStatus")),
    from: parseDateParam(params.get("from"), "from"),
    to: parseDateParam(params.get("to"), "to"),
    search: parseSearchParam(params),
    minVitality: parseMinVitalityParam(params.get("minVitality")),
    orphansOnly: parseBooleanParam(params.get("orphans")),
  };
}

// ------------------------------------ Where --------------------------------------------

/**
 * `AND` de cláusulas en vez de un objeto plano fusionado: cada filtro agrega su
 * propia cláusula sin arriesgarse a pisar una clave que `buildWhere` ya haya usado
 * (p.ej. su propio `OR` de categorías/búsqueda).
 *
 * Recordatorio, porque es exactamente aquí donde alguien lo agregaría: **sin
 * `ownerId`**. Ver el bloque de cabecera.
 */
export function buildPublicWhere(filters: PublicSignalFilters): Prisma.LikedItemWhereInput {
  const base = buildWhere({
    range: "all",
    categories: filters.categories,
    pestel: filters.pestel,
    // La búsqueda de texto se rearma abajo con tldr/whyMatters incluidos (buildWhere
    // no los conoce y no se toca ese archivo para agregarlos).
    search: "",
  });

  const clauses: Prisma.LikedItemWhereInput[] = [base];

  if (filters.publishStatus !== "any") {
    clauses.push({ publishStatus: filters.publishStatus });
  }

  if (filters.from || filters.to) {
    clauses.push({
      likedAt: {
        ...(filters.from ? { gte: filters.from } : {}),
        ...(filters.to ? { lte: filters.to } : {}),
      },
    });
  }

  if (filters.search.trim()) {
    const q = filters.search.trim();
    clauses.push({
      OR: [
        { tweetText: { contains: q, mode: "insensitive" } },
        { contentTitle: { contains: q, mode: "insensitive" } },
        { authorHandle: { contains: q, mode: "insensitive" } },
        { tldr: { contains: q, mode: "insensitive" } },
        { whyMatters: { contains: q, mode: "insensitive" } },
      ],
    });
  }

  if (filters.minVitality !== null) {
    clauses.push({ vitality: { gte: filters.minVitality } });
  }

  if (filters.orphansOnly) {
    clauses.push({ clusterId: null });
  }

  if (filters.themeId) {
    clauses.push({ clusterId: filters.themeId });
  }

  if (filters.horizon || filters.status !== "any" || filters.macroThemeId) {
    clauses.push({
      cluster: {
        ...(filters.horizon ? { horizon: filters.horizon } : {}),
        ...(filters.status !== "any" ? { status: filters.status } : {}),
        ...(filters.macroThemeId ? { macroClusterId: filters.macroThemeId } : {}),
      },
    });
  }

  return { AND: clauses };
}

// ==================================== Temas ===============================================

export type PublicThemeFilters = {
  status: ThemeStatusFilter;
  horizon: HorizonKey | null;
  macroThemeId: string | null;
  search: string;
  minVitality: number | null;
};

export function publicThemeFiltersFromSearchParams(params: URLSearchParams): PublicThemeFilters {
  return {
    status: parseStatusParam(params.get("status")),
    horizon: parseHorizonParam(params.get("horizon")),
    macroThemeId: params.get("macroTheme") || null,
    search: parseSearchParam(params),
    minVitality: parseMinVitalityParam(params.get("minVitality")),
  };
}

/**
 * `SemanticCluster` no tiene `publishStatus` propio (es de `LikedItem`), así que
 * aquí no hay filtro de publicación que aplicar: solo los filtros que sí son
 * columnas del tema. Igual que arriba, sin `ownerId`.
 */
export function buildThemeWhere(filters: PublicThemeFilters): Prisma.SemanticClusterWhereInput {
  const clauses: Prisma.SemanticClusterWhereInput[] = [];

  if (filters.status !== "any") clauses.push({ status: filters.status });
  if (filters.horizon) clauses.push({ horizon: filters.horizon });
  if (filters.macroThemeId) clauses.push({ macroClusterId: filters.macroThemeId });
  if (filters.minVitality !== null) clauses.push({ vitality: { gte: filters.minVitality } });

  if (filters.search.trim()) {
    const q = filters.search.trim();
    clauses.push({
      OR: [
        { name: { contains: q, mode: "insensitive" } },
        { summary: { contains: q, mode: "insensitive" } },
      ],
    });
  }

  return clauses.length > 0 ? { AND: clauses } : {};
}
