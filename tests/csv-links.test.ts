import { describe, expect, it } from "vitest";
import { CsvTooLargeError, MAX_CSV_ROWS, parseCsvLinks } from "@/lib/csv-links";

describe("parseCsvLinks", () => {
  it("normaliza URLs, ignora el header opcional y deduplica", () => {
    const csv = ["url", "https://example.com/a", "example.com/a", "example.com/b"].join("\n");
    const result = parseCsvLinks(csv);
    expect(result.urls).toEqual(["https://example.com/a", "https://example.com/b"]);
    expect(result.invalid).toEqual([]);
  });

  it("toma solo la primera celda cuando hay más columnas", () => {
    const csv = "https://example.com/a,nota,otra-cosa";
    const result = parseCsvLinks(csv);
    expect(result.urls).toEqual(["https://example.com/a"]);
  });

  it("reporta filas inválidas con su número de línea", () => {
    const csv = ["https://example.com/a", "no es una url", ""].join("\n");
    const result = parseCsvLinks(csv);
    expect(result.urls).toEqual(["https://example.com/a"]);
    expect(result.invalid).toEqual([
      { line: 2, raw: "no es una url", reason: "Ese texto no es una URL válida." },
    ]);
  });

  it("rechaza archivos con más filas del límite", () => {
    const csv = Array.from({ length: MAX_CSV_ROWS + 1 }, (_, i) => `https://example.com/${i}`).join(
      "\n",
    );
    expect(() => parseCsvLinks(csv)).toThrow(CsvTooLargeError);
  });
});
