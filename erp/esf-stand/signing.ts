/** Boundary only: this interface deliberately does not load keys or call NCALayer. */
import { DomainError, type Document } from './core.ts';
export type SigningRequest = {
  requestId: string; tenantId: string; orgId: string; documentId: string;
  payloadHash: string; schemaVersion: 'synthetic-v1'; expiresAt: number;
};
export type SyntheticSignature = { mode: 'synthetic'; request: SigningRequest; marker: 'NOT_A_LEGAL_SIGNATURE' };
export interface SigningProvider {
  readonly mode: 'synthetic';
  sign(request: Readonly<SigningRequest>): Promise<SyntheticSignature>;
}
export class SyntheticSigningProvider implements SigningProvider {
  readonly mode = 'synthetic' as const;
  async sign(request: Readonly<SigningRequest>): Promise<SyntheticSignature> {
    return {mode:'synthetic',request:{...request},marker:'NOT_A_LEGAL_SIGNATURE'};
  }
}
export function validateSyntheticSignature(document: Document, artifact: SyntheticSignature, now = Date.now()): void {
  const r = artifact?.request;
  if (artifact?.mode !== 'synthetic' || artifact?.marker !== 'NOT_A_LEGAL_SIGNATURE' || !r ||
      r.documentId !== document.id || r.tenantId !== document.tenantId || r.orgId !== document.orgId ||
      r.payloadHash !== document.payloadHash || r.schemaVersion !== 'synthetic-v1' || !r.requestId ||
      !Number.isSafeInteger(r.expiresAt) || r.expiresAt <= now || r.expiresAt > now+300_000) throw new DomainError('SIGNATURE_BINDING_MISMATCH');
}
