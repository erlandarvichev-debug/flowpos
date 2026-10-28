import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EsfStore, SyntheticGateway, type Scope } from './core.ts';
import { createStandServer } from './server.ts';
import { SyntheticSigningProvider, validateSyntheticSignature } from './signing.ts';
const scope: Scope = {tenantId:'tenant-a',orgId:'org-a'};
const invoice = {number:'TEST-1',amountMinor:'150000',currency:'KZT' as const};
const incoming = {externalId:'remote-1',revision:'1',schemaVersion:'synthetic-v1',xml:'<SyntheticInvoice/>'};
const makeApproved = (s: EsfStore, op = 'op-1') => { const d=s.create(scope,op,invoice);return s.approve(scope,d.id,d.payloadHash,Date.now()+60000); };
test('operation identity survives device migration; changed payload conflicts',() => {
  const s=new EsfStore();try{const a=s.create(scope,'stable-operation',invoice);assert.equal(s.create(scope,'stable-operation',invoice).id,a.id);assert.throws(()=>s.create(scope,'stable-operation',{...invoice,amountMinor:'2'}),/IDEMPOTENCY_CONFLICT/);assert.equal(s.list(scope).length,1);}finally{s.close();}
});
test('synthetic signing boundary binds scope, bytes and expiry; marker is never legal signature',async() => {
  const s=new EsfStore();try{const d=s.create(scope,'sign',invoice),provider=new SyntheticSigningProvider();const artifact=await provider.sign({requestId:'r1',tenantId:scope.tenantId,orgId:scope.orgId,documentId:d.id,payloadHash:d.payloadHash,schemaVersion:'synthetic-v1',expiresAt:Date.now()+60000});validateSyntheticSignature(d,artifact);assert.equal(artifact.marker,'NOT_A_LEGAL_SIGNATURE');assert.throws(()=>validateSyntheticSignature(d,{...artifact,request:{...artifact.request,payloadHash:'changed'}}),/SIGNATURE_BINDING_MISMATCH/);assert.throws(()=>validateSyntheticSignature(d,{...artifact,request:{...artifact.request,orgId:'other'}}),/SIGNATURE_BINDING_MISMATCH/);assert.throws(()=>validateSyntheticSignature(d,artifact,artifact.request.expiresAt+1),/SIGNATURE_BINDING_MISMATCH/);}finally{s.close();}
});
test('tenant and organization scope do not leak document IDs or collide',() => {
  const s=new EsfStore();try{const a=s.create(scope,'same',invoice);const b=s.create({...scope,orgId:'org-b'},'same',invoice);assert.notEqual(a.id,b.id);assert.throws(()=>s.get({...scope,tenantId:'tenant-b'},a.id),/NOT_FOUND/);assert.throws(()=>s.approve({...scope,orgId:'org-b'},a.id,a.payloadHash,Date.now()+1000),/NOT_FOUND/);}finally{s.close();}
});
test('unknown send cannot resend; reconcile only calls lookup',async() => {
  const s=new EsfStore(),g=new SyntheticGateway();try{const d=makeApproved(s);assert.equal((await s.send(scope,d.id,g)).state,'UNKNOWN');await s.send(scope,d.id,g);assert.equal(g.sends,1);assert.equal((await s.reconcile(scope,d.id,g)).state,'REGISTERED');await s.send(scope,d.id,g);assert.equal(g.sends,1);}finally{s.close();}
});
test('concurrent sends claim one durable attempt',async() => {
  const s=new EsfStore(),g=new SyntheticGateway('REGISTERED');try{const d=makeApproved(s);await Promise.all([s.send(scope,d.id,g),s.send(scope,d.id,g)]);assert.equal(g.sends,1);assert.equal(s.get(scope,d.id).state,'REGISTERED');}finally{s.close();}
});
test('confirmed rejection is terminal and audited without automatic retry',async() => {
  const s=new EsfStore(),g=new SyntheticGateway('REJECTED');try{const d=makeApproved(s);assert.equal((await s.send(scope,d.id,g)).errorCode,'REMOTE_REJECTED');await s.send(scope,d.id,g);assert.equal(g.sends,1);assert.equal(s.db.prepare("SELECT count(*) n FROM audit WHERE event='SYNTHETIC_REJECTED'").get()!.n,1);await assert.rejects(s.reconcile(scope,d.id,g),/INVALID_STATE/);}finally{s.close();}
});
test('wrong or expired approval and payload tampering are blocked',async() => {
  const s=new EsfStore();try{const d=s.create(scope,'op',invoice);assert.throws(()=>s.approve(scope,d.id,'bad',Date.now()+1000),/STALE_APPROVAL/);assert.throws(()=>s.approve(scope,d.id,d.payloadHash,10,20),/STALE_APPROVAL/);s.approve(scope,d.id,d.payloadHash,2000,1000);await assert.rejects(s.send(scope,d.id,new SyntheticGateway(),2001),/STALE_APPROVAL/);s.db.prepare('UPDATE documents SET payload=? WHERE id=?').run('{}',d.id);await assert.rejects(s.send(scope,d.id,new SyntheticGateway(),1500),/STALE_APPROVAL/);}finally{s.close();}
});
test('incoming replay is deduplicated and corrections retain linkage',() => {
  const s=new EsfStore();try{const [a]=s.ingest(scope,[incoming],'c1');const [b]=s.ingest(scope,[incoming],'c2');assert.equal(a.id,b.id);const [correction]=s.ingest(scope,[{...incoming,externalId:'remote-2',correctionOf:'remote-1'}],'c3');assert.equal(correction.correctionOf,'remote-1');assert.equal(correction.state,'RECEIVED');assert.equal(s.db.prepare('SELECT count(*) n FROM jobs').get()!.n,0);assert.throws(()=>s.ingest(scope,[{...incoming,xml:'changed'}],'c4'),/REMOTE_ID_CONFLICT/);assert.equal(s.db.prepare('SELECT value FROM cursors').get()!.value,'c3');}finally{s.close();}
});
test('fault before cursor commit rolls back entire inbound batch',() => {
  const s=new EsfStore();try{assert.throws(()=>s.ingest(scope,[incoming],'crash',()=>{throw new Error('injected crash');}),/injected crash/);assert.equal(s.list(scope).length,0);assert.equal(s.db.prepare('SELECT count(*) n FROM cursors').get()!.n,0);s.ingest(scope,[incoming],'replay');assert.equal(s.list(scope).length,1);}finally{s.close();}
});
test('unsupported schema and entity-bearing XML are quarantined without parsing',() => {
  const s=new EsfStore();try{assert.equal(s.ingest(scope,[{...incoming,schemaVersion:'unknown'}],'q1')[0].state,'QUARANTINED');assert.equal(s.ingest(scope,[{...incoming,externalId:'xxe',xml:'<!DOCTYPE x [<!ENTITY e SYSTEM "file:///x">]><x/>'}],'q2')[0].state,'QUARANTINED');}finally{s.close();}
});
test('restart preserves documents; crashed sender recovers UNKNOWN without retry',async() => {
  const dir=mkdtempSync(join(tmpdir(),'flowpos-esf-test-')),path=join(dir,'test.sqlite');let s=new EsfStore(path);try{const d=makeApproved(s);s.db.prepare("UPDATE documents SET state='SENDING' WHERE id=?").run(d.id);s.close();s=new EsfStore(path);const g=new SyntheticGateway();assert.equal(s.get(scope,d.id).state,'UNKNOWN');await s.send(scope,d.id,g);assert.equal(g.sends,0);assert.equal(s.create(scope,'op-1',invoice).id,d.id);}finally{s.close();rmSync(dir,{recursive:true,force:true});}
});
test('gateway errors and malformed ACK remain UNKNOWN; production adapter is blocked',async() => {
  const s=new EsfStore();try{const d=makeApproved(s);await assert.rejects(s.send(scope,d.id,{mode:'production' as 'synthetic',send:async()=>({state:'REGISTERED'}),lookup:async()=>({state:'UNKNOWN'})}),/CONTRACT_UNVERIFIED/);assert.equal(s.get(scope,d.id).state,'APPROVED');assert.equal((await s.send(scope,d.id,{mode:'synthetic',send:async()=>{throw new Error('timeout');},lookup:async()=>({state:'UNKNOWN'})})).state,'UNKNOWN');const e=makeApproved(s,'op-2');assert.equal((await s.send(scope,e.id,{mode:'synthetic',send:async()=>({state:'REGISTERED'}),lookup:async()=>({state:'UNKNOWN'})})).state,'UNKNOWN');}finally{s.close();}
});
test('local HTTP flow enforces token, origin and host and supports inbound/outbound/status',async() => {
  const s=new EsfStore(),server=createStandServer(s);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const addr=server.address();assert(addr&&typeof addr==='object');const base=`http://127.0.0.1:${addr.port}`;
  try{const session=await (await fetch(base+'/api/session')).json() as {token:string};const headers={'x-flowpos-organization':'stand-org'};const post=(path:string,body:unknown,extra:Record<string,string>={})=>fetch(base+path,{method:'POST',headers:{...headers,'content-type':'application/json','x-flowpos-local':session.token,...extra},body:JSON.stringify(body)});
    assert.equal((await fetch(base+'/api/outbound',{method:'POST'})).status,403);assert.equal((await post('/api/outbound',{}, {origin:'https://evil.invalid'})).status,403);
    assert.equal((await post('/api/fixtures/inbound',{})).status,200);await post('/api/fixtures/inbound',{});
    const draft=await (await post('/api/outbound',{operationId:'http-op',invoice})).json() as {id:string,payloadHash:string};assert(draft.id);
    await post(`/api/documents/${draft.id}/approve`,{payloadHash:draft.payloadHash,expiresAt:Date.now()+10000,expectedVersion:1});
    assert.equal((await (await post(`/api/documents/${draft.id}/send`,{expectedVersion:2})).json() as {state:string}).state,'UNKNOWN');
    assert.equal((await (await post(`/api/documents/${draft.id}/reconcile`,{expectedVersion:4})).json() as {state:string}).state,'REGISTERED');
    assert.equal((await (await fetch(base+'/api/documents',{headers})).json() as unknown[]).length,2);assert.equal((await fetch(base+'/')).status,200);
  }finally{await new Promise<void>(r=>server.close(()=>r()));s.close();}
});
