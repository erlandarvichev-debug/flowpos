/** Disposable child-process test harness; never imported by server. */
import { appendFileSync } from 'node:fs';
import { EsfStore, type EsfGateway } from './core.ts';
const [path,mode,id,marker]=process.argv.slice(2);
const s=new EsfStore(path),scope={tenantId:'tenant-a',orgId:'org-a'};
try {
  if(mode==='create')console.log(s.create(scope,'shared-operation',{number:'shared',amountMinor:'1',currency:'KZT'}).id);
  else {
    const gateway:EsfGateway={mode:'synthetic',send:async(d)=>{appendFileSync(marker,'effect\n');if(mode==='crash')process.exit(23);return {state:'REGISTERED',externalId:`stand-${d.id}`};},lookup:async()=>({state:'UNKNOWN'})};
    console.log(JSON.stringify(await s.send(scope,id,gateway)));
  }
}finally{s.close();}
