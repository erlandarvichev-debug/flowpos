import type { IncomingMessage } from 'node:http';
import { DomainError, EsfStore, type Document, type EsfGateway, type Invoice, type Scope } from './core.ts';

export type Action='read'|'draft'|'approve'|'send'|'reconcile'|'ingest';
export type Principal=Readonly<{subject:string;tenantId:string;enabled:boolean;expiresAt:number;grants:ReadonlyArray<Readonly<{orgId:string;actions:readonly Action[]}>>}>;
/** Authentication source only. Request scope/headers do not establish identity or grants. */
export interface AuthProvider { authenticate(request: IncomingMessage): Promise<Principal|null> }
export class FixtureAuthProvider implements AuthProvider {
  private readonly principal: Principal;
  constructor(principal: Principal=fixturePrincipal()) {
    this.principal=Object.freeze({...principal,grants:Object.freeze(principal.grants.map(g=>Object.freeze({...g,actions:Object.freeze([...g.actions])})))});
  }
  async authenticate(_request: IncomingMessage): Promise<Principal> { return this.principal; }
}
export function fixturePrincipal(): Principal {
  return {subject:'local-fixture-operator',tenantId:'stand-tenant',enabled:true,expiresAt:Date.now()+8*60*60_000,
    grants:[{orgId:'stand-org',actions:['read','draft','approve','send','reconcile','ingest']},{orgId:'stand-org-b',actions:['read']}]};
}
export function authorize(principal: Principal|null,organization: unknown,action: Action): Scope {
  if(!principal || !principal.enabled || !Number.isSafeInteger(principal.expiresAt) || principal.expiresAt<=Date.now())throw new DomainError('UNAUTHENTICATED');
  if(typeof organization!=='string' || !/^[A-Za-z0-9._-]{1,100}$/.test(organization))throw new DomainError('ORGANIZATION_REQUIRED');
  if(!principal.grants.some(g=>g.orgId===organization && g.actions.includes(action)))throw new DomainError('ACCESS_DENIED');
  return {tenantId:principal.tenantId,orgId:organization,actorId:principal.subject};
}
function publicDocument(d: Document) {
  // Internal lease tokens never leave the application boundary.
  return {id:d.id,tenantId:d.tenantId,orgId:d.orgId,operationId:d.operationId,direction:d.direction,payload:d.payload,payloadHash:d.payloadHash,state:d.state,externalId:d.externalId,revision:d.revision,errorCode:d.errorCode,correctionOf:d.correctionOf,version:d.version,schemaVersion:d.schemaVersion,approvalExpiresAt:d.approvalExpiresAt};
}
function version(value: unknown): number {
  if(typeof value!=='number'||!Number.isSafeInteger(value)||value<1)throw new DomainError('EXPECTED_VERSION_REQUIRED');return value;
}
export class EsfApplication {
  constructor(privateStore: EsfStore,privateGateway: EsfGateway) { this.store=privateStore;this.gateway=privateGateway; }
  private readonly store: EsfStore;
  private readonly gateway: EsfGateway;
  list(p: Principal|null,org: unknown) {const scope=authorize(p,org,'read');if(p!.grants.some(g=>g.orgId===org&&g.actions.includes('reconcile')))this.store.recoverExpired(Date.now(),scope);return this.store.list(scope).map(publicDocument);}
  get(p: Principal|null,org: unknown,id:string) {return publicDocument(this.store.get(authorize(p,org,'read'),id));}
  create(p: Principal|null,org: unknown,operation:string,invoice:Invoice) {return publicDocument(this.store.create(authorize(p,org,'draft'),operation,invoice));}
  approve(p:Principal|null,org:unknown,id:string,hash:string,expires:number,expected:unknown) {return publicDocument(this.store.approve(authorize(p,org,'approve'),id,hash,expires,Date.now(),version(expected)));}
  resetApproval(p:Principal|null,org:unknown,id:string,expected:unknown) {return publicDocument(this.store.resetExpiredApproval(authorize(p,org,'approve'),id,version(expected)));}
  async send(p:Principal|null,org:unknown,id:string,expected:unknown) {return publicDocument(await this.store.send(authorize(p,org,'send'),id,this.gateway,Date.now(),version(expected)));}
  async reconcile(p:Principal|null,org:unknown,id:string,expected:unknown) {return publicDocument(await this.store.reconcile(authorize(p,org,'reconcile'),id,this.gateway,version(expected)));}
  ingest(p:Principal|null,org:unknown,fixture:unknown) {
    const scope=authorize(p,org,'ingest');
    if(fixture!==undefined && fixture!=='standard' && fixture!=='unsupported')throw new DomainError('INVALID_FIXTURE');
    const unsupported=fixture==='unsupported';
    return this.store.ingest(scope,[{externalId:unsupported?'SYNTHETIC-UNSUPPORTED':'SYNTHETIC-001',revision:'1',schemaVersion:unsupported?'unverified-form-v2':'synthetic-v1',xml:unsupported?'<UnknownForm field="preserved"/>':'<SyntheticInvoice number="TEST-001" amountMinor="100000" />'}],unsupported?'fixture-unsupported':'fixture-1').map(publicDocument);
  }
}
