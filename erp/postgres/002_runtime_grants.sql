-- psql -v runtime_role=<existing restricted role>. This script creates no role/credential.
BEGIN;
GRANT USAGE ON SCHEMA flowpos_esf TO :"runtime_role";
GRANT SELECT ON flowpos_esf.organizations,flowpos_esf.documents,flowpos_esf.approvals,flowpos_esf.attempts,flowpos_esf.audit TO :"runtime_role";
GRANT EXECUTE ON FUNCTION flowpos_esf.has_access(uuid,uuid,text),flowpos_esf.create_draft(uuid,uuid,uuid,text,jsonb),
 flowpos_esf.approve_document(uuid,uuid,uuid,bigint,text,timestamptz),flowpos_esf.claim_send(uuid,uuid,uuid,bigint),
 flowpos_esf.finish_attempt(uuid,uuid,uuid,uuid,text,text),flowpos_esf.recover_expired(uuid,uuid) TO :"runtime_role";
COMMIT;
