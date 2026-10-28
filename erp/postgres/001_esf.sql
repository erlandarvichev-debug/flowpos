-- ESF persistence slice, PostgreSQL 16+. No login roles or credentials are created.
BEGIN;
SELECT pg_advisory_xact_lock(831271604);
CREATE SCHEMA IF NOT EXISTS flowpos_esf;
CREATE TABLE IF NOT EXISTS flowpos_esf.schema_versions(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS flowpos_esf.organizations(tenant_id uuid NOT NULL,id uuid NOT NULL,name text NOT NULL,PRIMARY KEY(tenant_id,id));
CREATE TABLE IF NOT EXISTS flowpos_esf.grants(principal_id uuid NOT NULL,tenant_id uuid NOT NULL,organization_id uuid NOT NULL,action text NOT NULL CHECK(action IN ('read','draft','approve','send','reconcile','ingest')),
 PRIMARY KEY(principal_id,tenant_id,organization_id,action),FOREIGN KEY(tenant_id,organization_id) REFERENCES flowpos_esf.organizations(tenant_id,id));
CREATE TABLE IF NOT EXISTS flowpos_esf.documents(tenant_id uuid NOT NULL,organization_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),operation_id uuid NOT NULL,
 payload jsonb NOT NULL,payload_hash text NOT NULL CHECK(payload_hash~'^[a-f0-9]{64}$'),version bigint NOT NULL DEFAULT 1 CHECK(version>0),
 state text NOT NULL DEFAULT 'DRAFT' CHECK(state IN ('DRAFT','APPROVED','SENDING','UNKNOWN','REGISTERED','REJECTED')),external_id text,lease_token uuid,lease_until timestamptz,
 PRIMARY KEY(tenant_id,organization_id,id),UNIQUE(tenant_id,organization_id,operation_id),FOREIGN KEY(tenant_id,organization_id) REFERENCES flowpos_esf.organizations(tenant_id,id));
CREATE TABLE IF NOT EXISTS flowpos_esf.approvals(tenant_id uuid NOT NULL,organization_id uuid NOT NULL,document_id uuid NOT NULL,document_version bigint NOT NULL,payload_hash text NOT NULL,
 expires_at timestamptz NOT NULL,consumed boolean NOT NULL DEFAULT false,approved_by uuid NOT NULL,
 PRIMARY KEY(tenant_id,organization_id,document_id,document_version),FOREIGN KEY(tenant_id,organization_id,document_id) REFERENCES flowpos_esf.documents(tenant_id,organization_id,id));
CREATE TABLE IF NOT EXISTS flowpos_esf.attempts(tenant_id uuid NOT NULL,organization_id uuid NOT NULL,document_id uuid NOT NULL,token uuid NOT NULL,started_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,organization_id,document_id),UNIQUE(token),FOREIGN KEY(tenant_id,organization_id,document_id) REFERENCES flowpos_esf.documents(tenant_id,organization_id,id));
CREATE TABLE IF NOT EXISTS flowpos_esf.audit(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,tenant_id uuid NOT NULL,organization_id uuid NOT NULL,document_id uuid NOT NULL,actor_id uuid NOT NULL,event text NOT NULL,at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(tenant_id,organization_id,document_id) REFERENCES flowpos_esf.documents(tenant_id,organization_id,id));
CREATE OR REPLACE FUNCTION flowpos_esf.has_access(t uuid,o uuid,a text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,flowpos_esf AS $$
 SELECT coalesce(t=nullif(current_setting('app.tenant_id',true),'')::uuid AND EXISTS(SELECT 1 FROM flowpos_esf.grants g WHERE g.tenant_id=t AND g.organization_id=o AND g.principal_id=nullif(current_setting('app.principal_id',true),'')::uuid AND g.action=a),false)
$$;
CREATE OR REPLACE FUNCTION flowpos_esf.record_event(t uuid,o uuid,d uuid,e text) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,flowpos_esf AS $$
 INSERT INTO flowpos_esf.audit(tenant_id,organization_id,document_id,actor_id,event) VALUES(t,o,d,nullif(current_setting('app.principal_id',true),'')::uuid,e)
$$;
CREATE OR REPLACE FUNCTION flowpos_esf.create_draft(t uuid,o uuid,op uuid,h text,p jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,flowpos_esf AS $$
DECLARE d flowpos_esf.documents; BEGIN
 IF NOT flowpos_esf.has_access(t,o,'draft') THEN RAISE EXCEPTION 'ACCESS_DENIED' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(t::text||o::text||op::text,0));
 SELECT * INTO d FROM flowpos_esf.documents WHERE tenant_id=t AND organization_id=o AND operation_id=op FOR UPDATE;
 IF FOUND THEN IF d.payload_hash<>h OR d.payload<>p THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF; RETURN d.id; END IF;
 INSERT INTO flowpos_esf.documents(tenant_id,organization_id,operation_id,payload_hash,payload) VALUES(t,o,op,h,p) RETURNING * INTO d;
 PERFORM flowpos_esf.record_event(t,o,d.id,'DRAFT_CREATED'); RETURN d.id;
END $$;
CREATE OR REPLACE FUNCTION flowpos_esf.approve_document(t uuid,o uuid,i uuid,v bigint,h text,expiry timestamptz) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,flowpos_esf AS $$
DECLARE d flowpos_esf.documents; BEGIN
 IF NOT flowpos_esf.has_access(t,o,'approve') THEN RAISE EXCEPTION 'ACCESS_DENIED' USING ERRCODE='42501'; END IF;
 SELECT * INTO d FROM flowpos_esf.documents WHERE tenant_id=t AND organization_id=o AND id=i FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF d.version<>v THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
 IF d.state<>'DRAFT' THEN RAISE EXCEPTION 'INVALID_STATE'; END IF;
 IF d.payload_hash<>h OR expiry<=clock_timestamp() OR expiry>clock_timestamp()+interval '5 minutes' THEN RAISE EXCEPTION 'STALE_APPROVAL'; END IF;
 INSERT INTO flowpos_esf.approvals VALUES(t,o,i,v+1,h,expiry,false,nullif(current_setting('app.principal_id',true),'')::uuid);
 UPDATE flowpos_esf.documents SET state='APPROVED',version=v+1 WHERE tenant_id=t AND organization_id=o AND id=i;
 PERFORM flowpos_esf.record_event(t,o,i,'APPROVED'); RETURN v+1;
END $$;
CREATE OR REPLACE FUNCTION flowpos_esf.claim_send(t uuid,o uuid,i uuid,v bigint) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,flowpos_esf AS $$
DECLARE d flowpos_esf.documents; a flowpos_esf.approvals; tok uuid:=gen_random_uuid(); BEGIN
 IF NOT flowpos_esf.has_access(t,o,'send') THEN RAISE EXCEPTION 'ACCESS_DENIED' USING ERRCODE='42501'; END IF;
 SELECT * INTO d FROM flowpos_esf.documents WHERE tenant_id=t AND organization_id=o AND id=i FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF d.state IN ('SENDING','UNKNOWN','REGISTERED','REJECTED') THEN RETURN NULL; END IF;
 IF d.version<>v THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
 IF d.state<>'APPROVED' THEN RAISE EXCEPTION 'APPROVAL_REQUIRED'; END IF;
 SELECT * INTO a FROM flowpos_esf.approvals WHERE tenant_id=t AND organization_id=o AND document_id=i AND document_version=v FOR UPDATE;
 IF NOT FOUND OR a.consumed OR a.payload_hash<>d.payload_hash OR a.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'STALE_APPROVAL'; END IF;
 INSERT INTO flowpos_esf.attempts(tenant_id,organization_id,document_id,token) VALUES(t,o,i,tok);
 UPDATE flowpos_esf.approvals SET consumed=true WHERE tenant_id=t AND organization_id=o AND document_id=i AND document_version=v;
 UPDATE flowpos_esf.documents SET state='SENDING',version=version+1,lease_token=tok,lease_until=clock_timestamp()+interval '60 seconds' WHERE tenant_id=t AND organization_id=o AND id=i;
 PERFORM flowpos_esf.record_event(t,o,i,'SEND_CLAIMED'); RETURN tok;
END $$;
CREATE OR REPLACE FUNCTION flowpos_esf.finish_attempt(t uuid,o uuid,i uuid,tok uuid,result text,remote_id text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,flowpos_esf AS $$
DECLARE d flowpos_esf.documents; BEGIN
 IF NOT(flowpos_esf.has_access(t,o,'send') OR flowpos_esf.has_access(t,o,'reconcile')) THEN RAISE EXCEPTION 'ACCESS_DENIED' USING ERRCODE='42501'; END IF;
 SELECT * INTO d FROM flowpos_esf.documents WHERE tenant_id=t AND organization_id=o AND id=i FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF tok IS NULL OR d.lease_token IS NULL OR d.lease_until IS NULL OR d.state NOT IN ('SENDING','UNKNOWN') OR d.lease_token IS DISTINCT FROM tok OR d.lease_until<=clock_timestamp() THEN RETURN false; END IF;
 IF result NOT IN ('REGISTERED','REJECTED','UNKNOWN') OR result='REGISTERED' AND coalesce(remote_id,'')='' THEN RAISE EXCEPTION 'INVALID_RESULT'; END IF;
 UPDATE flowpos_esf.documents SET state=result,external_id=remote_id,version=version+1,lease_token=NULL,lease_until=NULL WHERE tenant_id=t AND organization_id=o AND id=i;
 PERFORM flowpos_esf.record_event(t,o,i,result); RETURN true;
END $$;
CREATE OR REPLACE FUNCTION flowpos_esf.recover_expired(t uuid,o uuid) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,flowpos_esf AS $$
DECLARE d flowpos_esf.documents; n integer:=0; BEGIN
 IF NOT flowpos_esf.has_access(t,o,'reconcile') THEN RAISE EXCEPTION 'ACCESS_DENIED' USING ERRCODE='42501'; END IF;
 FOR d IN SELECT * FROM flowpos_esf.documents WHERE tenant_id=t AND organization_id=o AND state='SENDING' AND lease_until<=clock_timestamp() FOR UPDATE SKIP LOCKED LOOP
 UPDATE flowpos_esf.documents SET state='UNKNOWN',version=version+1,lease_token=NULL,lease_until=NULL WHERE tenant_id=t AND organization_id=o AND id=d.id;
 PERFORM flowpos_esf.record_event(t,o,d.id,'RECOVERED_UNKNOWN');n:=n+1;END LOOP;RETURN n;
END $$;
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['organizations','documents','approvals','attempts','audit'] LOOP
 EXECUTE format('ALTER TABLE flowpos_esf.%I ENABLE ROW LEVEL SECURITY',tab);
 EXECUTE format('ALTER TABLE flowpos_esf.%I FORCE ROW LEVEL SECURITY',tab);
 EXECUTE format('DROP POLICY IF EXISTS scoped_read ON flowpos_esf.%I',tab);
 IF tab='organizations' THEN
 EXECUTE format('CREATE POLICY scoped_read ON flowpos_esf.%I FOR SELECT USING(flowpos_esf.has_access(tenant_id,id,''read''))',tab);
 ELSE EXECUTE format('CREATE POLICY scoped_read ON flowpos_esf.%I FOR SELECT USING(flowpos_esf.has_access(tenant_id,organization_id,''read''))',tab);END IF;
 END LOOP;
END $$;
DROP POLICY IF EXISTS scoped_insert ON flowpos_esf.documents;
CREATE POLICY scoped_insert ON flowpos_esf.documents FOR INSERT WITH CHECK(flowpos_esf.has_access(tenant_id,organization_id,'draft'));
DROP POLICY IF EXISTS scoped_update ON flowpos_esf.documents;
CREATE POLICY scoped_update ON flowpos_esf.documents FOR UPDATE USING(flowpos_esf.has_access(tenant_id,organization_id,'read')) WITH CHECK(flowpos_esf.has_access(tenant_id,organization_id,'approve') OR flowpos_esf.has_access(tenant_id,organization_id,'send') OR flowpos_esf.has_access(tenant_id,organization_id,'reconcile'));
DROP POLICY IF EXISTS scoped_insert ON flowpos_esf.approvals;
CREATE POLICY scoped_insert ON flowpos_esf.approvals FOR INSERT WITH CHECK(flowpos_esf.has_access(tenant_id,organization_id,'approve'));
DROP POLICY IF EXISTS scoped_update ON flowpos_esf.approvals;
CREATE POLICY scoped_update ON flowpos_esf.approvals FOR UPDATE USING(flowpos_esf.has_access(tenant_id,organization_id,'send')) WITH CHECK(flowpos_esf.has_access(tenant_id,organization_id,'send'));
DROP POLICY IF EXISTS scoped_insert ON flowpos_esf.attempts;
CREATE POLICY scoped_insert ON flowpos_esf.attempts FOR INSERT WITH CHECK(flowpos_esf.has_access(tenant_id,organization_id,'send'));
DROP POLICY IF EXISTS scoped_insert ON flowpos_esf.audit;
CREATE POLICY scoped_insert ON flowpos_esf.audit FOR INSERT WITH CHECK(actor_id=nullif(current_setting('app.principal_id',true),'')::uuid AND (flowpos_esf.has_access(tenant_id,organization_id,'draft') OR flowpos_esf.has_access(tenant_id,organization_id,'approve') OR flowpos_esf.has_access(tenant_id,organization_id,'send') OR flowpos_esf.has_access(tenant_id,organization_id,'reconcile')));
REVOKE ALL ON ALL TABLES IN SCHEMA flowpos_esf FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA flowpos_esf FROM PUBLIC;
INSERT INTO flowpos_esf.schema_versions(version) VALUES(1) ON CONFLICT DO NOTHING;
COMMIT;
