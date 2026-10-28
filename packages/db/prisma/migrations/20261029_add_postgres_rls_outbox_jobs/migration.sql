-- FP-009: PostgreSQL Row-Level Security (RLS) + Outbox + Jobs
-- Requires: PostgreSQL 12+

-- ─── ENABLE RLS ───────────────────────────────────────────────────────────────

-- Create a system user for apps (no login, for audit trail)
CREATE ROLE "flowpos_app" NOLOGIN;

-- FP-009: Enable RLS on tenant-scoped tables
ALTER TABLE "organizations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "grants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "documents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;

-- FP-009: RLS Policy for Organizations (tenant isolation)
CREATE POLICY "organizations_tenant_isolation" ON "organizations"
  AS PERMISSIVE FOR ALL
  USING (tenant_id = current_setting('app.tenant_id')::text);

-- FP-009: RLS Policy for Users (tenant isolation)
CREATE POLICY "users_tenant_isolation" ON "users"
  AS PERMISSIVE FOR ALL
  USING (tenant_id = current_setting('app.tenant_id')::text);

-- FP-009: RLS Policy for Grants (tenant + org isolation)
CREATE POLICY "grants_tenant_isolation" ON "grants"
  AS PERMISSIVE FOR ALL
  USING (
    tenant_id = current_setting('app.tenant_id')::text
    AND organization_id = current_setting('app.organization_id')::text
  );

-- FP-009: RLS Policy for Documents (tenant isolation)
CREATE POLICY "documents_tenant_isolation" ON "documents"
  AS PERMISSIVE FOR ALL
  USING (tenant_id = current_setting('app.tenant_id')::text);

-- FP-009: RLS Policy for AuditLog (tenant isolation)
CREATE POLICY "audit_log_tenant_isolation" ON "audit_log"
  AS PERMISSIVE FOR ALL
  USING (tenant_id = current_setting('app.tenant_id')::text);

-- ─── OUTBOX PATTERN (Event Sourcing) ──────────────────────────────────────────

CREATE TABLE "outbox" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "tenant_id" TEXT NOT NULL,
  "organization_id" TEXT,
  "aggregate_type" TEXT NOT NULL, -- e.g., "Document", "User"
  "aggregate_id" TEXT NOT NULL,
  "event_type" TEXT NOT NULL, -- e.g., "DocumentCreated", "DocumentApproved"
  "data" JSONB NOT NULL,
  "metadata" JSONB,
  "version" BIGINT NOT NULL DEFAULT 1,
  "published" BOOLEAN NOT NULL DEFAULT false,
  "published_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "outbox_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE
);

CREATE INDEX "outbox_tenant_published_idx" ON "outbox"("tenant_id", "published");
CREATE INDEX "outbox_aggregate_idx" ON "outbox"("aggregate_type", "aggregate_id");
CREATE INDEX "outbox_created_idx" ON "outbox"("created_at");

-- FP-009: RLS on outbox
ALTER TABLE "outbox" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "outbox_tenant_isolation" ON "outbox"
  AS PERMISSIVE FOR ALL
  USING (tenant_id = current_setting('app.tenant_id')::text);

-- ─── JOBS SCHEDULER (Durable Task Queue) ──────────────────────────────────────

CREATE TABLE "jobs" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "tenant_id" TEXT NOT NULL,
  "name" TEXT NOT NULL, -- e.g., "send_esf", "sync_moysklad"
  "status" TEXT NOT NULL DEFAULT 'pending', -- pending, started, completed, failed, dead
  "data" JSONB NOT NULL,
  "result" JSONB,
  "error" TEXT,

  "lease_until" TIMESTAMP(3),
  "lease_owner" TEXT, -- worker ID or NULL if not leased
  "attempt" INTEGER NOT NULL DEFAULT 0,
  "max_attempts" INTEGER NOT NULL DEFAULT 3,

  "next_run_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "started_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "jobs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE
);

CREATE INDEX "jobs_tenant_status_idx" ON "jobs"("tenant_id", "status");
CREATE INDEX "jobs_next_run_idx" ON "jobs"("next_run_at") WHERE status = 'pending';
CREATE INDEX "jobs_lease_idx" ON "jobs"("lease_until") WHERE lease_owner IS NOT NULL;

-- FP-009: RLS on jobs
ALTER TABLE "jobs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "jobs_tenant_isolation" ON "jobs"
  AS PERMISSIVE FOR ALL
  USING (tenant_id = current_setting('app.tenant_id')::text);

-- ─── COMMAND FUNCTIONS (Server-side validation) ───────────────────────────────

-- FP-009: Create document with outbox event
CREATE OR REPLACE FUNCTION create_document(
  p_tenant_id TEXT,
  p_organization_id TEXT,
  p_doc_type TEXT,
  p_doc_date TIMESTAMP,
  p_data JSONB,
  p_expected_version INTEGER DEFAULT 1
) RETURNS TABLE (document_id TEXT, event_id TEXT) AS $$
BEGIN
  -- FP-009: Verify tenant context
  IF current_setting('app.tenant_id')::text != p_tenant_id THEN
    RAISE EXCEPTION 'Tenant mismatch';
  END IF;

  -- FP-009: Check grant (user has 'draft' action)
  IF NOT EXISTS (
    SELECT 1 FROM grants g
    WHERE g.tenant_id = p_tenant_id
    AND g.organization_id = p_organization_id
    AND g.user_id = current_setting('app.user_id')::text
    AND g.action = 'draft'
  ) THEN
    RAISE EXCEPTION 'No draft permission';
  END IF;

  -- FP-009: Insert document and outbox event atomically
  WITH doc_insert AS (
    INSERT INTO documents (
      id, tenant_id, doc_type, date, organization_id, status, created_at, updated_at
    ) VALUES (
      gen_random_uuid()::text, p_tenant_id, p_doc_type, p_doc_date, p_organization_id, 'DRAFT', NOW(), NOW()
    )
    RETURNING id
  )
  INSERT INTO outbox (
    id, tenant_id, organization_id, aggregate_type, aggregate_id, event_type, data, created_at
  )
  SELECT
    gen_random_uuid()::text,
    p_tenant_id,
    p_organization_id,
    'Document',
    doc_insert.id,
    'DocumentCreated',
    jsonb_build_object('docType', p_doc_type, 'date', p_doc_date, 'data', p_data),
    NOW()
  FROM doc_insert
  RETURNING (SELECT id FROM doc_insert) as document_id, id as event_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- FP-009: Grant execute to app role
GRANT EXECUTE ON FUNCTION create_document TO "flowpos_app";

-- ─── SESSION CONTEXT (Set by application) ─────────────────────────────────────

-- FP-009: Application sets these before queries
-- SELECT set_config('app.tenant_id', 'xxx', false);
-- SELECT set_config('app.organization_id', 'yyy', false);
-- SELECT set_config('app.user_id', 'zzz', false);
-- Then all queries automatically filtered by RLS

-- ─── REVOKE PUBLIC (FP-009: Security hardening) ───────────────────────────────

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;

-- Grant specific permissions to app role
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "flowpos_app";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "flowpos_app";
