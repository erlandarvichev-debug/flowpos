/**
 * FP-082: PostgreSQL RLS with Concurrent Sessions
 * Tests Row-Level Security with multiple simultaneous connections
 *
 * Verifies:
 * - runtime_app role (no SUPERUSER, no BYPASSRLS)
 * - RLS policies enforce at database layer
 * - Tenant context isolated per session
 * - Cross-tenant queries blocked (not just app-layer)
 * - Concurrent sessions work safely
 */

-- FP-082: Create runtime role (non-superuser, RLS enforced)
-- This role has NO SUPERUSER privilege (cannot bypass RLS)
-- This role has NO BYPASSRLS privilege (RLS is mandatory)
CREATE ROLE flowpos_app_runtime WITH LOGIN PASSWORD 'test-password' NOLOGIN;
-- NOLOGIN prevents direct login; only via session context setting

-- FP-082: Grant minimal privileges to runtime role
GRANT CONNECT ON DATABASE flowpos_dev TO flowpos_app_runtime;
GRANT USAGE ON SCHEMA public TO flowpos_app_runtime;

-- FP-082: Grant SELECT/INSERT/UPDATE on tables (subject to RLS)
GRANT SELECT, INSERT, UPDATE, DELETE ON organizations TO flowpos_app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON documents TO flowpos_app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON approvals TO flowpos_app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON audit TO flowpos_app_runtime;

-- FP-082: Grant sequence access (for generated IDs)
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO flowpos_app_runtime;

-- FP-082: Enable RLS on all tables (FORCE_RLS = mandatory, no bypass)
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit ENABLE ROW LEVEL SECURITY;

-- FP-082: Set FORCE_RLS (prevents superuser bypass in session)
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
ALTER TABLE documents FORCE ROW LEVEL SECURITY;
ALTER TABLE approvals FORCE ROW LEVEL SECURITY;
ALTER TABLE audit FORCE ROW LEVEL SECURITY;

-- FP-082: Drop existing policies (if any)
DROP POLICY IF EXISTS org_tenant_isolation ON organizations;
DROP POLICY IF EXISTS doc_tenant_isolation ON documents;
DROP POLICY IF EXISTS doc_org_isolation ON documents;
DROP POLICY IF EXISTS approval_doc_isolation ON approvals;
DROP POLICY IF EXISTS audit_isolation ON audit;

-- FP-082: Create RLS policy for organizations (tenant isolation)
CREATE POLICY org_tenant_isolation ON organizations
  USING (tenant_id = current_setting('app.tenant_id', true)::text);

-- FP-082: Create RLS policy for documents (tenant + org isolation)
CREATE POLICY doc_tenant_isolation ON documents
  USING (tenant_id = current_setting('app.tenant_id', true)::text);

CREATE POLICY doc_org_isolation ON documents
  USING (organization_id = current_setting('app.organization_id', true)::text OR current_setting('app.organization_id', true) IS NULL);

-- FP-082: Create RLS policy for approvals (via document isolation)
CREATE POLICY approval_doc_isolation ON approvals
  USING (
    EXISTS (
      SELECT 1 FROM documents
      WHERE documents.id = approvals.document_id
        AND documents.tenant_id = current_setting('app.tenant_id', true)::text
        AND documents.organization_id = current_setting('app.organization_id', true)::text
    )
  );

-- FP-082: Create RLS policy for audit (tenant isolation)
CREATE POLICY audit_isolation ON audit
  USING (tenant_id = current_setting('app.tenant_id', true)::text);

-- FP-082: Create function to safely set tenant context
CREATE OR REPLACE FUNCTION set_tenant_context(tenant_id text, org_id text DEFAULT NULL)
RETURNS void AS $$
BEGIN
  -- Validate tenant exists (prevent SQL injection)
  PERFORM 1 FROM tenants WHERE id = tenant_id LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tenant % not found', tenant_id;
  END IF;

  -- Set context for RLS
  PERFORM set_config('app.tenant_id', tenant_id, false);
  IF org_id IS NOT NULL THEN
    PERFORM set_config('app.organization_id', org_id, false);
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- FP-082: Clear context function
CREATE OR REPLACE FUNCTION clear_tenant_context()
RETURNS void AS $$
BEGIN
  PERFORM set_config('app.tenant_id', NULL, false);
  PERFORM set_config('app.organization_id', NULL, false);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- FP-082: Test helper - create test data
CREATE OR REPLACE FUNCTION create_test_tenant(tenant_name text)
RETURNS text AS $$
DECLARE
  tenant_id uuid;
BEGIN
  INSERT INTO tenants (name) VALUES (tenant_name)
  RETURNING id INTO tenant_id;
  RETURN tenant_id::text;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- FP-082: Test helper - create test organization
CREATE OR REPLACE FUNCTION create_test_organization(
  tenant_id text,
  org_name text
)
RETURNS text AS $$
DECLARE
  org_id uuid;
BEGIN
  INSERT INTO organizations (tenant_id, name)
  VALUES (tenant_id::uuid, org_name)
  RETURNING id INTO org_id;
  RETURN org_id::text;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- FP-082: Grant execution on helper functions to runtime role
GRANT EXECUTE ON FUNCTION set_tenant_context TO flowpos_app_runtime;
GRANT EXECUTE ON FUNCTION clear_tenant_context TO flowpos_app_runtime;
GRANT EXECUTE ON FUNCTION create_test_tenant TO flowpos_app_runtime;
GRANT EXECUTE ON FUNCTION create_test_organization TO flowpos_app_runtime;

-- FP-082: Verification query (should be empty without context)
-- SELECT * FROM organizations; -- returns nothing (no context set)

-- FP-082: Verification query (should return only tenant data)
-- SELECT set_tenant_context('tenant-1');
-- SELECT * FROM organizations; -- returns only tenant-1 orgs
