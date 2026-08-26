import { NextRequest, NextResponse } from "next/server";
import { requireUserApi } from "@/lib/require-user";
import {
  ApiKeyLimitError,
  createApiKey,
  listApiKeys,
  revokeApiKey,
} from "@/lib/api-keys";

// Claves de la API pública/MCP de cada usuario, gestionadas desde /perfil.
// `api-keys.ts` ya deja claro que `api_keys` no es tabla de tenant (sin RLS):
// por eso aquí no hay `withOwner`, y el propio userId de la sesión hace de
// filtro en cada llamada a la librería.

const MAX_NAME_LENGTH = 60;

/** Las claves vigentes del usuario. El texto plano nunca vuelve aquí: la base no lo tiene. */
export async function GET() {
  const user = await requireUserApi();
  if (user instanceof NextResponse) return user;

  const keys = await listApiKeys(user.userId);
  return NextResponse.json({ keys });
}

/**
 * Crea una clave y devuelve su texto plano. Es la ÚNICA vez que existe fuera
 * de la memoria del proceso (ver el comentario de `createApiKey` en
 * api-keys.ts): si el usuario no la copia ahora, no hay forma de recuperarla
 * y tiene que crear otra. `no-store` explícito porque el cuerpo es un secreto.
 */
export async function POST(request: NextRequest) {
  const user = await requireUserApi();
  if (user instanceof NextResponse) return user;

  let body: { name?: unknown };
  try {
    body = (await request.json()) as { name?: unknown };
  } catch {
    return NextResponse.json({ error: "Cuerpo inválido" }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > MAX_NAME_LENGTH) {
    return NextResponse.json(
      { error: `Ponle un nombre de 1 a ${MAX_NAME_LENGTH} caracteres.` },
      { status: 400 },
    );
  }

  try {
    const key = await createApiKey(user.userId, name);
    const response = NextResponse.json({
      key: {
        id: key.id,
        name: key.name,
        prefix: key.prefix,
        createdAt: key.createdAt,
        // Se muestra una sola vez, en esta respuesta.
        plaintext: key.plaintext,
      },
    });
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (error) {
    // El tope de claves activas es un error de usuario (400), no del servidor.
    if (error instanceof ApiKeyLimitError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
}

/**
 * Revoca una clave (soft-delete). El id viaja en el query string y no en el
 * cuerpo: no todos los clientes mandan body en un DELETE. El 404 es el mismo
 * tanto si la clave no existe como si es de otra persona — `revokeApiKey` ya
 * filtra por `userId`, así que no hay forma de usar este endpoint para
 * descubrir ids ajenos.
 */
export async function DELETE(request: NextRequest) {
  const user = await requireUserApi();
  if (user instanceof NextResponse) return user;

  const id = request.nextUrl.searchParams.get("id")?.trim();
  if (!id) {
    return NextResponse.json({ error: "Falta el id de la clave" }, { status: 400 });
  }

  const revoked = await revokeApiKey(user.userId, id);
  if (!revoked) {
    return NextResponse.json({ error: "Esa clave no existe" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
