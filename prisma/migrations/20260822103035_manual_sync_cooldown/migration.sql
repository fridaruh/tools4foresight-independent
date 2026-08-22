-- DropIndex
DROP INDEX "rate_limits_window_start";

-- AlterTable
ALTER TABLE "rate_limits" ALTER COLUMN "window_start" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "user_quotas" ADD COLUMN     "last_graph_refresh_at" TIMESTAMP(3),
ADD COLUMN     "last_manual_sync_at" TIMESTAMP(3);
