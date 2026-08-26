-- Claves de la API pública / MCP remoto: cada persona genera las suyas desde /perfil.
--
-- SIN RLS A PROPÓSITO. Es la misma excepción documentada para las tablas de
-- better-auth (users/sessions/accounts/verifications) en la migración `_rls` y en
-- el comentario de cabecera de src/lib/tenant-db.ts: `resolveApiKey()` es el query
-- que DESCUBRE quién es el tenant, corre antes de que exista un `app.owner_id` que
-- fijar, y con una política encima devolvería cero filas siempre — nadie podría
-- autenticarse nunca. La compensación es de aplicación: todo acceso a `api_keys`
-- lleva `user_id` en el `where`, sin excepción (src/lib/api-keys.ts), y
-- scripts/qa-tenant-isolation.ts verifica que esta tabla esté en la lista explícita
-- de excepciones y no sea un hueco silencioso.

-- CreateTable
CREATE TABLE "api_keys" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "last_used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- @unique sobre el hash: resolver una clave entrante es un índice, no un scan.
CREATE UNIQUE INDEX "api_keys_key_hash_key" ON "api_keys"("key_hash");

-- CreateIndex
CREATE INDEX "api_keys_user_id_idx" ON "api_keys"("user_id");

-- AddForeignKey
-- Cascade: borrar la cuenta invalida sus claves junto con su banco.
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- El rol de la app necesita los permisos explícitos igual que en `_rls`
-- (setup-app-role.ts ya deja ALTER DEFAULT PRIVILEGES, pero esto lo hace
-- idempotente si el rol se creó después de migrar).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 't4f_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "api_keys" TO t4f_app;
  END IF;
END
$$;
