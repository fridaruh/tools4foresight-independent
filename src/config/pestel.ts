// Las seis dimensiones del analisis PESTEL, para la columna de seleccion multiple de
// la pantalla de enriquecimiento.
//
// El acronimo es en ingles (Political, Economic, Social, Technological, Environmental,
// Legal) pero la UI esta en español, asi que cada dimension lleva la letra que le toca
// en el acronimo por separado: la "E" se repite (Economico y Ecologico/Ambiental) y sin
// mostrarla explicita no se entiende de donde sale el nombre.
//
// `key` es lo que se guarda en la DB. Las etiquetas se pueden cambiar sin migrar datos.

export type PestelDimension = {
  key: string;
  letter: string;
  label: string;
};

export const PESTEL_DIMENSIONS: PestelDimension[] = [
  { key: "political", letter: "P", label: "Político" },
  { key: "economic", letter: "E", label: "Económico" },
  { key: "social", letter: "S", label: "Social" },
  { key: "technological", letter: "T", label: "Tecnológico" },
  { key: "environmental", letter: "E", label: "Ambiental" },
  { key: "legal", letter: "L", label: "Legal" },
];

const BY_KEY = new Map(PESTEL_DIMENSIONS.map((d) => [d.key, d]));

export function pestelDimension(key: string): PestelDimension | undefined {
  return BY_KEY.get(key);
}

/**
 * Filtra a claves conocidas y respeta el orden del acronimo, no el orden en que se
 * fueron marcando las casillas: asi la celda se lee igual en todas las filas.
 */
export function normalizePestel(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const picked = new Set(values.filter((v): v is string => typeof v === "string"));
  return PESTEL_DIMENSIONS.filter((d) => picked.has(d.key)).map((d) => d.key);
}
