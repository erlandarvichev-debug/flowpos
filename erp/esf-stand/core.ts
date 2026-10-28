/** LOCAL SYNTHETIC STAND. Internal API; no official ESF wire contract is claimed. */
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { migrateLocal } from './sqliteMigrations.ts';

export type Scope = { tenantId: string; orgId: string; actorId?: string };
export type State = 'DRAFT' | 'APPROVED' | 'SENDING' | 'UNKNOWN' | 'REGISTERED' | 'REJECTED' | 'RECEIVED' | 'QUARANTINED';
export type Invoice = { number: string; amountMinor: string; currency: 'KZT' };
export type Document = Scope & { id: string; operationId: string; direction: 'IN' | 'OUT'; payload: string; payloadHash: string; state: State; externalId: string | null; revision: string; errorCode: string | null; correctionOf: string | null; version: number; schemaVersion: string; approvalExpiresAt: number | null };
export type Inbound = { externalId: string; revision: string; schemaVersion: string; xml: string; correctionOf?: string };
export type GatewayResult = { state: 'REGISTERED' | 'REJECTED' | 'UNKNOWN'; externalId?: string };
export interface EsfGateway {
  readonly mode: 'synthetic';
  send(document: Readonly<Document>): Promise<GatewayResult>;
  lookup(document: Readonly<Document>): Promise<GatewayResult>;
}
export class DomainError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}
export const digest = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const validId = (s: string) => typeof s === 'string' && /^[A-Za-z0-9._-]{1,100}$/.test(s);
function scopeCheck(scope: Scope) {
  if (!validId(scope.tenantId) || !validId(scope.orgId)) throw new DomainError('INVALID_SCOPE');
}
function canonical(input: Invoice): string {
  if (!input || typeof input!=='object' || Array.isArray(input) || Object.keys(input).some(k=>!['number','amountMinor','currency'].includes(k)) || typeof input.number !== 'string' || !input.number.trim() || input.number.length > 100 ||
      input.currency !== 'KZT' || typeof input.amountMinor !== 'string' || !/^[1-9][0-9]{0,14}$/.test(input.amountMinor)) throw new DomainError('INVALID_INVOICE');
  return JSON.stringify({ number: input.number.trim(), amountMinor: input.amountMinor, currency: input.currency });
}

export class EsfStore {
  readonly db: DatabaseSync;
  constructor(path: string = ':memory:') {
    this.db = new DatabaseSync(path);
    // Install the busy handler before journal-mode/schema work can contend with another process.
    this.db.exec('PRAGMA busy_timeout=5000');
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY, tenantId TEXT NOT NULL, orgId TEXT NOT NULL, operationId TEXT NOT NULL,
        direction TEXT NOT NULL CHECK(direction IN ('IN','OUT')), payload TEXT NOT NULL, payloadHash TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('DRAFT','APPROVED','SENDING','UNKNOWN','REGISTERED','REJECTED','RECEIVED','QUARANTINED')),
        externalId TEXT, revision TEXT NOT NULL, errorCode TEXT, correctionOf TEXT,
        UNIQUE(tenantId,orgId,operationId), UNIQUE(tenantId,orgId,direction,externalId,revision));
      CREATE TABLE IF NOT EXISTS approvals (documentId TEXT PRIMARY KEY REFERENCES documents(id), hash TEXT NOT NULL, expiresAt INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS jobs (documentId TEXT PRIMARY KEY REFERENCES documents(id), attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 1));
      CREATE TABLE IF NOT EXISTS cursors (tenantId TEXT, orgId TEXT, value TEXT NOT NULL, PRIMARY KEY(tenantId,orgId));
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, tenantId TEXT NOT NULL, orgId TEXT NOT NULL, documentId TEXT, event TEXT NOT NULL, at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);`);
    migrateLocal(this.db);
    this.recoverExpired();
  }
  /** Expired leases fence old callbacks. Active work owned by another process stays active. */
  recoverExpired(now = Date.now(),scope?:Scope) {
    if(scope)scopeCheck(scope);
    const filter=scope?' AND tenantId=? AND orgId=?':'';
    const args=scope?[now,scope.tenantId,scope.orgId]:[now];
    this.transaction(() => {
      this.db.prepare(`INSERT INTO audit(tenantId,orgId,documentId,event) SELECT tenantId,orgId,id,'RECOVERED_UNKNOWN' FROM documents WHERE state='SENDING' AND (leaseUntil IS NULL OR leaseUntil<=?)${filter}`).run(...args);
      this.db.prepare(`UPDATE documents SET state='UNKNOWN',errorCode='RECOVERED_UNKNOWN',leaseToken=NULL,leaseUntil=NULL,version=version+1 WHERE state='SENDING' AND (leaseUntil IS NULL OR leaseUntil<=?)${filter}`).run(...args);
      this.db.prepare(`UPDATE documents SET leaseToken=NULL,leaseUntil=NULL WHERE state='UNKNOWN' AND leaseUntil<=?${filter}`).run(...args);
    });
  }
  close() { this.db.close(); }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private audit(scope: Scope, id: string | null, event: string) {
    this.db.prepare('INSERT INTO audit(tenantId,orgId,documentId,event,actorId) VALUES(?,?,?,?,?)').run(scope.tenantId, scope.orgId, id, event,scope.actorId ?? 'system-fixture');
  }
  get(scope: Scope, id: string): Document {
    scopeCheck(scope);
    const row = this.db.prepare('SELECT d.*,a.expiresAt AS approvalExpiresAt FROM documents d LEFT JOIN approvals a ON a.documentId=d.id WHERE d.tenantId=? AND d.orgId=? AND d.id=?').get(scope.tenantId, scope.orgId, id);
    if (!row) throw new DomainError('NOT_FOUND');
    return row as unknown as Document;
  }
  list(scope: Scope): Document[] {
    scopeCheck(scope);
    return this.db.prepare('SELECT d.*,a.expiresAt AS approvalExpiresAt FROM documents d LEFT JOIN approvals a ON a.documentId=d.id WHERE d.tenantId=? AND d.orgId=? ORDER BY d.rowid DESC LIMIT 200').all(scope.tenantId, scope.orgId) as unknown as Document[];
  }
  create(scope: Scope, operationId: string, input: Invoice): Document {
    scopeCheck(scope);
    if (!validId(operationId)) throw new DomainError('INVALID_OPERATION');
    const payload = canonical(input), hash = digest(payload);
    return this.transaction(() => {
      const old = this.db.prepare('SELECT * FROM documents WHERE tenantId=? AND orgId=? AND operationId=?').get(scope.tenantId, scope.orgId, operationId) as unknown as Document | undefined;
      if (old) { if (old.direction !== 'OUT' || old.payloadHash !== hash) throw new DomainError('IDEMPOTENCY_CONFLICT'); return this.get(scope,old.id); }
      const id = randomUUID();
      this.db.prepare(`INSERT INTO documents(id,tenantId,orgId,operationId,direction,payload,payloadHash,state,externalId,revision,errorCode,correctionOf) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,scope.tenantId,scope.orgId,operationId,'OUT',payload,hash,'DRAFT',null,'1',null,null);
      this.db.prepare('INSERT INTO jobs(documentId,tenantId,orgId) VALUES(?,?,?)').run(id,scope.tenantId,scope.orgId);
      this.audit(scope,id,'DRAFT_CREATED');
      return this.get(scope,id);
    });
  }
  approve(scope: Scope, id: string, hash: string, expiresAt: number, now = Date.now(), expectedVersion?: number): Document {
    return this.transaction(() => {
      const d = this.get(scope,id);
      if (expectedVersion !== undefined && expectedVersion !== d.version) throw new DomainError('VERSION_CONFLICT');
      if (d.state !== 'DRAFT') throw new DomainError('INVALID_STATE');
      if (d.payloadHash !== hash || !Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + 300_000) throw new DomainError('STALE_APPROVAL');
      this.db.prepare('INSERT INTO approvals(documentId,tenantId,orgId,hash,expiresAt,documentVersion,approvedBy) VALUES(?,?,?,?,?,?,?)').run(id,scope.tenantId,scope.orgId,hash,expiresAt,d.version+1,scope.actorId ?? 'system-fixture');
      this.db.prepare("UPDATE documents SET state='APPROVED',version=version+1,errorCode=NULL WHERE id=?").run(id);
      this.audit(scope,id,'SYNTHETIC_APPROVAL');
      return this.get(scope,id);
    });
  }
  resetExpiredApproval(scope: Scope,id: string,expectedVersion: number,now=Date.now()): Document {
    return this.transaction(()=>{
      const d=this.get(scope,id);
      if(d.version!==expectedVersion)throw new DomainError('VERSION_CONFLICT');
      if(d.state!=='APPROVED' || d.approvalExpiresAt===null || d.approvalExpiresAt>now)throw new DomainError('INVALID_STATE');
      this.db.prepare('DELETE FROM approvals WHERE documentId=?').run(id);
      this.db.prepare("UPDATE documents SET state='DRAFT',version=version+1,errorCode='APPROVAL_EXPIRED' WHERE id=?").run(id);
      this.audit(scope,id,'EXPIRED_APPROVAL_RESET');return this.get(scope,id);
    });
  }
  async send(scope: Scope, id: string, gateway: EsfGateway, now = Date.now(), expectedVersion?: number): Promise<Document> {
    if (gateway.mode !== 'synthetic') throw new DomainError('CONTRACT_UNVERIFIED');
    this.recoverExpired(now,scope);
    const token=randomUUID();
    const d = this.transaction(() => {
      const current = this.get(scope,id);
      if (['UNKNOWN','SENDING','REGISTERED','REJECTED'].includes(current.state)) return null;
      if (expectedVersion !== undefined && expectedVersion !== current.version) throw new DomainError('VERSION_CONFLICT');
      if (current.state !== 'APPROVED') throw new DomainError('APPROVAL_REQUIRED');
      const a = this.db.prepare('SELECT * FROM approvals WHERE documentId=?').get(id);
      if (!a || a.consumed !== 0 || a.hash !== current.payloadHash || a.documentVersion !== current.version || Number(a.expiresAt) <= now || digest(current.payload) !== current.payloadHash) throw new DomainError('STALE_APPROVAL');
      this.db.prepare('UPDATE approvals SET consumed=1 WHERE documentId=?').run(id);
      const claimed=this.db.prepare('UPDATE jobs SET attempts=1 WHERE documentId=? AND attempts=0').run(id);
      if(claimed.changes!==1)throw new DomainError('ATTEMPT_ALREADY_CLAIMED');
      this.db.prepare("UPDATE documents SET state='SENDING',version=version+1,leaseToken=?,leaseUntil=? WHERE id=?").run(token,now+60_000,id);
      this.audit(scope,id,'SYNTHETIC_SEND_STARTED');
      return current;
    });
    if (!d) return this.get(scope,id);
    let result: GatewayResult;
    try { result = await gateway.send(Object.freeze(d)); } catch { result = { state:'UNKNOWN' }; }
    return this.applyResult(scope,id,result,token);
  }
  private applyResult(scope: Scope, id: string, result: GatewayResult, token: string): Document {
    this.recoverExpired(Date.now(),scope);
    return this.transaction(() => {
      const d = this.get(scope,id);
      const lease=this.db.prepare('SELECT leaseToken,leaseUntil FROM documents WHERE id=?').get(id)!;
      if (!['SENDING','UNKNOWN'].includes(d.state) || lease.leaseToken!==token || Number(lease.leaseUntil)<=Date.now()) return d;
      const valid = ['REGISTERED','REJECTED','UNKNOWN'].includes(result?.state) && (result.state !== 'REGISTERED' || (typeof result.externalId === 'string' && validId(result.externalId)));
      const state = valid ? result.state : 'UNKNOWN';
      const remoteId = state === 'REGISTERED' ? result.externalId! : d.externalId;
      this.db.prepare('UPDATE documents SET state=?,externalId=?,errorCode=?,version=version+1,leaseToken=NULL,leaseUntil=NULL WHERE id=?').run(state,remoteId,state === 'UNKNOWN' ? 'OUTCOME_UNKNOWN' : state === 'REJECTED' ? 'REMOTE_REJECTED' : null,id);
      this.audit(scope,id,`SYNTHETIC_${state}`);
      return this.get(scope,id);
    });
  }
  async reconcile(scope: Scope, id: string, gateway: EsfGateway,expectedVersion?: number): Promise<Document> {
    if (gateway.mode !== 'synthetic') throw new DomainError('CONTRACT_UNVERIFIED');
    this.recoverExpired(Date.now(),scope);const token=randomUUID();
    const d=this.transaction(()=>{
      const current=this.get(scope,id);
      if(current.state!=='UNKNOWN')throw new DomainError('INVALID_STATE');
      const lease=this.db.prepare('SELECT leaseUntil FROM documents WHERE id=?').get(id)!;
      if(Number(lease.leaseUntil)>Date.now())return null;
      if(expectedVersion!==undefined && current.version!==expectedVersion)throw new DomainError('VERSION_CONFLICT');
      this.db.prepare('UPDATE documents SET leaseToken=?,leaseUntil=? WHERE id=?').run(token,Date.now()+60_000,id);
      this.audit(scope,id,'RECONCILE_STARTED');return current;
    });
    if(!d)return this.get(scope,id);
    let result: GatewayResult;
    try { result = await gateway.lookup(Object.freeze(d)); } catch { result = {state:'UNKNOWN'}; }
    return this.applyResult(scope,id,result,token);
  }
  ingest(scope: Scope, invoices: Inbound[], cursor: string, beforeCursor?: () => void): Document[] {
    scopeCheck(scope);
    if (!Array.isArray(invoices) || invoices.length > 100 || !validId(cursor)) throw new DomainError('INVALID_BATCH');
    return this.transaction(() => {
      const output: Document[] = [];
      for (const i of invoices) {
        if (!i || !validId(i.externalId) || !validId(i.revision) || typeof i.xml !== 'string' || Buffer.byteLength(i.xml) > 64_000 || typeof i.schemaVersion !== 'string') throw new DomainError('INVALID_INBOUND');
        const hash = digest(i.xml);
        const old = this.db.prepare("SELECT * FROM documents WHERE tenantId=? AND orgId=? AND direction='IN' AND externalId=? AND revision=?").get(scope.tenantId,scope.orgId,i.externalId,i.revision) as unknown as Document | undefined;
        if (old) { if (old.payloadHash !== hash) throw new DomainError('REMOTE_ID_CONFLICT'); output.push(old); continue; }
        const id = randomUUID();
        const supported = i.schemaVersion === 'synthetic-v1' && !/<!DOCTYPE|<!ENTITY/i.test(i.xml);
        this.db.prepare('INSERT INTO documents(id,tenantId,orgId,operationId,direction,payload,payloadHash,state,externalId,revision,errorCode,correctionOf,schemaVersion) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,scope.tenantId,scope.orgId,`in-${id}`,'IN',i.xml,hash,supported ? 'RECEIVED' : 'QUARANTINED',i.externalId,i.revision,supported ? null : 'SCHEMA_UNSUPPORTED',i.correctionOf ?? null,i.schemaVersion);
        this.audit(scope,id,supported ? 'RECEIVED_NO_ACCOUNTING_EFFECT' : 'QUARANTINED');
        output.push(this.get(scope,id));
      }
      beforeCursor?.(); // fault injection proves documents and cursor commit together
      this.db.prepare('INSERT INTO cursors VALUES(?,?,?) ON CONFLICT(tenantId,orgId) DO UPDATE SET value=excluded.value').run(scope.tenantId,scope.orgId,cursor);
      this.audit(scope,null,'CURSOR_COMMITTED');
      return output;
    });
  }
}

export class SyntheticGateway implements EsfGateway {
  readonly mode = 'synthetic' as const;
  sends = 0;
  outcome: GatewayResult['state'];
  constructor(outcome: GatewayResult['state'] = 'UNKNOWN') { this.outcome = outcome; }
  async send(d: Readonly<Document>): Promise<GatewayResult> { this.sends++; return {state:this.outcome,externalId:`stand-${d.id}`}; }
  async lookup(d: Readonly<Document>): Promise<GatewayResult> { return {state:'REGISTERED',externalId:`stand-${d.id}`}; }
}
