-- CreateEnum
CREATE TYPE "catalog_source_kind" AS ENUM ('MANUAL', 'ODOO');

-- CreateEnum
CREATE TYPE "product_document_kind" AS ENUM ('DATASHEET', 'MANUAL', 'INTERNAL', 'OTHER');

-- CreateEnum
CREATE TYPE "odoo_connection_status" AS ENUM ('CONNECTED', 'ERROR', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "odoo_sync_run_status" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "odoo_sync_mode" AS ENUM ('SELECTED', 'FULL');

-- AlterTable
ALTER TABLE "product_media" ADD COLUMN     "source_key" TEXT,
ADD COLUMN     "source_managed" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "source_connection_id" UUID,
ADD COLUMN     "source_external_id" TEXT,
ADD COLUMN     "source_kind" "catalog_source_kind" NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "source_metadata" JSONB;

-- AlterTable
ALTER TABLE "variants" ADD COLUMN     "source_external_id" TEXT;

-- CreateTable
CREATE TABLE "product_documents" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "source_external_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mimetype" TEXT NOT NULL,
    "byte_size" INTEGER,
    "kind" "product_document_kind" NOT NULL DEFAULT 'INTERNAL',
    "is_public" BOOLEAN NOT NULL DEFAULT false,
    "storage_key" TEXT,
    "checksum" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "odoo_connections" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "display_name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "database" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "sealed_credentials" TEXT,
    "status" "odoo_connection_status" NOT NULL DEFAULT 'CONNECTED',
    "status_reason" TEXT,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "connected_by_id" UUID,
    "connected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disconnected_at" TIMESTAMP(3),
    "last_tested_at" TIMESTAMP(3),
    "last_synced_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "odoo_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "odoo_sync_runs" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "mode" "odoo_sync_mode" NOT NULL DEFAULT 'SELECTED',
    "status" "odoo_sync_run_status" NOT NULL DEFAULT 'QUEUED',
    "filter" JSONB NOT NULL DEFAULT '{}',
    "total_count" INTEGER NOT NULL DEFAULT 0,
    "processed_count" INTEGER NOT NULL DEFAULT 0,
    "created_count" INTEGER NOT NULL DEFAULT 0,
    "updated_count" INTEGER NOT NULL DEFAULT 0,
    "skipped_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "error_message" TEXT,
    "issues" JSONB NOT NULL DEFAULT '[]',
    "actor_user_id" UUID,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "odoo_sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_documents_workspace_id_product_id_idx" ON "product_documents"("workspace_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_documents_product_id_source_external_id_key" ON "product_documents"("product_id", "source_external_id");

-- CreateIndex
CREATE UNIQUE INDEX "odoo_connections_workspace_id_key" ON "odoo_connections"("workspace_id");

-- CreateIndex
CREATE INDEX "odoo_sync_runs_workspace_id_created_at_idx" ON "odoo_sync_runs"("workspace_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "odoo_sync_runs_connection_id_created_at_idx" ON "odoo_sync_runs"("connection_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "products_workspace_id_source_kind_idx" ON "products"("workspace_id", "source_kind");

-- CreateIndex
CREATE UNIQUE INDEX "products_source_connection_id_source_external_id_key" ON "products"("source_connection_id", "source_external_id");

-- CreateIndex
CREATE UNIQUE INDEX "variants_product_id_source_external_id_key" ON "variants"("product_id", "source_external_id");

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_source_connection_id_fkey" FOREIGN KEY ("source_connection_id") REFERENCES "odoo_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_documents" ADD CONSTRAINT "product_documents_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "odoo_connections" ADD CONSTRAINT "odoo_connections_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "odoo_connections" ADD CONSTRAINT "odoo_connections_connected_by_id_fkey" FOREIGN KEY ("connected_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "odoo_sync_runs" ADD CONSTRAINT "odoo_sync_runs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "odoo_sync_runs" ADD CONSTRAINT "odoo_sync_runs_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "odoo_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "odoo_sync_runs" ADD CONSTRAINT "odoo_sync_runs_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

