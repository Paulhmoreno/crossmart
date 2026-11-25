-- CreateEnum
CREATE TYPE "ai_config_status" AS ENUM ('CONNECTED', 'ERROR', 'DISABLED');

-- CreateTable
CREATE TABLE "workspace_ai_configs" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "base_url" TEXT,
    "model" TEXT NOT NULL,
    "sealed_credentials" TEXT,
    "status" "ai_config_status" NOT NULL DEFAULT 'CONNECTED',
    "capabilities" JSONB NOT NULL DEFAULT '{}',
    "last_error" TEXT,
    "last_tested_at" TIMESTAMP(3),
    "updated_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_ai_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workspace_ai_configs_workspace_id_key" ON "workspace_ai_configs"("workspace_id");

-- AddForeignKey
ALTER TABLE "workspace_ai_configs" ADD CONSTRAINT "workspace_ai_configs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_ai_configs" ADD CONSTRAINT "workspace_ai_configs_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
