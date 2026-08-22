import { NextRequest, NextResponse } from "next/server";
import { withOwner } from "@/lib/tenant-db";
import { manualItemInput } from "@/lib/manual-link";
import { CsvTooLargeError, parseCsvLinks } from "@/lib/csv-links";
import { requireUserApi } from "@/lib/require-user";

const MAX_FILE_BYTES = 1_000_000;

// Hasta 1000 filas: el parseo es rápido, pero el INSERT + el chequeo de
// duplicados contra el catálogo entero puede tardar más que el default.
export const maxDuration = 60;

/**
 * Carga de enlaces en batch desde /conexion: mismo destino que
 * `POST /api/liked-items` (un LikedItem con `source: "manual"`), pero para un CSV
 * en vez de un enlace a la vez. No dispara fetch de contenido ni análisis — eso lo
 * recogen los jobs por cron, igual que cualquier `fetchStatus: "pending"`.
 */
export async function POST(request: NextRequest) {
  const user = await requireUserApi();
  if (user instanceof NextResponse) return user;

  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Falta el archivo CSV." }, { status: 400 });
  }
  if (file.size > MAX_FILE_BYTES) {
    return NextResponse.json({ error: "El archivo es demasiado grande (máximo 1 MB)." }, { status: 400 });
  }

  const text = await file.text();
  let parsed;
  try {
    parsed = parseCsvLinks(text);
  } catch (error) {
    if (error instanceof CsvTooLargeError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

  if (parsed.urls.length === 0) {
    return NextResponse.json({ created: 0, duplicates: 0, invalid: parsed.invalid });
  }

  const newUrls = await withOwner(user.userId, async (tx) => {
    // Un enlace que ya llego por un like de X vive en `contentUrl`; uno agregado a
    // mano (o por un CSV anterior) vive en las dos columnas. El unique de la tabla
    // es sobre `tweetId`, no sobre la URL, así que sin este chequeo se duplicaría
    // la fila.
    const existing = await tx.likedItem.findMany({
      where: {
        ownerId: user.userId,
        OR: [{ contentUrl: { in: parsed.urls } }, { tweetUrl: { in: parsed.urls } }],
      },
      select: { contentUrl: true, tweetUrl: true },
    });
    const existingUrls = new Set(
      existing.flatMap((item) => [item.contentUrl, item.tweetUrl].filter((url): url is string => !!url)),
    );
    const fresh = parsed.urls.filter((url) => !existingUrls.has(url));

    if (fresh.length > 0) {
      await tx.likedItem.createMany({
        data: fresh.map((url) => manualItemInput(url, user.userId)),
      });
    }
    return fresh;
  });

  return NextResponse.json({
    created: newUrls.length,
    duplicates: parsed.urls.length - newUrls.length,
    invalid: parsed.invalid,
  });
}
