-- Segundo nivel de agrupación de temas del grafo: MacroCluster (PLAN Horizontes).

-- AlterTable
ALTER TABLE "semantic_clusters" ADD COLUMN     "macro_cluster_id" TEXT;

-- CreateTable
CREATE TABLE "macro_clusters" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "horizon" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "macro_clusters_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "macro_clusters_owner_id_idx" ON "macro_clusters"("owner_id");

-- CreateIndex
CREATE INDEX "semantic_clusters_macro_cluster_id_idx" ON "semantic_clusters"("macro_cluster_id");

-- AddForeignKey
ALTER TABLE "semantic_clusters" ADD CONSTRAINT "semantic_clusters_macro_cluster_id_fkey" FOREIGN KEY ("macro_cluster_id") REFERENCES "macro_clusters"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "macro_clusters" ADD CONSTRAINT "macro_clusters_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS: mismo patrón que la migración `_rls` original, para la tabla nueva.
ALTER TABLE "macro_clusters" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "macro_clusters" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "macro_clusters"
  USING (
    "owner_id" = current_setting('app.owner_id', true)
    OR current_setting('app.bypass_rls', true) = 'on'
  )
  WITH CHECK (
    "owner_id" = current_setting('app.owner_id', true)
    OR current_setting('app.bypass_rls', true) = 'on'
  );
