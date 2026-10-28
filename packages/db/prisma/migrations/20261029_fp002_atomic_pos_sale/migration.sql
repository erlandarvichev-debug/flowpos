-- FP-002: Atomic POS Sale Intent with Durable Recovery
-- SQLite: one transaction per sale
-- Idempotent: operation_id + payload_hash = unique sale

CREATE TABLE IF NOT EXISTS "pos_sales" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "operation_id" TEXT NOT NULL,
  "device_id" TEXT NOT NULL,
  "terminal_id" TEXT,
  "shift_id" TEXT,

  "sale_number" TEXT NOT NULL,
  "sale_date" TIMESTAMP NOT NULL,
  "total_amount" INTEGER NOT NULL, -- in minor units (cents)

  "payload_hash" TEXT NOT NULL, -- SHA256 for idempotency
  "status" TEXT NOT NULL DEFAULT 'DRAFT', -- DRAFT, POSTED, RETURNED, VOID

  "fiscal_number" TEXT,
  "fiscal_date" TIMESTAMP,

  "created_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  UNIQUE("operation_id") -- FP-002: One sale per operation
);

CREATE INDEX "pos_sales_device_terminal_idx" ON "pos_sales"("device_id", "terminal_id");
CREATE INDEX "pos_sales_shift_idx" ON "pos_sales"("shift_id");
CREATE INDEX "pos_sales_created_idx" ON "pos_sales"("created_at");

-- FP-002: Receipt lines (immutable snapshot)
CREATE TABLE IF NOT EXISTS "pos_receipt_lines" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "sale_id" TEXT NOT NULL,
  "product_id" TEXT NOT NULL,
  "qty" REAL NOT NULL,
  "unit_price" INTEGER NOT NULL, -- in minor units
  "discount" INTEGER NOT NULL DEFAULT 0,
  "vat_rate" INTEGER,
  "line_total" INTEGER NOT NULL,
  "sequence" INTEGER NOT NULL,

  CONSTRAINT "pos_receipt_lines_sale_fk" FOREIGN KEY ("sale_id") REFERENCES "pos_sales"("id")
);

CREATE INDEX "pos_receipt_lines_sale_idx" ON "pos_receipt_lines"("sale_id");

-- FP-002: Payment attempts (retry tracking)
CREATE TABLE IF NOT EXISTS "pos_payments" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "sale_id" TEXT NOT NULL,
  "payment_id" TEXT NOT NULL, -- external provider ID (idempotency key)
  "type" TEXT NOT NULL, -- CASH, CARD, QR, MIXED
  "amount" INTEGER NOT NULL,
  "status" TEXT NOT NULL, -- CREATED, PENDING, CONFIRMED, REJECTED, UNKNOWN

  "created_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "confirmed_at" TIMESTAMP,
  "error" TEXT,

  UNIQUE("payment_id"), -- FP-002: idempotent payment processing
  CONSTRAINT "pos_payments_sale_fk" FOREIGN KEY ("sale_id") REFERENCES "pos_sales"("id")
);

CREATE INDEX "pos_payments_sale_idx" ON "pos_payments"("sale_id");
CREATE INDEX "pos_payments_status_idx" ON "pos_payments"("status");

-- FP-002: Recovery jobs (before external effects)
CREATE TABLE IF NOT EXISTS "recovery_jobs" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "sale_id" TEXT NOT NULL,
  "status" TEXT NOT NULL, -- PENDING_PAYMENT, PENDING_FISCAL, COMPLETED, DEAD
  "retry_count" INTEGER NOT NULL DEFAULT 0,
  "max_retries" INTEGER NOT NULL DEFAULT 3,
  "next_retry_at" TIMESTAMP NOT NULL,
  "last_error" TEXT,

  "created_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMP,

  CONSTRAINT "recovery_jobs_sale_fk" FOREIGN KEY ("sale_id") REFERENCES "pos_sales"("id")
);

CREATE INDEX "recovery_jobs_status_idx" ON "recovery_jobs"("status");
CREATE INDEX "recovery_jobs_next_retry_idx" ON "recovery_jobs"("next_retry_at");

-- FP-002: Fiscal attempts (external effect tracking)
CREATE TABLE IF NOT EXISTS "fiscal_attempts" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "sale_id" TEXT NOT NULL,
  "receipt_number" TEXT NOT NULL,
  "payload_hash" TEXT NOT NULL,
  "status" TEXT NOT NULL, -- CREATED, SENT, REGISTERED, FAILED

  "fiscal_number" TEXT,
  "fiscal_date" TIMESTAMP,
  "error" TEXT,

  "attempt" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMP,

  CONSTRAINT "fiscal_attempts_sale_fk" FOREIGN KEY ("sale_id") REFERENCES "pos_sales"("id")
);

CREATE INDEX "fiscal_attempts_sale_idx" ON "fiscal_attempts"("sale_id");
CREATE INDEX "fiscal_attempts_status_idx" ON "fiscal_attempts"("status");

-- FP-002: Ensure operation_id is immutable (prevent bugs)
CREATE TRIGGER "pos_sales_operation_id_immutable" BEFORE UPDATE ON "pos_sales"
BEGIN
  SELECT RAISE(ABORT, 'operation_id cannot be changed')
  WHERE NEW.operation_id != OLD.operation_id;
END;

-- FP-002: Ensure payload_hash is immutable
CREATE TRIGGER "pos_sales_payload_hash_immutable" BEFORE UPDATE ON "pos_sales"
BEGIN
  SELECT RAISE(ABORT, 'payload_hash cannot be changed')
  WHERE NEW.payload_hash != OLD.payload_hash;
END;
