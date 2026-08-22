-- Quita Foresight (columna generada por Claude vía BYOK) y toda la
-- infraestructura de BYOK de Anthropic: ya no se genera ese campo.

-- DropForeignKey
ALTER TABLE "user_secrets" DROP CONSTRAINT "user_secrets_user_id_fkey";

-- AlterTable
ALTER TABLE "liked_items" DROP COLUMN "foresight",
DROP COLUMN "foresight_generated_at",
DROP COLUMN "foresight_source";

-- DropTable
DROP TABLE "user_secrets";

-- Limpia overrides huérfanos del prompt de foresight, que ya no tiene lector.
DELETE FROM "prompt_settings" WHERE "key" = 'foresight';
