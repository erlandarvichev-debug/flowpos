-- FP-004: Canonical Backoffice Provider System
-- Adds backoffice_system column for provider selection
-- Supports: internal (default), onec, moysklad, future providers

ALTER TABLE "organizations"
ADD COLUMN "backoffice_system" TEXT NOT NULL DEFAULT 'internal';

-- Create index for provider selection queries
CREATE INDEX "organizations_backoffice_system_idx" ON "organizations"("backoffice_system");

-- FP-004: IdMap table for legacy system ID mappings
-- Keeps oneCGUID, accountHref, etc. separate from domain
CREATE TABLE IF NOT EXISTS "id_maps" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "entity" TEXT NOT NULL,
  "connection_id" TEXT NOT NULL,
  "local_id" TEXT NOT NULL,
  "external_id" TEXT NOT NULL,
  "onec_guid" TEXT,
  "mapped_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "synced_at" TIMESTAMP
);

CREATE UNIQUE INDEX "id_maps_entity_connection_external_idx" ON "id_maps"("entity", "connection_id", "external_id");
CREATE INDEX "id_maps_local_id_idx" ON "id_maps"("local_id");
CREATE INDEX "id_maps_entity_idx" ON "id_maps"("entity");
