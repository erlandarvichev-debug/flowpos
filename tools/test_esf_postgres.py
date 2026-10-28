"""Disposable fixture cluster only; requires explicit local psql path/port. No credentials."""
from pathlib import Path
import argparse,concurrent.futures,json,subprocess,re
P=argparse.ArgumentParser();P.add_argument('--psql',required=True);P.add_argument('--port',required=True);P.add_argument('--pg-ctl',required=True);P.add_argument('--cluster',required=True);args=P.parse_args()
ROOT=Path(__file__).resolve().parents[1]
base=[args.psql,'-X','-h','127.0.0.1','-p',args.port,'-U','esf_fixture_admin','-d','postgres','-v','ON_ERROR_STOP=1','-Atq']
def sql(text,success=True):
 r=subprocess.run(base,input=text,text=True,encoding='utf-8',capture_output=True)
 if success and r.returncode:raise AssertionError(r.stderr)
 if not success and r.returncode==0:raise AssertionError('Expected SQL rejection')
 return r.stdout.strip(),r.stderr
T='10000000-0000-0000-0000-000000000001';O='20000000-0000-0000-0000-000000000001';B='20000000-0000-0000-0000-000000000002';P1='30000000-0000-0000-0000-000000000001';READER='30000000-0000-0000-0000-000000000002';OTHER='10000000-0000-0000-0000-000000000002';OP='40000000-0000-0000-0000-000000000001';H='a'*64
def runtime(text,p=P1,t=T):return f"BEGIN; SET LOCAL ROLE esf_fixture_runtime; SET LOCAL app.tenant_id='{t}'; SET LOCAL app.principal_id='{p}'; {text}; COMMIT;"
checks=[]
assert Path(sql('SHOW data_directory')[0]).resolve()==Path(args.cluster).resolve(),'Refuse non-fixture cluster'
assert sql('SELECT current_user')[0]=='esf_fixture_admin','Refuse non-fixture administrator'
database='esf_fixture_stage2'
assert re.fullmatch(r'esf_fixture_[a-z0-9_]+',database)
assert sql(f"SELECT count(*) FROM pg_database WHERE datname='{database}'")[0]=='0','Fixture database already exists; inspect before reuse'
sql('CREATE DATABASE '+database);control_base=list(base);base[base.index('-d')+1]=database
sql((ROOT/'erp/postgres/001_esf.sql').read_text());sql((ROOT/'erp/postgres/001_esf.sql').read_text());checks.append('migration applies twice without destructive changes')
sql("DO $$BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='esf_fixture_owner') THEN CREATE ROLE esf_fixture_owner NOLOGIN NOSUPERUSER NOBYPASSRLS;END IF;IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='esf_fixture_runtime') THEN CREATE ROLE esf_fixture_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS;END IF;END$$;")
sql("ALTER SCHEMA flowpos_esf OWNER TO esf_fixture_owner; DO $$DECLARE r record;BEGIN FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='flowpos_esf' LOOP EXECUTE format('ALTER TABLE flowpos_esf.%I OWNER TO esf_fixture_owner',r.tablename);END LOOP;FOR r IN SELECT p.oid::regprocedure f FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='flowpos_esf' LOOP EXECUTE format('ALTER FUNCTION %s OWNER TO esf_fixture_owner',r.f);END LOOP;END$$;")
grant=(ROOT/'erp/postgres/002_runtime_grants.sql').read_text().replace(':"runtime_role"','esf_fixture_runtime');sql(grant)
sql(f"INSERT INTO flowpos_esf.organizations VALUES('{T}','{O}','A'),('{T}','{B}','B'),('{OTHER}','{O}','Foreign');INSERT INTO flowpos_esf.grants SELECT '{P1}','{T}','{O}',unnest(ARRAY['read','draft','approve','send','reconcile','ingest']);INSERT INTO flowpos_esf.grants VALUES('{READER}','{T}','{O}','read');")
out,_=sql("SELECT rolname,rolsuper,rolbypassrls,rolcanlogin FROM pg_roles WHERE rolname IN ('esf_fixture_runtime','esf_fixture_owner') ORDER BY rolname");assert 't' not in out.replace('esf_fixture_runtime','').replace('esf_fixture_owner','');checks.append('runtime and command owner are NOLOGIN/NOSUPERUSER/NOBYPASSRLS')
id,_=sql(runtime(f"SELECT flowpos_esf.create_draft('{T}','{O}','{OP}','{H}','{{\"n\":1}}')"));assert len(id)==36
sql(f"INSERT INTO flowpos_esf.documents(tenant_id,organization_id,operation_id,payload_hash,payload) VALUES('{T}','{B}','{OP}','{H}','{{}}'),('{OTHER}','{O}','{OP}','{H}','{{}}')")
with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:ids=list(pool.map(lambda _:sql(runtime(f"SELECT flowpos_esf.create_draft('{T}','{O}','{OP}','{H}','{{\"n\":1}}')"))[0],range(6)))
assert set(ids)=={id};checks.append('six concurrent sessions create one canonical operation')
sql(runtime(f"SELECT flowpos_esf.create_draft('{T}','{O}','{OP}','{H}','{{\"n\":2}}')"),False);checks.append('same key different payload rejected even with same supplied hash')
assert sql(runtime('SELECT count(*) FROM flowpos_esf.documents'))[0]=='1'
assert sql(runtime('SELECT count(*) FROM flowpos_esf.documents',t=OTHER))[0]=='0'
assert sql(runtime('SELECT count(*) FROM flowpos_esf.documents',p='30000000-0000-0000-0000-000000000099'))[0]=='0'
sql("BEGIN;SET LOCAL ROLE esf_fixture_runtime;SELECT flowpos_esf.create_draft('"+T+"','"+O+"','"+OP+"','"+H+"','{}');COMMIT;",False)
sql(runtime(f"SELECT flowpos_esf.create_draft('{T}','{B}','{OP}','{H}','{{}}')"),False)
sql(runtime(f"SELECT flowpos_esf.approve_document('{T}','{O}','{id}',1,'{H}',now()+interval '1 minute')",p=READER),False)
sql(runtime(f"UPDATE flowpos_esf.documents SET state='REGISTERED' WHERE id='{id}'"),False)
checks.append('RLS isolates tenant and organization; missing context/reader mutation/direct DML denied')
sql(runtime(f"SELECT flowpos_esf.approve_document('{T}','{O}','{id}',9,'{H}',now()+interval '1 minute')"),False)
sql(runtime(f"SELECT flowpos_esf.approve_document('{T}','{O}','{id}',1,'{H}',now()-interval '1 minute')"),False)
sql(runtime(f"SELECT flowpos_esf.approve_document('{T}','{O}','{id}',1,'{H}',now()+interval '1 minute')"));checks.append('expected version and approval expiry enforced')
with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:claims=list(pool.map(lambda _:sql(runtime(f"SELECT flowpos_esf.claim_send('{T}','{O}','{id}',2)"))[0],range(6)))
tokens=[x for x in claims if x];assert len(tokens)==1;token=tokens[0];checks.append('six concurrent sessions claim exactly one submission attempt')
restart_log=Path(args.cluster)/'restart-fixture.log'
with restart_log.open('w',encoding='utf-8') as log:
 restart=subprocess.run([args.pg_ctl,'-D',str(Path(args.cluster).resolve()),'-l',str(Path(args.cluster)/'server-restart.log'),'-m','fast','-w','restart'],stdout=log,stderr=subprocess.STDOUT)
assert restart.returncode==0,restart_log.read_text(encoding='utf-8',errors='replace')
assert sql(runtime(f"SELECT state FROM flowpos_esf.documents WHERE id='{id}'"))[0]=='SENDING'
assert sql(runtime(f"SELECT flowpos_esf.claim_send('{T}','{O}','{id}',2)"))[0]==''
checks.append('actual PostgreSQL restart preserves active claim and attempt identity')
assert sql(runtime(f"SELECT flowpos_esf.finish_attempt('{T}','{O}','{id}','00000000-0000-0000-0000-000000000000','REGISTERED','fake')"))[0]=='f'
sql(f"UPDATE flowpos_esf.documents SET lease_until=now()-interval '1 second' WHERE id='{id}'")
assert sql(runtime(f"SELECT flowpos_esf.recover_expired('{T}','{O}')"))[0]=='1'
assert sql(runtime(f"SELECT flowpos_esf.finish_attempt('{T}','{O}','{id}','{token}','REGISTERED','late')"))[0]=='f'
assert sql(runtime(f"SELECT flowpos_esf.claim_send('{T}','{O}','{id}',4)"))[0]==''
assert sql(runtime(f"SELECT state FROM flowpos_esf.documents WHERE id='{id}'"))[0]=='UNKNOWN';checks.append('expired lease → UNKNOWN; stale callback fenced; no automatic resend')
assert sql(runtime(f"SELECT flowpos_esf.finish_attempt('{T}','{O}','{id}',NULL,'REGISTERED','forged')"))[0]=='f';checks.append('NULL lease token cannot authorize status changes')
sql(f"INSERT INTO flowpos_esf.approvals VALUES('{T}','{B}','{id}',99,'{H}',now(),false,'{P1}')",False);checks.append('composite foreign key rejects cross-organization approval')
result={'postgres_version':sql('SHOW server_version')[0],'checks':checks,'passed':len(checks),'runtime_http_adapter':'not implemented; SQL persistence slice only'}
(ROOT/'evidence'/'stage2-postgres.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps(result,ensure_ascii=False,indent=2))
base=control_base;sql('DROP DATABASE '+database)
