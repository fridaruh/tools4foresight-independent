import { InvalidLinkError, normalizeLinkUrl } from "@/lib/manual-link";

/**
 * Carga en batch de la misma acción que "agregar un enlace a mano" (ver
 * manual-link.ts), un CSV a la vez. El formato es deliberadamente mínimo: una URL
 * por fila. Si la fila trae más columnas (CSV real, no una lista de URLs) se toma
 * solo la primera celda — esto no es un importador de metadata, solo de enlaces.
 */
export const MAX_CSV_ROWS = 500;

export class CsvTooLargeError extends Error {}

export type CsvParseResult = {
  /** URLs normalizadas y sin duplicados dentro del propio archivo, en orden de aparición. */
  urls: string[];
  invalid: { line: number; raw: string; reason: string }[];
};

function firstCell(line: string): string {
  const cell = line.includes(",") ? line.split(",")[0] : line;
  return cell.trim().replace(/^"(.*)"$/, "$1").trim();
}

const HEADER_CELLS = /^(url|enlace|link)$/i;

export function parseCsvLinks(text: string): CsvParseResult {
  const rows = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (rows.length > MAX_CSV_ROWS) {
    throw new CsvTooLargeError(
      `El archivo trae ${rows.length} filas; el máximo por carga es ${MAX_CSV_ROWS}.`,
    );
  }

  const seen = new Set<string>();
  const urls: string[] = [];
  const invalid: CsvParseResult["invalid"] = [];

  rows.forEach((line, index) => {
    const cell = firstCell(line);
    if (index === 0 && HEADER_CELLS.test(cell)) return;

    try {
      const url = normalizeLinkUrl(cell);
      if (!seen.has(url)) {
        seen.add(url);
        urls.push(url);
      }
    } catch (error) {
      const reason = error instanceof InvalidLinkError ? error.message : "Error desconocido.";
      invalid.push({ line: index + 1, raw: cell, reason });
    }
  });

  return { urls, invalid };
}
