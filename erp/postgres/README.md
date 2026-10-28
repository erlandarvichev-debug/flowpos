# PostgreSQL ESF persistence slice

This is a separately tested SQL component; the local HTTP app still uses SQLite. It is not a complete ERP schema, production deployment or official ESF adapter. `docs/erp/contracts/target-model.sql` remains a design sample for the wider ERP.

Prerequisite: PostgreSQL 16+ tooling. Create an entirely new disposable local fixture cluster, never a production/existing data directory:

```
initdb -D <new-fixture-cluster> -U esf_fixture_admin --auth-local=trust --auth-host=trust --no-locale --encoding=UTF8
pg_ctl -D <new-fixture-cluster> -l <fixture-log> -o "-h 127.0.0.1 -p <unused-fixture-port>" -w start
python tools/test_esf_postgres.py --psql <absolute-psql> --port <fixture-port> --pg-ctl <absolute-pg_ctl> --cluster <absolute-new-fixture-cluster>
pg_ctl -D <new-fixture-cluster> -m fast -w stop
```

The harness validates data_directory/current_user, creates its own named test DB, uses NOLOGIN/NOSUPERUSER/NOBYPASSRLS owner/runtime roles, runs migration twice and checks RLS, composite FK, command permissions, optimistic version/expiry, six concurrent sessions, actual server restart, UNKNOWN/no-resend and stale/NULL lease fencing. On success it drops its test DB; dispose of this stopped fixture cluster to leave no test access. No credentials, service registration, firewall changes or external access are needed.

Application migrations create no roles. For eventual deployment, use a separate migration identity and restricted NOLOGIN command owner, an existing restricted runtime role, and explicit controlled role ownership/grants. `002_runtime_grants.sql` accepts psql runtime_role. Runtime has SELECT plus specific command EXECUTE, no direct DML, no permission to change grants or call record_event. Functions have fixed search_path and explicit scope/action checks; FORCE RLS also applies to a non-bypass owner. Trusted app.tenant_id/app.principal_id must come from validated server identity, never client headers. RLS cannot protect a compromised server that can choose any trusted context.

Limits: SQL fixture payload_hash is caller-supplied; repeated operation additionally compares JSONB projection so a reused supplied hash cannot hide changed content. A production repository must calculate/verify the exact immutable original byte hash and bind signature bytes separately; JSONB serialization is not XML canonicalization. Full raw binary inbox/cursor, job scheduler, PostgreSQL reconciliation repository, auth provider and signing transport are subsequent work. No network or crypto operation runs inside these SQL transactions.
