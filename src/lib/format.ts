const relativeFormatter = new Intl.RelativeTimeFormat("es", { numeric: "auto" });
const dateFormatter = new Intl.DateTimeFormat("es-MX", { day: "numeric", month: "short", year: "numeric" });
const longDateFormatter = new Intl.DateTimeFormat("es-MX", {
  day: "numeric",
  month: "long",
  year: "numeric",
});

export function timeAgo(date: Date): string {
  const diffMs = date.getTime() - Date.now();
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));

  if (Math.abs(diffDays) < 1) {
    const diffHours = Math.round(diffMs / (1000 * 60 * 60));
    if (diffHours === 0) return "hace un momento";
    return relativeFormatter.format(diffHours, "hour");
  }
  if (Math.abs(diffDays) < 30) return relativeFormatter.format(diffDays, "day");
  return dateFormatter.format(date);
}

export function formatDate(date: Date | string | null): string {
  if (!date) return "—";
  return dateFormatter.format(new Date(date));
}

export function formatLongDate(date: Date | string | null): string {
  if (!date) return "—";
  return longDateFormatter.format(new Date(date));
}

/**
 * Texto del tooltip de la fecha del like. La X API no expone cuando ocurrio el
 * like (ver PLAN 1.4), asi que la fecha que mostramos es una estimacion y hay que
 * decirlo donde se muestra, no solo en la documentacion.
 */
export function likedAtTooltip(likedAt: Date | string, source: string): string {
  const fecha = formatLongDate(likedAt);
  if (source === "manual") {
    // Aqui no hay nada que estimar: es cuando se pego el enlace.
    return `Lo agregaste a mano el ${fecha}.`;
  }
  if (source === "ordered") {
    return `Le diste like alrededor del ${fecha}. X no expone la fecha exacta del like; esta es una estimación acotada entre la sincronización anterior y la actual.`;
  }
  return `Aproximadamente el ${fecha}. X no expone la fecha exacta del like; para este item se usa la fecha de publicación del tweet como referencia.`;
}

export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 1).trimEnd() + "…";
}
