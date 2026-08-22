import { NextRequest, NextResponse } from "next/server";
import { tenantClient } from "@/lib/tenant-db";
import { manualItemInput } from "@/lib/manual-link";
import { CsvTooLargeError, parseCsvLinks } from "@/lib/csv-links";
import { requireUserApi } from "@/lib/require-user";

const MAX_FILE_BYTES = 1_000_000;

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

  const client = tenantClient(user.userId);

  // Un enlace que ya llego por un like de X vive en `contentUrl`; uno agregado a
  // mano (o por un CSV anterior) vive en las dos columnas. El unique de la tabla es
  // sobre `tweetId`, no sobre la URL, así que sin este chequeo se duplicaría la fila.
  const existing = await client.likedItem.findMany({
    where: { OR: [{ contentUrl: { in: parsed.urls } }, { tweetUrl: { in: parsed.urls } }] },
    select: { contentUrl: true, tweetUrl: true },
  });
  const existingUrls = new Set(
    existing.flatMap((item) => [item.contentUrl, item.tweetUrl].filter((url): url is string => !!url)),
  );

  const newUrls = parsed.urls.filter((url) => !existingUrls.has(url));

  if (newUrls.length > 0) {
    await client.likedItem.createMany({
      data: newUrls.map((url) => manualItemInput(url, user.userId)),
    });
  }

  return NextResponse.json({
    created: newUrls.length,
    duplicates: parsed.urls.length - newUrls.length,
    invalid: parsed.invalid,
  });
}
