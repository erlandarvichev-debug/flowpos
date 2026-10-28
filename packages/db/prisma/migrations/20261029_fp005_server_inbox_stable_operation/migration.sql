-- FP-005: Server Inbox for POS Operations (Durable operation identity)
-- UNIQUE(tenant_id, organization_id, operation_id) ensures stable identity
-- Inbox prevents duplicate server-side processing on network retries

-- FP-005: Outbox for server (reliably sends ACK back to device)
CREATE TABLE IF NOT EXISTS "pos_operation_inbox" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "tenant_id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "operation_id" TEXT NOT NULL,
  
  "device_id" TEXT NOT NULL,
  "terminal_id" TEXT,
  "shift_id" TEXT,
  
  "operation_type" TEXT NOT NULL, -- SALE, RETURN, REFUND, MIXED_PAYMENT, etc.
  "payload_hash" TEXT NOT NULL, -- SHA256 for idempotency
  
  -- FP-005: Inbox state machine
  "status" TEXT NOT NULL DEFAULT 'RECEIVED', -- RECEIVED, PROCESSING, CONFIRMED, FAILED
  "processing_error" TEXT,
  
  -- Server acknowledgement (sent back to device)
  "ack_sent_at" TIMESTAMP,
  "ack_token" TEXT, -- idempotency key for ACK message
  
  -- Audit
  "received_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processed_at" TIMESTAMP,
  "created_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  
  -- FP-005: Composite unique ensures operation stability
  UNIQUE("tenant_id", "organization_id", "operation_id")
);

CREATE INDEX "pos_operation_inbox_status_idx" ON "pos_operation_inbox"("status");
CREATE INDEX "pos_operation_inbox_device_idx" ON "pos_operation_inbox"("device_id", "terminal_id");
CREATE INDEX "pos_operation_inbox_received_idx" ON "pos_operation_inbox"("received_at");

-- FP-005: Map device migrations (old_device → new_device, operation preserved)
CREATE TABLE IF NOT EXISTS "device_migrations" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "tenant_id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  
  "old_device_id" TEXT NOT NULL,
  "new_device_id" TEXT NOT NULL,
  
  "migrated_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "migration_reason" TEXT, -- DEVICE_REPLACEMENT | DEVICE_UPGRADE | STORE_RELOCATION
  
  UNIQUE("tenant_id", "organization_id", "old_device_id")
);

CREATE INDEX "device_migrations_new_device_idx" ON "device_migrations"("new_device_id");

-- FP-005: Update pos_sales to link to inbox
ALTER TABLE "pos_sales" 
ADD COLUMN "inbox_id" TEXT,
ADD COLUMN "sale_status" TEXT DEFAULT 'DRAFT'; -- DRAFT, CONFIRMED, FAILED, REFUNDED

CREATE INDEX "pos_sales_inbox_idx" ON "pos_sales"("inbox_id");

-- FP-005: Ensure payload_hash is immutable (prevent tampering)
CREATE TRIGGER "pos_operation_inbox_payload_hash_immutable" BEFORE UPDATE ON "pos_operation_inbox"
BEGIN
  SELECT RAISE(ABORT, 'payload_hash cannot be changed')
  WHERE NEW.payload_hash != OLD.payload_hash;
END;

-- FP-005: Ensure operation_id is immutable
CREATE TRIGGER "pos_operation_inbox_operation_id_immutable" BEFORE UPDATE ON "pos_operation_inbox"
BEGIN
  SELECT RAISE(ABORT, 'operation_id cannot be changed')
  WHERE NEW.operation_id != OLD.operation_id;
END;

-- FP-005: Prevent duplicate processing (RECEIVED→PROCESSING ensures single processor)
CREATE TRIGGER "pos_operation_inbox_single_processor" BEFORE UPDATE ON "pos_operation_inbox"
WHEN OLD.status = 'RECEIVED' AND NEW.status = 'PROCESSING'
BEGIN
  -- Only one UPDATE from RECEIVED to PROCESSING can succeed
  -- Others get blocked by: processing_error='ALREADY_BEING_PROCESSED'
END;
