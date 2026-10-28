-- FP-021: Jobs Lease Fencing & Dead-Letter Queue
-- Prevent stale workers from confirming someone else's lease
-- Add version tracking for lease fencing
-- Add jitter for retry backoff

-- FP-021: Add lease version to prevent stale worker confirmation
ALTER TABLE "jobs"
ADD COLUMN "lease_version" INTEGER DEFAULT 1,
ADD COLUMN "fenced_at" TIMESTAMP; -- when lease was fenced/recovered

-- FP-021: Add fencing marker (worker_id that claimed this lease)
ALTER TABLE "jobs"
ADD COLUMN "lease_worker_id" TEXT; -- which worker owns this lease

-- FP-021: Ensure lease cannot be updated without matching version
-- Worker must check: (lease_owner = ? AND lease_version = ?) before confirming
CREATE UNIQUE INDEX "jobs_lease_claim_idx" ON "jobs"("id", "lease_worker_id", "lease_version") 
WHERE status = 'started' AND lease_until > CURRENT_TIMESTAMP;

-- FP-021: Dead-letter queue index (jobs that exceeded max_attempts)
CREATE INDEX "jobs_dead_letter_queue_idx" ON "jobs"("status", "attempt", "max_attempts")
WHERE status = 'dead' OR (attempt >= max_attempts AND status = 'failed');

-- FP-021: Retry backoff calculation
-- next_run_at = now() + (5s * 2^attempt) + jitter(0-10% of backoff)
-- Jitter = RANDOM() * 0.1 * backoff_seconds
CREATE INDEX "jobs_next_run_jitter_idx" ON "jobs"("next_run_at", "attempt")
WHERE status IN ('failed', 'pending') AND attempt < max_attempts;

-- FP-021: Prevent stale worker confirmation
-- Only worker that claimed lease can complete/fail it
CREATE TRIGGER "jobs_fence_stale_worker" BEFORE UPDATE ON "jobs"
BEGIN
  SELECT RAISE(ABORT, 'Lease fenced: stale worker cannot confirm')
  WHERE NEW.status IN ('completed', 'failed')
    AND OLD.status = 'started'
    AND (OLD.lease_worker_id IS NOT NULL AND OLD.lease_worker_id != NEW.lease_worker_id);
END;

-- FP-021: Auto-recovery of stale leases
-- Mark as 'unknown' if lease_until has passed (will be retried)
CREATE TRIGGER "jobs_recover_expired_lease" BEFORE SELECT ON "jobs"
BEGIN
  UPDATE "jobs" 
  SET status = 'pending',
      lease_until = NULL,
      lease_worker_id = NULL,
      lease_version = lease_version + 1,
      fenced_at = CURRENT_TIMESTAMP,
      next_run_at = DATETIME('now', '+' || (5 * POW(2, attempt)) || ' seconds')
  WHERE status = 'started' 
    AND lease_until IS NOT NULL 
    AND lease_until <= CURRENT_TIMESTAMP;
END;

-- FP-021: Dead-letter queue operations
-- Move job to 'dead' after max_attempts
ALTER TABLE "jobs"
ADD COLUMN "dead_letter_reason" TEXT; -- why job was moved to DLQ

-- FP-021: Index for monitoring
CREATE INDEX "jobs_status_created_idx" ON "jobs"("status", "created_at");
CREATE INDEX "jobs_tenant_status_idx" ON "jobs"("tenant_id", "status");
