import type { Prisma } from "@/generated/prisma/client";

// Rangos de fecha del filtro rapido. Se aplican sobre `likedAt` (la fecha del
// like estimada), que es lo que Frida pidio filtrar — no sobre la fecha del tweet
// ni la de deteccion.
export const DATE_RANGES = ["week", "month", "6months", "all"] as const;
export type DateRange = (typeof DATE_RANGES)[number];

export const DATE_RANGE_LABELS: Record<DateRange, string> = {
  week: "Última semana",
  month: "Último mes",
  "6months": "Últimos 6 meses",
  all: "Todo",
};

export function isDateRange(value: string | null): value is DateRange {
  return value !== null && (DATE_RANGES as readonly string[]).includes(value);
}

export function rangeStart(range: DateRange): Date | null {
  const now = new Date();
  switch (range) {
    case "week":
      return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    case "month":
      return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    case "6months": {
      const start = new Date(now);
      start.setMonth(start.getMonth() - 6);
      return start;
    }
    case "all":
      return null;
  }
}

export type LikedItemsFilters = {
  range: DateRange;
  /** Vacio = todas las categorias (seleccion multiple). */
  categories: string[];
  /** Vacio = todas las dimensiones PESTEL (seleccion multiple, ver config/pestel.ts). */
  pestel: string[];
  /** Busqueda libre sobre texto del tweet y titulo del contenido. */
  search: string;
};

export const DEFAULT_FILTERS: LikedItemsFilters = {
  range: "all",
  categories: [],
  pestel: [],
  search: "",
};

export function buildWhere(filters: LikedItemsFilters): Prisma.LikedItemWhereInput {
  const where: Prisma.LikedItemWhereInput = {};

  const from = rangeStart(filters.range);
  if (from) where.likedAt = { gte: from };

  if (filters.categories.length > 0) {
    // "Sin categorizar" no es una categoria guardada, es category = null.
    const named = filters.categories.filter((c) => c !== UNCATEGORIZED);
    const includeNull = filters.categories.includes(UNCATEGORIZED);

    const clauses: Prisma.LikedItemWhereInput[] = [];
    if (named.length > 0) clauses.push({ category: { in: named } });
    if (includeNull) clauses.push({ category: null });
    where.OR = clauses;
  }

  if (filters.pestel.length > 0) {
    where.pestel = { hasSome: filters.pestel };
  }

  if (filters.search.trim()) {
    const q = filters.search.trim();
    const searchClauses: Prisma.LikedItemWhereInput[] = [
      { tweetText: { contains: q, mode: "insensitive" } },
      { contentTitle: { contains: q, mode: "insensitive" } },
      { authorHandle: { contains: q, mode: "insensitive" } },
    ];
    // Si ya hay un OR por categorias, se combinan con AND para que los dos
    // filtros se apliquen juntos en vez de pisarse.
    if (where.OR) {
      where.AND = [{ OR: where.OR }, { OR: searchClauses }];
      delete where.OR;
    } else {
      where.OR = searchClauses;
    }
  }

  return where;
}

/** Valor sentinela para filtrar los items que todavia no tienen categoria. */
export const UNCATEGORIZED = "__sin_categoria__";

export function filtersFromSearchParams(params: URLSearchParams): LikedItemsFilters {
  const rangeParam = params.get("range");
  const categoriesParam = params.get("categories");
  const pestelParam = params.get("pestel");

  return {
    range: isDateRange(rangeParam) ? rangeParam : DEFAULT_FILTERS.range,
    categories: categoriesParam ? categoriesParam.split(",").filter(Boolean) : [],
    pestel: pestelParam ? pestelParam.split(",").filter(Boolean) : [],
    search: params.get("q") ?? "",
  };
}

export function filtersToSearchParams(filters: LikedItemsFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.range !== DEFAULT_FILTERS.range) params.set("range", filters.range);
  if (filters.categories.length > 0) params.set("categories", filters.categories.join(","));
  if (filters.pestel.length > 0) params.set("pestel", filters.pestel.join(","));
  if (filters.search.trim()) params.set("q", filters.search.trim());
  return params;
}
