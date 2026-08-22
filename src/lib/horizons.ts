export const HORIZONS = ["H1", "H2", "H3"] as const;
export type HorizonKey = (typeof HORIZONS)[number];

export const HORIZON_LABELS: Record<HorizonKey, { short: string; long: string }> = {
  H1: { short: "H1 · ya está pasando", long: "Tendencia consolidada: grande, viva y cerca del centro del mapa." },
  H2: { short: "H2 · en transición", long: "Tema que crece y conecta con otros; todavía no domina." },
  H3: { short: "H3 · señal débil", long: "Chico, lejano o con poca vitalidad: hipótesis a vigilar." },
};

export function isHorizon(value: unknown): value is HorizonKey {
  return typeof value === "string" && (HORIZONS as readonly string[]).includes(value);
}
