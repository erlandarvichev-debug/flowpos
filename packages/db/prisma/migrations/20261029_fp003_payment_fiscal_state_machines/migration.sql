-- FP-003: Durable Payment and Fiscal State Machines
-- Payment attempt states: CREATED → PENDING → CONFIRMED | REJECTED | UNKNOWN
-- Fiscal attempt states: CREATED → SENT → REGISTERED | FAILED | UNKNOWN
-- Each state can survive process restart; UNKNOWN is stable (no auto-resend)

-- FP-003: Payment attempt with independent state machine
CREATE TABLE IF NOT EXISTS "payment_attempts" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "sale_id" TEXT NOT NULL,
  "payment_id" TEXT NOT NULL,
  
  "status" TEXT NOT NULL DEFAULT 'CREATED', -- CREATED, PENDING, CONFIRMED, REJECTED, UNKNOWN, RECONCILING
  "amount" INTEGER NOT NULL, -- in minor units
  "payment_method" TEXT NOT NULL, -- CASH, CARD, QR, MIXED
  
  -- External provider state tracking
  "provider_id" TEXT, -- payment gateway identifier
  "provider_status" TEXT, -- raw status from provider (for reconciliation)
  
  -- Timeout and retry tracking
  "timeout_at" TIMESTAMP, -- when payment was last sent (timeout calc = now - timeout_at)
  "last_attempt_at" TIMESTAMP,
  "retry_count" INTEGER NOT NULL DEFAULT 0,
  "max_retries" INTEGER NOT NULL DEFAULT 3,
  
  -- Error tracking
  "error_code" TEXT,
  "error_message" TEXT,
  
  -- Durability markers
  "confirmed_at" TIMESTAMP,
  "created_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  
  CONSTRAINT "payment_attempts_sale_fk" FOREIGN KEY ("sale_id") REFERENCES "pos_sales"("id") ON DELETE CASCADE
);

CREATE INDEX "payment_attempts_sale_idx" ON "payment_attempts"("sale_id");
CREATE INDEX "payment_attempts_status_idx" ON "payment_attempts"("status");
CREATE INDEX "payment_attempts_timeout_idx" ON "payment_attempts"("timeout_at");

-- FP-003: Fiscal attempt with independent state machine
CREATE TABLE IF NOT EXISTS "fiscal_attempts" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "sale_id" TEXT NOT NULL,
  "receipt_number" TEXT NOT NULL,
  "payload_hash" TEXT NOT NULL,
  
  "status" TEXT NOT NULL DEFAULT 'CREATED', -- CREATED, SENT, REGISTERED, FAILED, UNKNOWN
  "fiscal_number" TEXT,
  "fiscal_date" TIMESTAMP,
  
  -- Fiscal printer state
  "printer_id" TEXT,
  "printer_status" TEXT, -- raw printer response
  
  -- Timeout and retry tracking
  "timeout_at" TIMESTAMP, -- when fiscal request was sent
  "last_attempt_at" TIMESTAMP,
  "retry_count" INTEGER NOT NULL DEFAULT 0,
  "max_retries" INTEGER NOT NULL DEFAULT 3,
  
  -- Error tracking
  "error_code" TEXT,
  "error_message" TEXT,
  
  -- Durability markers
  "registered_at" TIMESTAMP,
  "created_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  
  CONSTRAINT "fiscal_attempts_sale_fk" FOREIGN KEY ("sale_id") REFERENCES "pos_sales"("id") ON DELETE CASCADE
);

CREATE INDEX "fiscal_attempts_sale_idx" ON "fiscal_attempts"("sale_id");
CREATE INDEX "fiscal_attempts_status_idx" ON "fiscal_attempts"("status");
CREATE INDEX "fiscal_attempts_timeout_idx" ON "fiscal_attempts"("timeout_at");

-- FP-003: Reconciliation tracking (for provider status lookup)
CREATE TABLE IF NOT EXISTS "payment_reconciliations" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "payment_attempt_id" TEXT NOT NULL,
  
  "last_lookup_at" TIMESTAMP,
  "last_known_status" TEXT,
  "last_known_provider_status" TEXT,
  
  "updated_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  
  CONSTRAINT "payment_reconciliations_attempt_fk" FOREIGN KEY ("payment_attempt_id") REFERENCES "payment_attempts"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "payment_reconciliations_attempt_idx" ON "payment_reconciliations"("payment_attempt_id");

-- FP-003: Fiscal reconciliation tracking
CREATE TABLE IF NOT EXISTS "fiscal_reconciliations" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "fiscal_attempt_id" TEXT NOT NULL,
  
  "last_lookup_at" TIMESTAMP,
  "last_known_status" TEXT,
  "last_known_fiscal_number" TEXT,
  
  "updated_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  
  CONSTRAINT "fiscal_reconciliations_attempt_fk" FOREIGN KEY ("fiscal_attempt_id") REFERENCES "fiscal_attempts"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "fiscal_reconciliations_attempt_idx" ON "fiscal_reconciliations"("fiscal_attempt_id");

-- FP-003: Update pos_sales to link payment/fiscal attempts
ALTER TABLE "pos_sales" 
ADD COLUMN "payment_status" TEXT DEFAULT 'PENDING', -- PENDING, CONFIRMED, FAILED, UNKNOWN
ADD COLUMN "fiscal_status" TEXT DEFAULT 'PENDING'; -- PENDING, REGISTERED, FAILED, UNKNOWN

-- FP-003: Payment timeout detector — ensures UNKNOWN survives restart
-- Query: WHERE status != 'CONFIRMED' AND timeout_at < now() - interval AND status != 'UNKNOWN'
-- Result: mark as UNKNOWN, skip auto-resend
CREATE INDEX "payment_attempts_unresolved_timeout" ON "payment_attempts"("timeout_at") WHERE status NOT IN ('CONFIRMED', 'UNKNOWN');

-- FP-003: Fiscal timeout detector
CREATE INDEX "fiscal_attempts_unresolved_timeout" ON "fiscal_attempts"("timeout_at") WHERE status NOT IN ('REGISTERED', 'UNKNOWN');

-- FP-003: Update recovery_jobs table to mark COMPLETED only when BOTH payment+fiscal done
-- Logic: recovery_job.status can be:
-- - PENDING_PAYMENT: waiting for payment response
-- - PAYMENT_CONFIRMED: move to fiscal
-- - PENDING_FISCAL: waiting for fiscal response
-- - COMPLETED: both done
-- - DEAD: max retries exceeded

ALTER TABLE "recovery_jobs"
ADD COLUMN "payment_attempt_id" TEXT REFERENCES "payment_attempts"("id"),
ADD COLUMN "fiscal_attempt_id" TEXT REFERENCES "fiscal_attempts"("id");

-- Immutability triggers for FP-003
CREATE TRIGGER "payment_attempts_status_immutable_after_confirm" BEFORE UPDATE ON "payment_attempts"
BEGIN
  SELECT RAISE(ABORT, 'payment status cannot change after confirmed')
  WHERE OLD.status = 'CONFIRMED' AND NEW.status != OLD.status;
END;

CREATE TRIGGER "fiscal_attempts_status_immutable_after_register" BEFORE UPDATE ON "fiscal_attempts"
BEGIN
  SELECT RAISE(ABORT, 'fiscal status cannot change after registered')
  WHERE OLD.status = 'REGISTERED' AND NEW.status != OLD.status;
END;

-- FP-003: Ensure UNKNOWN is a stable terminal state (prevents blind retry)
CREATE TRIGGER "payment_attempts_unknown_is_terminal" BEFORE UPDATE ON "payment_attempts"
BEGIN
  SELECT RAISE(ABORT, 'UNKNOWN payment requires manual reconciliation, not auto-resend')
  WHERE OLD.status = 'UNKNOWN' AND NEW.status = 'PENDING';
END;

CREATE TRIGGER "fiscal_attempts_unknown_is_terminal" BEFORE UPDATE ON "fiscal_attempts"
BEGIN
  SELECT RAISE(ABORT, 'UNKNOWN fiscal requires manual reconciliation, not auto-resend')
  WHERE OLD.status = 'UNKNOWN' AND NEW.status = 'SENT';
END;
