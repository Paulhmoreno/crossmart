-- Additive migration for Sales Agent consolidation:
-- channel context on sales_conversations, commercial knowledge base,
-- supervised learning proposals, and real commercial events.

ALTER TABLE "sales_conversations"
  ADD COLUMN IF NOT EXISTS "channel_type" TEXT,
  ADD COLUMN IF NOT EXISTS "inbox_id" INTEGER,
  ADD COLUMN IF NOT EXISTS "inbox_name" TEXT,
  ADD COLUMN IF NOT EXISTS "contact_name" TEXT,
  ADD COLUMN IF NOT EXISTS "context" JSONB NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS "sales_conversations_workspace_id_source_updated_at_idx"
  ON "sales_conversations"("workspace_id", "source", "updated_at" DESC);

DO $$ BEGIN
  CREATE TYPE "sales_knowledge_status" AS ENUM ('ACTIVE', 'ARCHIVED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "sales_learning_status" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "sales_knowledge_entries" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "category" TEXT NOT NULL,
  "scope" TEXT NOT NULL DEFAULT 'global',
  "title" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "status" "sales_knowledge_status" NOT NULL DEFAULT 'ACTIVE',
  "source" TEXT NOT NULL DEFAULT 'supervisor',
  "version" INTEGER NOT NULL DEFAULT 1,
  "approved_by_id" UUID,
  "approved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "sales_knowledge_entries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sales_knowledge_entries_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "sales_knowledge_entries_workspace_id_status_scope_idx"
  ON "sales_knowledge_entries"("workspace_id", "status", "scope");

CREATE TABLE IF NOT EXISTS "sales_learning_proposals" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "category" TEXT NOT NULL,
  "scope" TEXT NOT NULL DEFAULT 'global',
  "title" TEXT NOT NULL,
  "proposed_content" TEXT NOT NULL,
  "rationale" TEXT,
  "origin_type" TEXT NOT NULL DEFAULT 'supervisor_chat',
  "origin_conversation_id" UUID,
  "origin_message_id" UUID,
  "target_entry_id" UUID,
  "status" "sales_learning_status" NOT NULL DEFAULT 'PENDING',
  "reviewed_by_id" UUID,
  "reviewed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "sales_learning_proposals_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sales_learning_proposals_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "sales_learning_proposals_workspace_id_status_created_at_idx"
  ON "sales_learning_proposals"("workspace_id", "status", "created_at" DESC);

CREATE TABLE IF NOT EXISTS "sales_events" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "type" TEXT NOT NULL,
  "channel_type" TEXT,
  "conversation_id" UUID,
  "summary" TEXT NOT NULL,
  "details" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sales_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sales_events_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "sales_events_workspace_id_created_at_idx"
  ON "sales_events"("workspace_id", "created_at" DESC);
