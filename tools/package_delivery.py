"""Build portable delta/stand package from committed source, excluding runtime data."""
from pathlib import Path
import hashlib,json,subprocess,zipfile
REPO=Path(__file__).resolve().parents[1];OUT=REPO.parent/'deliverables';OUT.mkdir(exist_ok=True)
BASE='e87ab0bd3cab1a130fdc114078d772200d3223b1';PREVIOUS='1a3b6153dfc5069523330dcbf0c173f040cf0f4b'
def git(*args):return subprocess.check_output(['git',*args],cwd=REPO,text=True).strip()
head=git('rev-parse','HEAD');assert not git('status','--porcelain'),'Commit/clean workspace before packaging'
names=git('diff','--name-only',BASE,'HEAD').splitlines()
for base,name in [(BASE,'FLOWPOS_ERP_local_changes.patch'),(PREVIOUS,'FLOWPOS_ERP_stage2.patch')]:subprocess.run(['git','diff',base,'HEAD','--binary','--output='+str(OUT/name)],cwd=REPO,check=True)
manifest={'base':BASE,'previous_stage':PREVIOUS,'head':head,'branch':'codex/esf-local-20261027','revision':'2.1','synthetic_only':True,'tests':{'pos':230,'node_esf':23,'postgres_fixture':11},'docx_rendered_pages':39,'files':[]}
readme=f'''# FLOWPOS ERP 2.1 · developer package

Base {BASE}
Stage 1 {PREVIOUS}
Local HEAD {head}

Standalone synthetic stand: Node 24.17+, no node_modules required:
  node code/erp/esf-stand/server.ts
  node --test code/erp/esf-stand/*.node-test.ts
Open http://127.0.0.1:14840. Local fixture identity only; stand-org operator, stand-org-b read-only. Do not expose via proxy/public network. Stop with Ctrl+C.

To apply to authorized checkout at original base: git apply --check FLOWPOS_ERP_local_changes.patch, then git apply the same patch. If stage 1 is already applied, use FLOWPOS_ERP_stage2.patch instead. Never apply both. Then npm ci --ignore-scripts, npm test, npm run build, npm run typecheck:esf, npm run test:esf. code/ contains changed/new files, not the full private POS checkout.

Read code/docs/erp/CHANGELOG.md, STAGE2.md, LOCAL_RUNBOOK.md and evidence/STAGE2_VALIDATION.md. PostgreSQL SQL/roles/restart tests are separate from the still-SQLite HTTP runtime; read code/erp/postgres/README.md for safe disposable test setup. SQL fixture hash is caller-supplied and is not real XML/signature verification. No production auth, PG HTTP repository, real ESF transport, crypto signing or full ERP is claimed complete.

Evidence: 230 POS tests, 23 ESF Node tests, 11 real PostgreSQL 16.9 checks, typecheck/build, browser workflow, 39-page DOCX render QA. PostgreSQL fixture cluster is stopped/removed after validation. No external credentials, persistent access, push, PR or deploy.

This package excludes secrets, live databases, node_modules, installers, raw public HTML response, and browser screenshots. SHA256_MANIFEST.json validates packaged bytes. The editable DOCX is delivered separately under its existing Library identity. Full ERP scope/backlog now has 82 tasks.
'''
target=OUT/'FLOWPOS_ERP_Developer_Package_2026-10-27.zip'
with zipfile.ZipFile(target,'w',zipfile.ZIP_DEFLATED,compresslevel=9) as z:
 for name in names:
  assert not any(x in name.lower() for x in ['.env','.sqlite','.local-stand','.key'])
  data=(REPO/name).read_bytes();path='code/'+name;z.writestr(path,data);manifest['files'].append({'path':path,'size_bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()})
 for name in ['FLOWPOS_ERP_local_changes.patch','FLOWPOS_ERP_stage2.patch']:
  data=(OUT/name).read_bytes();z.writestr(name,data);manifest['files'].append({'path':name,'size_bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()})
 z.writestr('README_DELIVERY.md',readme);z.writestr('SHA256_MANIFEST.json',json.dumps(manifest,ensure_ascii=False,indent=2))
with zipfile.ZipFile(target) as z:
 assert z.testzip() is None
 for f in manifest['files']:assert hashlib.sha256(z.read(f['path'])).hexdigest()==f['sha256']
delivery={'base':BASE,'previous_stage':PREVIOUS,'head':head,'git_status':'clean','docx_pages':39,'files':[]}
for p in [OUT/'FLOWPOS_ERP_Specification_v2_2026-10-27.docx',target,OUT/'FLOWPOS_ERP_stage2.patch']:
 delivery['files'].append({'path':str(p),'size_bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()})
(OUT/'delivery-stage2.json').write_text(json.dumps(delivery,ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps(delivery,ensure_ascii=False,indent=2))
