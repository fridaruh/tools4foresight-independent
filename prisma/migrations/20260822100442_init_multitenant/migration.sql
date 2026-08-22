-- pgvector: la columna liked_items.embedding es vector(1536).
-- En Neon la extensión ya existe; esto hace la migración reproducible en una DB limpia.
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "role" TEXT NOT NULL DEFAULT 'user',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "token" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "user_id" TEXT NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "access_token" TEXT,
    "refresh_token" TEXT,
    "id_token" TEXT,
    "access_token_expires_at" TIMESTAMP(3),
    "refresh_token_expires_at" TIMESTAMP(3),
    "scope" TEXT,
    "password" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verifications" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3),

    CONSTRAINT "verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_secrets" (
    "user_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "encrypted" TEXT NOT NULL,
    "last4" TEXT NOT NULL,
    "model" TEXT,
    "verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_secrets_pkey" PRIMARY KEY ("user_id","provider")
);

-- CreateTable
CREATE TABLE "user_quotas" (
    "user_id" TEXT NOT NULL,
    "x_pages_per_day" INTEGER NOT NULL DEFAULT 2,
    "x_backfill_pages" INTEGER NOT NULL DEFAULT 3,
    "x_backfill_months" INTEGER NOT NULL DEFAULT 3,
    "analyze_items_per_day" INTEGER NOT NULL DEFAULT 150,
    "x_pages_used_today" INTEGER NOT NULL DEFAULT 0,
    "analyze_used_today" INTEGER NOT NULL DEFAULT 0,
    "window_reset_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pipeline_enabled" BOOLEAN NOT NULL DEFAULT true,
    "graph_dirty_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_quotas_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "usage_events" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "units" INTEGER NOT NULL,
    "tokens_in" INTEGER,
    "tokens_out" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_runs" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "job" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "processed" INTEGER NOT NULL DEFAULT 0,
    "remaining" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_flags" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_flags_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "x_auth_tokens" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "x_user_id" TEXT NOT NULL,
    "access_token" TEXT NOT NULL,
    "refresh_token" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "x_auth_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ingestion_cursor" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "last_tweet_id" TEXT,
    "last_run_at" TIMESTAMP(3),
    "last_status" TEXT NOT NULL DEFAULT 'idle',
    "last_error" TEXT,
    "retry_after" TIMESTAMP(3),
    "resume_pagination_token" TEXT,
    "pending_newest_tweet_id" TEXT,
    "max_like_rank" INTEGER,
    "min_like_rank" INTEGER,
    "backfill_reached_window" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ingestion_cursor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "examples" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "position" INTEGER NOT NULL DEFAULT 0,
    "is_fallback" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "liked_items" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'x_like',
    "tweet_id" TEXT NOT NULL,
    "author_handle" TEXT NOT NULL,
    "author_name" TEXT,
    "tweet_text" TEXT NOT NULL,
    "tweet_url" TEXT NOT NULL,
    "media_urls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tweet_created_at" TIMESTAMP(3),
    "detected_at" TIMESTAMP(3),
    "liked_at" TIMESTAMP(3) NOT NULL,
    "liked_at_source" TEXT NOT NULL DEFAULT 'tweet_date',
    "like_rank" INTEGER,
    "content_url" TEXT,
    "content_title" TEXT,
    "content_description" TEXT,
    "content_image_url" TEXT,
    "content_published_at" TIMESTAMP(3),
    "fetched_at" TIMESTAMP(3),
    "fetch_status" TEXT NOT NULL DEFAULT 'pending',
    "category" TEXT,
    "category_source" TEXT NOT NULL DEFAULT 'auto',
    "category_confidence" DECIMAL(65,30),
    "category_reasoning" TEXT,
    "categorized_at" TIMESTAMP(3),
    "pestel" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "pestel_source" TEXT NOT NULL DEFAULT 'auto',
    "tldr" TEXT,
    "tldr_source" TEXT NOT NULL DEFAULT 'auto',
    "tldr_generated_at" TIMESTAMP(3),
    "impact" TEXT,
    "impact_source" TEXT NOT NULL DEFAULT 'auto',
    "impact_generated_at" TIMESTAMP(3),
    "why_matters" TEXT,
    "why_matters_source" TEXT NOT NULL DEFAULT 'auto',
    "why_matters_generated_at" TIMESTAMP(3),
    "foresight" TEXT,
    "foresight_source" TEXT NOT NULL DEFAULT 'auto',
    "foresight_generated_at" TIMESTAMP(3),
    "enrich_discarded" BOOLEAN NOT NULL DEFAULT false,
    "publish_status" TEXT NOT NULL DEFAULT 'pending',
    "published_at" TIMESTAMP(3),
    "embedding" vector(1536),
    "embedding_hash" TEXT,
    "embedded_at" TIMESTAMP(3),
    "cluster_id" TEXT,
    "vitality" DOUBLE PRECISION,
    "vitality_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "liked_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "semantic_links" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "item_a_id" TEXT NOT NULL,
    "item_b_id" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "semantic_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "semantic_clusters" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "members_hash" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'alive',
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_signal_at" TIMESTAMP(3),
    "died_at" TIMESTAMP(3),
    "revived_count" INTEGER NOT NULL DEFAULT 0,
    "vitality" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "last_member_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "horizon" TEXT,
    "horizon_suggested" TEXT,
    "horizon_source" TEXT NOT NULL DEFAULT 'auto',
    "velocity_30d" INTEGER NOT NULL DEFAULT 0,
    "velocity_prev_30d" INTEGER NOT NULL DEFAULT 0,
    "density" DOUBLE PRECISION,
    "connectivity" DOUBLE PRECISION,
    "novelty" DOUBLE PRECISION,
    "bridge_clusters" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "semantic_clusters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "graph_snapshots" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "taken_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "trigger" TEXT NOT NULL,
    "nodes" INTEGER NOT NULL,
    "links" INTEGER NOT NULL,
    "clusters_alive" INTEGER NOT NULL,
    "clusters_dead" INTEGER NOT NULL,
    "orphans" INTEGER NOT NULL,

    CONSTRAINT "graph_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "graph_snapshot_clusters" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "snapshot_id" TEXT NOT NULL,
    "cluster_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "vitality" DOUBLE PRECISION NOT NULL,
    "velocity_30d" INTEGER NOT NULL,
    "density" DOUBLE PRECISION,
    "connectivity" DOUBLE PRECISION,
    "novelty" DOUBLE PRECISION,
    "horizon" TEXT,
    "horizon_suggested" TEXT,

    CONSTRAINT "graph_snapshot_clusters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "graph_snapshot_members" (
    "owner_id" TEXT NOT NULL,
    "snapshot_id" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "cluster_id" TEXT,
    "vitality" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "graph_snapshot_members_pkey" PRIMARY KEY ("snapshot_id","item_id")
);

-- CreateTable
CREATE TABLE "custom_field_definitions" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "field_key" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "custom_field_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "liked_item_custom_fields" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "liked_item_id" TEXT NOT NULL,
    "field_key" TEXT NOT NULL,
    "field_value" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "liked_item_custom_fields_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prompt_settings" (
    "owner_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "prompt_settings_pkey" PRIMARY KEY ("owner_id","key")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_key" ON "sessions"("token");

-- CreateIndex
CREATE INDEX "usage_events_user_id_created_at_idx" ON "usage_events"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "job_runs_owner_id_job_started_at_idx" ON "job_runs"("owner_id", "job", "started_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "x_auth_tokens_user_id_key" ON "x_auth_tokens"("user_id");

-- CreateIndex
CREATE INDEX "x_auth_tokens_x_user_id_idx" ON "x_auth_tokens"("x_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "ingestion_cursor_user_id_key" ON "ingestion_cursor"("user_id");

-- CreateIndex
CREATE INDEX "categories_owner_id_position_idx" ON "categories"("owner_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "categories_owner_id_name_key" ON "categories"("owner_id", "name");

-- CreateIndex
CREATE INDEX "liked_items_owner_id_liked_at_idx" ON "liked_items"("owner_id", "liked_at" DESC);

-- CreateIndex
CREATE INDEX "liked_items_owner_id_category_idx" ON "liked_items"("owner_id", "category");

-- CreateIndex
CREATE INDEX "liked_items_owner_id_fetch_status_idx" ON "liked_items"("owner_id", "fetch_status");

-- CreateIndex
CREATE INDEX "liked_items_owner_id_enrich_discarded_idx" ON "liked_items"("owner_id", "enrich_discarded");

-- CreateIndex
CREATE INDEX "liked_items_owner_id_publish_status_idx" ON "liked_items"("owner_id", "publish_status");

-- CreateIndex
CREATE INDEX "liked_items_cluster_id_idx" ON "liked_items"("cluster_id");

-- CreateIndex
CREATE UNIQUE INDEX "liked_items_owner_id_tweet_id_key" ON "liked_items"("owner_id", "tweet_id");

-- CreateIndex
CREATE INDEX "semantic_links_owner_id_idx" ON "semantic_links"("owner_id");

-- CreateIndex
CREATE INDEX "semantic_links_item_b_id_idx" ON "semantic_links"("item_b_id");

-- CreateIndex
CREATE UNIQUE INDEX "semantic_links_owner_id_item_a_id_item_b_id_key" ON "semantic_links"("owner_id", "item_a_id", "item_b_id");

-- CreateIndex
CREATE INDEX "semantic_clusters_owner_id_idx" ON "semantic_clusters"("owner_id");

-- CreateIndex
CREATE INDEX "semantic_clusters_owner_id_members_hash_idx" ON "semantic_clusters"("owner_id", "members_hash");

-- CreateIndex
CREATE INDEX "graph_snapshots_owner_id_taken_at_idx" ON "graph_snapshots"("owner_id", "taken_at" DESC);

-- CreateIndex
CREATE INDEX "graph_snapshot_clusters_owner_id_idx" ON "graph_snapshot_clusters"("owner_id");

-- CreateIndex
CREATE INDEX "graph_snapshot_clusters_cluster_id_idx" ON "graph_snapshot_clusters"("cluster_id");

-- CreateIndex
CREATE UNIQUE INDEX "graph_snapshot_clusters_snapshot_id_cluster_id_key" ON "graph_snapshot_clusters"("snapshot_id", "cluster_id");

-- CreateIndex
CREATE INDEX "graph_snapshot_members_owner_id_idx" ON "graph_snapshot_members"("owner_id");

-- CreateIndex
CREATE UNIQUE INDEX "custom_field_definitions_owner_id_field_key_key" ON "custom_field_definitions"("owner_id", "field_key");

-- CreateIndex
CREATE INDEX "liked_item_custom_fields_owner_id_idx" ON "liked_item_custom_fields"("owner_id");

-- CreateIndex
CREATE UNIQUE INDEX "liked_item_custom_fields_liked_item_id_field_key_key" ON "liked_item_custom_fields"("liked_item_id", "field_key");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_secrets" ADD CONSTRAINT "user_secrets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_quotas" ADD CONSTRAINT "user_quotas_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "x_auth_tokens" ADD CONSTRAINT "x_auth_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingestion_cursor" ADD CONSTRAINT "ingestion_cursor_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "liked_items" ADD CONSTRAINT "liked_items_cluster_id_fkey" FOREIGN KEY ("cluster_id") REFERENCES "semantic_clusters"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "liked_items" ADD CONSTRAINT "liked_items_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "semantic_links" ADD CONSTRAINT "semantic_links_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "semantic_links" ADD CONSTRAINT "semantic_links_item_a_id_fkey" FOREIGN KEY ("item_a_id") REFERENCES "liked_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "semantic_links" ADD CONSTRAINT "semantic_links_item_b_id_fkey" FOREIGN KEY ("item_b_id") REFERENCES "liked_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "semantic_clusters" ADD CONSTRAINT "semantic_clusters_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "graph_snapshots" ADD CONSTRAINT "graph_snapshots_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "graph_snapshot_clusters" ADD CONSTRAINT "graph_snapshot_clusters_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "graph_snapshot_clusters" ADD CONSTRAINT "graph_snapshot_clusters_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "graph_snapshots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "graph_snapshot_clusters" ADD CONSTRAINT "graph_snapshot_clusters_cluster_id_fkey" FOREIGN KEY ("cluster_id") REFERENCES "semantic_clusters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "graph_snapshot_members" ADD CONSTRAINT "graph_snapshot_members_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "graph_snapshot_members" ADD CONSTRAINT "graph_snapshot_members_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "graph_snapshots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_field_definitions" ADD CONSTRAINT "custom_field_definitions_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "liked_item_custom_fields" ADD CONSTRAINT "liked_item_custom_fields_liked_item_id_fkey" FOREIGN KEY ("liked_item_id") REFERENCES "liked_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "liked_item_custom_fields" ADD CONSTRAINT "liked_item_custom_fields_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompt_settings" ADD CONSTRAINT "prompt_settings_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
