-- DESIGN ONLY. PostgreSQL target, not an applied migration; requires integration/RLS tests.
BEGIN;
CREATE TABLE tenants (id uuid PRIMARY KEY, name text NOT NULL);
CREATE TABLE legal_entities (tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL,
  name text NOT NULL, bin_iin text NOT NULL, PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,bin_iin));
CREATE TABLE documents (tenant_id uuid NOT NULL, organization_id uuid NOT NULL, id uuid NOT NULL,
  operation_id uuid NOT NULL, device_id uuid, kind text NOT NULL, version bigint NOT NULL DEFAULT 1,
  state text NOT NULL, document_date date NOT NULL, currency char(3) NOT NULL,
  amount_minor numeric(24,0) NOT NULL, payload_hash char(64) NOT NULL,
  PRIMARY KEY(tenant_id,organization_id,id), UNIQUE(tenant_id,organization_id,operation_id),
  FOREIGN KEY(tenant_id,organization_id) REFERENCES legal_entities(tenant_id,id));
CREATE TABLE document_lines (tenant_id uuid NOT NULL, organization_id uuid NOT NULL,
  document_id uuid NOT NULL, line_no integer NOT NULL, item_id uuid NOT NULL,
  quantity numeric(24,6) NOT NULL, amount_minor numeric(24,0) NOT NULL,
  PRIMARY KEY(tenant_id,organization_id,document_id,line_no),
  FOREIGN KEY(tenant_id,organization_id,document_id) REFERENCES documents(tenant_id,organization_id,id));
CREATE TABLE integration_connections (tenant_id uuid NOT NULL, organization_id uuid NOT NULL, id uuid NOT NULL,
  provider text NOT NULL, environment text NOT NULL CHECK(environment IN ('synthetic','test','production')),
  contract_state text NOT NULL DEFAULT 'CONTRACT_UNVERIFIED', credential_ref text,
  PRIMARY KEY(tenant_id,organization_id,id), FOREIGN KEY(tenant_id,organization_id) REFERENCES legal_entities(tenant_id,id));
CREATE TABLE esf_versions (tenant_id uuid NOT NULL, organization_id uuid NOT NULL, connection_id uuid NOT NULL,
  id uuid NOT NULL, external_id text NOT NULL, external_revision text NOT NULL,
  direction text NOT NULL CHECK(direction IN ('IN','OUT')), schema_version text NOT NULL,
  raw_object_ref text NOT NULL, raw_hash char(64) NOT NULL, raw_size bigint NOT NULL CHECK(raw_size>=0),
  encoding text NOT NULL, projection jsonb NOT NULL, raw_status text, canonical_status text NOT NULL,
  correction_of uuid, received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,organization_id,id),
  UNIQUE(tenant_id,organization_id,connection_id,direction,external_id,external_revision),
  FOREIGN KEY(tenant_id,organization_id,connection_id) REFERENCES integration_connections(tenant_id,organization_id,id),
  FOREIGN KEY(tenant_id,organization_id,correction_of) REFERENCES esf_versions(tenant_id,organization_id,id));
CREATE TABLE approvals (tenant_id uuid NOT NULL, organization_id uuid NOT NULL, id uuid NOT NULL,
  document_id uuid NOT NULL, document_version bigint NOT NULL, action text NOT NULL,
  payload_hash char(64) NOT NULL, actor_id uuid NOT NULL, expires_at timestamptz NOT NULL,
  consumed_at timestamptz, PRIMARY KEY(tenant_id,organization_id,id),
  FOREIGN KEY(tenant_id,organization_id,document_id) REFERENCES documents(tenant_id,organization_id,id));
CREATE TABLE integration_jobs (tenant_id uuid NOT NULL, organization_id uuid NOT NULL, id uuid NOT NULL,
  connection_id uuid NOT NULL, operation_id uuid NOT NULL, kind text NOT NULL, state text NOT NULL,
  attempts integer NOT NULL DEFAULT 0, next_run_at timestamptz NOT NULL DEFAULT now(), lease_until timestamptz,
  lease_owner uuid, fencing_version bigint NOT NULL DEFAULT 0, cursor jsonb,
  PRIMARY KEY(tenant_id,organization_id,id), UNIQUE(tenant_id,organization_id,operation_id),
  FOREIGN KEY(tenant_id,organization_id,connection_id) REFERENCES integration_connections(tenant_id,organization_id,id));
CREATE INDEX jobs_due ON integration_jobs(state,next_run_at) WHERE state='QUEUED';
CREATE TABLE vat_allocations (tenant_id uuid NOT NULL, organization_id uuid NOT NULL, id uuid NOT NULL,
  esf_version_id uuid NOT NULL, year integer NOT NULL, quarter integer NOT NULL CHECK(quarter BETWEEN 1 AND 4),
  amount_minor numeric(24,0) NOT NULL CHECK(amount_minor>=0), rule_pack_id uuid NOT NULL,
  reason text NOT NULL, supersedes_id uuid, approved_by uuid NOT NULL,
  PRIMARY KEY(tenant_id,organization_id,id),
  FOREIGN KEY(tenant_id,organization_id,esf_version_id) REFERENCES esf_versions(tenant_id,organization_id,id),
  FOREIGN KEY(tenant_id,organization_id,supersedes_id) REFERENCES vat_allocations(tenant_id,organization_id,id));
-- Sum of active allocations <= eligible VAT requires locked aggregate command/deferred trigger + tests.
CREATE TABLE journal_entries (tenant_id uuid NOT NULL, organization_id uuid NOT NULL, id uuid NOT NULL,
  source_document_id uuid NOT NULL, source_version bigint NOT NULL, rule_pack_id uuid NOT NULL,
  period date NOT NULL, PRIMARY KEY(tenant_id,organization_id,id),
  UNIQUE(tenant_id,organization_id,source_document_id,source_version),
  FOREIGN KEY(tenant_id,organization_id,source_document_id) REFERENCES documents(tenant_id,organization_id,id));
CREATE TABLE journal_lines (tenant_id uuid NOT NULL, organization_id uuid NOT NULL, entry_id uuid NOT NULL,
  line_no integer NOT NULL, account_code text NOT NULL, debit numeric(24,2) NOT NULL DEFAULT 0,
  credit numeric(24,2) NOT NULL DEFAULT 0, currency char(3) NOT NULL, dimensions jsonb NOT NULL DEFAULT '{}',
  CHECK(debit>=0 AND credit>=0 AND NOT(debit>0 AND credit>0)),
  PRIMARY KEY(tenant_id,organization_id,entry_id,line_no),
  FOREIGN KEY(tenant_id,organization_id,entry_id) REFERENCES journal_entries(tenant_id,organization_id,id));
-- Deferred balance validation and immutable posted guard required before use.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['legal_entities','documents','document_lines','integration_connections','esf_versions','approvals','integration_jobs','vat_allocations','journal_entries','journal_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY tenant_scope ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
  END LOOP;
END $$;
-- Organization grants must be enforced in app + corresponding RLS policy; tenant-only policy above is incomplete for production.
-- Runtime role must not own tables or have SUPERUSER/BYPASSRLS; SET LOCAL context only from trusted authenticated server.
COMMIT;
