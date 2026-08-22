-- AlterTable
ALTER TABLE "liked_items" ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "tags_generated_at" TIMESTAMP(3),
ADD COLUMN     "tags_source" TEXT NOT NULL DEFAULT 'auto';
