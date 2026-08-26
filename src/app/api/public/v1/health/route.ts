/**
 * GET /api/public/v1/health — sonda de vida de la API pública.
 *
 * DECISIÓN DE DISEÑO (por qué este endpoint no es un port literal del origen):
 * en el repo de origen esto era una sonda de despliegue, sin auth y sin tenant —
 * "¿el servicio contesta?". Aquí la petición YA llega autenticada por
 * `withPublicApi` y atada a un `ownerId` (PLAN_MCP §0), así que "el servicio"
 * significa algo más preciso: no solo "Postgres responde" en abstracto, sino
 * "el camino de ESTE tenant hasta su banco funciona".
 *
 * Por eso el chequeo de base de datos corre DENTRO de `withOwner(ownerId, …)` y
 * no como un `prisma.$queryRaw` suelto contra el cliente global: además de
 * confirmar que Postgres contesta, confirma que `set_config('app.owner_id', …)`
 * y la transacción de este tenant se ejecutan sin error — la vía real que usa
 * cualquier otro endpoint de esta API para esa misma clave.
 *
 * Lo que este endpoint NUNCA reporta, y por qué: ningún conteo agregado de la
 * PLATAFORMA (cuántos usuarios hay, tamaño total de la base, cuántas claves
 * existen). Eso no es "salud de la API pública" para quien pregunta — es
 * información de otros tenants filtrándose por una puerta que parece inocua
 * porque no es un endpoint de contenido. Tampoco se reporta aquí ningún conteo
 * DEL PROPIO banco (señales, temas, snapshots): ese trabajo ya lo hace `/meta`
 * con su propio caché; duplicarlo en `/health` solo crearía dos fuentes de
 * verdad para el mismo número. `/health` se queda deliberadamente trivial: un
 * booleano de disponibilidad, nada de aritmética sobre datos de nadie.
 *
 * Nunca se cachea (`cache: "live"`): un health cacheado podría decir "ok" con la
 * base caída, o "degraded" ya resuelto.
 */
import type { NextRequest } from "next/server";
import { withOwner } from "@/lib/tenant-db";
import { handleOptions, ok, withPublicApi, PUBLIC_API_VERSION } from "@/lib/public-api-response";

export const runtime = "nodejs";

async function handler(
  request: NextRequest,
  _ctx: unknown,
  { ownerId }: { ownerId: string; keyId: string },
) {
  let db: "ok" | "down" = "ok";
  try {
    await withOwner(ownerId, (tx) => tx.$queryRaw`SELECT 1`);
  } catch (error) {
    // El error real solo al log: al cliente no le sirve el mensaje de Postgres y
    // sí le filtraría detalles de la infraestructura.
    console.error("[public-api] health: la base no responde:", error);
    db = "down";
  }

  return ok(
    {
      // 200 incluso en "degraded": así el cliente distingue "la API está caída"
      // (sin respuesta, o 5xx) de "la API vive pero su base no" (200 explícito).
      // Un 503 aquí borraría esa diferencia.
      status: db === "ok" ? "ok" : "degraded",
      apiVersion: PUBLIC_API_VERSION,
      db,
      checkedAt: new Date().toISOString(),
    },
    { cache: "live", request },
  );
}

export const GET = withPublicApi(handler);

export function OPTIONS(request: Request) {
  return handleOptions(request);
}
