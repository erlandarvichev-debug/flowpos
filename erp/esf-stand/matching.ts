/**
 * FP-014: match counterparty lines and the document basis of a received ESF
 * to our catalog and contracts. Metadata only: no stock receipt, no ledger or
 * VAT entry is created here; those are separate commands with their own rights.
 */
import { DomainError, digest, type EsfStore, type Scope, type Document } from './core.ts';

export type MatchStatus = 'AUTO_MATCHED' | 'REVIEW_REQUIRED' | 'UNMATCHED' | 'MANUAL';
export type LineMethod = 'COUNTERPARTY_CODE' | 'BARCODE' | 'NAME' | 'NONE' | 'MANUAL';
export type BasisMethod = 'LOOKUP' | 'NONE' | 'MANUAL';

export type NormalizedLine = { lineNo: number; sellerCode?: string; barcode?: string; name: string; unit: string; quantity: string };
export type BasisRef = { kind: 'CONTRACT' | 'SUPPLY' | 'ORDER' | 'OTHER'; number: string; date: string };
export type NormalizedInbound = { counterpartyBin: string; lines: NormalizedLine[]; basis?: BasisRef };

export type CatalogItem = { itemId: string; name: string; unit: string };
export type BasisCandidate = { basisId: string; kind: BasisRef['kind']; number: string; date: string };

/** Narrow port until FP-025 (catalog) exists. Implementations must scope by tenant+org. */
export interface CatalogLookup {
  getItem(scope: Scope, itemId: string): CatalogItem | null;
  findByBarcode(scope: Scope, barcode: string): CatalogItem[];
  searchByName(scope: Scope, name: string): CatalogItem[];
}
export interface BasisLookup {
  get(scope: Scope, basisId: string): BasisCandidate | null;
  find(scope: Scope, counterpartyBin: string, ref: BasisRef): BasisCandidate[];
}

export type LineMatch = Required<Pick<NormalizedLine, 'lineNo' | 'name' | 'unit' | 'quantity'>> & {
  sellerCode: string | null; barcode: string | null; itemId: string | null; method: LineMethod;
  confidence: number; status: MatchStatus; candidates: string[]; version: number;
  decidedBy: string; reason: string | null; inheritedFrom: string | null;
};
export type BasisMatch = {
  basisId: string | null; method: BasisMethod; confidence: number; status: MatchStatus; candidates: string[];
  version: number; decidedBy: string; reason: string | null; inheritedFrom: string | null;
};
export type MatchSummary = {
  documentId: string; lines: number; decided: number; needsReview: number;
  basisStatus: MatchStatus | null; readyForReceiptCommand: boolean; accountingEffect: 'NONE';
};
export type ChainLink = { documentId: string; externalId: string | null; revision: string; correctionOf: string | null };

const SYSTEM_ACTOR = 'system-matcher';
const MAX_LINES = 1000;
const text = (v: unknown, max: number) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const optText = (v: unknown, max: number) => v === undefined || v === null || text(v, max);
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

function validateInput(input: NormalizedInbound): void {
  if (!input || !/^\d{12}$/.test(input.counterpartyBin ?? '')) throw new DomainError('INVALID_COUNTERPARTY_BIN');
  if (!Array.isArray(input.lines) || input.lines.length === 0 || input.lines.length > MAX_LINES) throw new DomainError('INVALID_LINES');
  const seen = new Set<number>();
  for (const l of input.lines) {
    if (!l || !Number.isInteger(l.lineNo) || l.lineNo < 1 || seen.has(l.lineNo)) throw new DomainError('INVALID_LINE_NO');
    seen.add(l.lineNo);
    if (!text(l.name, 500) || !text(l.unit, 50) || !optText(l.sellerCode, 100) || !optText(l.barcode, 50)) throw new DomainError('INVALID_LINE');
    if (typeof l.quantity !== 'string' || !/^\d{1,12}(\.\d{1,6})?$/.test(l.quantity)) throw new DomainError('INVALID_QUANTITY');
  }
  const b = input.basis;
  if (b !== undefined && (!b || !['CONTRACT', 'SUPPLY', 'ORDER', 'OTHER'].includes(b.kind) || !text(b.number, 100) || !/^\d{4}-\d{2}-\d{2}$/.test(b.date ?? ''))) {
    throw new DomainError('INVALID_BASIS');
  }
}

/** Same counterparty line → same identity; quantity/price may legitimately change in a correction. */
const lineIdentity = (l: { sellerCode?: string | null; barcode?: string | null; name: string; unit: string }) =>
  JSON.stringify([l.sellerCode?.trim() ?? null, l.barcode?.trim() ?? null, norm(l.name), norm(l.unit)]);

export class EsfMatchingService {
  private readonly store: EsfStore;
  private readonly catalog: CatalogLookup;
  private readonly bases: BasisLookup;

  constructor(store: EsfStore, catalog: CatalogLookup, bases: BasisLookup) {
    this.store = store;
    this.catalog = catalog;
    this.bases = bases;
  }

  private get db() { return this.store.db; }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); this.db.exec('COMMIT'); return r; } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  private audit(scope: Scope, documentId: string, event: string, actorId: string) {
    this.db.prepare('INSERT INTO audit(tenantId,orgId,documentId,event,actorId) VALUES(?,?,?,?,?)').run(scope.tenantId, scope.orgId, documentId, event, actorId);
  }

  private history(scope: Scope, documentId: string, target: string, from: { ref: string | null; status: string | null }, to: { ref: string | null; status: string }, actorId: string, reason: string | null) {
    this.db.prepare('INSERT INTO esf_match_history(tenantId,orgId,documentId,target,fromRef,toRef,fromStatus,toStatus,actorId,reason) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(scope.tenantId, scope.orgId, documentId, target, from.ref, to.ref, from.status, to.status, actorId, reason);
  }

  private matchableDocument(scope: Scope, documentId: string): Document {
    const d = this.store.get(scope, documentId);
    if (d.direction !== 'IN' || d.state !== 'RECEIVED') throw new DomainError('MATCH_NOT_ALLOWED');
    return d;
  }

  private findOriginal(scope: Scope, d: Document): Document | null {
    if (!d.correctionOf) return null;
    const row = this.db.prepare("SELECT * FROM documents WHERE tenantId=? AND orgId=? AND direction='IN' AND externalId=? AND id<>? ORDER BY rowid DESC LIMIT 1")
      .get(scope.tenantId, scope.orgId, d.correctionOf, d.id);
    return (row as unknown as Document) ?? null;
  }

  private autoMatchLine(scope: Scope, bin: string, l: NormalizedLine): Omit<LineMatch, 'version' | 'reason' | 'inheritedFrom' | 'decidedBy'> {
    const base = { lineNo: l.lineNo, sellerCode: l.sellerCode?.trim() ?? null, barcode: l.barcode?.trim() ?? null, name: l.name, unit: l.unit, quantity: l.quantity };
    const unitOk = (item: CatalogItem) => norm(item.unit) === norm(l.unit);

    if (base.sellerCode) {
      const learned = this.db.prepare('SELECT itemId FROM esf_counterparty_item_map WHERE tenantId=? AND orgId=? AND counterpartyBin=? AND sellerCode=?')
        .get(scope.tenantId, scope.orgId, bin, base.sellerCode) as { itemId: string } | undefined;
      const item = learned && this.catalog.getItem(scope, learned.itemId);
      if (item) {
        return unitOk(item)
          ? { ...base, itemId: item.itemId, method: 'COUNTERPARTY_CODE', confidence: 1, status: 'AUTO_MATCHED', candidates: [item.itemId] }
          : { ...base, itemId: item.itemId, method: 'COUNTERPARTY_CODE', confidence: 0.5, status: 'REVIEW_REQUIRED', candidates: [item.itemId] };
      }
    }
    if (base.barcode) {
      const hits = this.catalog.findByBarcode(scope, base.barcode);
      if (hits.length === 1) {
        return unitOk(hits[0])
          ? { ...base, itemId: hits[0].itemId, method: 'BARCODE', confidence: 0.9, status: 'AUTO_MATCHED', candidates: [hits[0].itemId] }
          : { ...base, itemId: hits[0].itemId, method: 'BARCODE', confidence: 0.45, status: 'REVIEW_REQUIRED', candidates: [hits[0].itemId] };
      }
      if (hits.length > 1) {
        return { ...base, itemId: null, method: 'BARCODE', confidence: 0, status: 'REVIEW_REQUIRED', candidates: hits.slice(0, 20).map((h) => h.itemId) };
      }
    }
    const byName = this.catalog.searchByName(scope, l.name);
    if (byName.length === 1) {
      // A name alone is never trusted enough to auto-decide.
      return { ...base, itemId: byName[0].itemId, method: 'NAME', confidence: unitOk(byName[0]) ? 0.6 : 0.3, status: 'REVIEW_REQUIRED', candidates: [byName[0].itemId] };
    }
    if (byName.length > 1) {
      return { ...base, itemId: null, method: 'NAME', confidence: 0, status: 'REVIEW_REQUIRED', candidates: byName.slice(0, 20).map((h) => h.itemId) };
    }
    return { ...base, itemId: null, method: 'NONE', confidence: 0, status: 'UNMATCHED', candidates: [] };
  }

  private autoMatchBasis(scope: Scope, bin: string, ref: BasisRef | undefined): Omit<BasisMatch, 'version' | 'reason' | 'inheritedFrom' | 'decidedBy'> {
    if (!ref) return { basisId: null, method: 'NONE', confidence: 0, status: 'UNMATCHED', candidates: [] };
    const hits = this.bases.find(scope, bin, ref);
    if (hits.length === 1) return { basisId: hits[0].basisId, method: 'LOOKUP', confidence: 0.9, status: 'AUTO_MATCHED', candidates: [hits[0].basisId] };
    if (hits.length > 1) return { basisId: null, method: 'LOOKUP', confidence: 0, status: 'REVIEW_REQUIRED', candidates: hits.slice(0, 20).map((h) => h.basisId) };
    return { basisId: null, method: 'NONE', confidence: 0, status: 'UNMATCHED', candidates: [] };
  }

  /**
   * Proposes matches for a received document. Idempotent for the same input;
   * a different input for an already-matched document is a conflict.
   * A correction inherits decisions for lines/basis that did not change; the original is never modified.
   */
  match(scope: Scope, documentId: string, input: NormalizedInbound): MatchSummary {
    validateInput(input);
    const d = this.matchableDocument(scope, documentId);
    const inputHash = digest(JSON.stringify(input));
    const existing = this.db.prepare('SELECT inputHash FROM esf_match_input WHERE tenantId=? AND orgId=? AND documentId=?').get(scope.tenantId, scope.orgId, d.id) as { inputHash: string } | undefined;
    if (existing) {
      if (existing.inputHash !== inputHash) throw new DomainError('MATCH_INPUT_CONFLICT');
      return this.summary(scope, d.id);
    }

    const original = this.findOriginal(scope, d);
    const origInput = original && this.db.prepare('SELECT * FROM esf_match_input WHERE tenantId=? AND orgId=? AND documentId=?').get(scope.tenantId, scope.orgId, original.id) as Record<string, string | null> | undefined;
    const inheritFrom = origInput && origInput.counterpartyBin === input.counterpartyBin ? original : null;
    const origLines = new Map<number, LineMatch>();
    if (inheritFrom) for (const l of this.lines(scope, inheritFrom.id)) origLines.set(l.lineNo, l);
    const origBasis = inheritFrom ? this.basis(scope, inheritFrom.id) : null;
    const sameBasisRef = !!(inheritFrom && input.basis && origInput!.basisKind === input.basis.kind && origInput!.basisNumber === input.basis.number && origInput!.basisDate === input.basis.date);

    // Catalog/basis lookups run before the write transaction; they are read-only.
    const lines = input.lines.map((l) => {
      const prev = origLines.get(l.lineNo);
      const prevDecided = prev && (prev.status === 'MANUAL' || prev.status === 'AUTO_MATCHED');
      if (prev && prevDecided && lineIdentity(prev) === lineIdentity(l)) {
        return { ...prev, quantity: l.quantity, name: l.name, unit: l.unit, inheritedFrom: inheritFrom!.id, decidedBy: prev.decidedBy, reason: prev.reason };
      }
      return { ...this.autoMatchLine(scope, input.counterpartyBin, l), inheritedFrom: null, decidedBy: SYSTEM_ACTOR, reason: null };
    });
    const basis = sameBasisRef && origBasis && (origBasis.status === 'MANUAL' || origBasis.status === 'AUTO_MATCHED')
      ? { ...origBasis, inheritedFrom: inheritFrom!.id }
      : { ...this.autoMatchBasis(scope, input.counterpartyBin, input.basis), inheritedFrom: null, decidedBy: SYSTEM_ACTOR, reason: null };

    return this.tx(() => {
      const again = this.db.prepare('SELECT inputHash FROM esf_match_input WHERE tenantId=? AND orgId=? AND documentId=?').get(scope.tenantId, scope.orgId, d.id) as { inputHash: string } | undefined;
      if (again) {
        if (again.inputHash !== inputHash) throw new DomainError('MATCH_INPUT_CONFLICT');
        return this.summary(scope, d.id);
      }
      this.db.prepare('INSERT INTO esf_match_input(documentId,tenantId,orgId,counterpartyBin,inputHash,inheritedFrom,basisKind,basisNumber,basisDate) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(d.id, scope.tenantId, scope.orgId, input.counterpartyBin, inputHash, inheritFrom?.id ?? null, input.basis?.kind ?? null, input.basis?.number ?? null, input.basis?.date ?? null);
      const ins = this.db.prepare('INSERT INTO esf_match_line(documentId,tenantId,orgId,lineNo,sellerCode,barcode,name,unit,quantity,itemId,method,confidence,status,candidates,decidedBy,reason,inheritedFrom) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
      for (const l of lines) {
        ins.run(d.id, scope.tenantId, scope.orgId, l.lineNo, l.sellerCode, l.barcode, l.name, l.unit, l.quantity, l.itemId, l.method, l.confidence, l.status, JSON.stringify(l.candidates), l.decidedBy, l.reason, l.inheritedFrom);
        this.history(scope, d.id, `LINE:${l.lineNo}`, { ref: null, status: null }, { ref: l.itemId, status: l.status }, SYSTEM_ACTOR, l.inheritedFrom ? `inherited from ${l.inheritedFrom}` : `auto:${l.method}`);
      }
      this.db.prepare('INSERT INTO esf_match_basis(documentId,tenantId,orgId,basisId,method,confidence,status,candidates,decidedBy,reason,inheritedFrom) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(d.id, scope.tenantId, scope.orgId, basis.basisId, basis.method, basis.confidence, basis.status, JSON.stringify(basis.candidates), basis.decidedBy, basis.reason, basis.inheritedFrom);
      this.history(scope, d.id, 'BASIS', { ref: null, status: null }, { ref: basis.basisId, status: basis.status }, SYSTEM_ACTOR, basis.inheritedFrom ? `inherited from ${basis.inheritedFrom}` : `auto:${basis.method}`);
      this.audit(scope, d.id, inheritFrom ? 'MATCH_PROPOSED_FROM_CORRECTION_CHAIN' : 'MATCH_PROPOSED', SYSTEM_ACTOR);
      return this.summary(scope, d.id);
    });
  }

  private requireHuman(scope: Scope, reason: string): string {
    const actor = scope.actorId;
    if (!actor || !text(actor, 100) || actor === 'system-fixture' || actor === SYSTEM_ACTOR) throw new DomainError('ACTOR_REQUIRED');
    if (!text(reason, 500) || reason.trim().length < 3) throw new DomainError('REASON_REQUIRED');
    return actor;
  }

  /** Manual decision for one line. itemId=null records an explicit "no catalog item" decision. */
  overrideLine(scope: Scope, cmd: { documentId: string; lineNo: number; itemId: string | null; reason: string; expectedVersion: number; remember?: boolean }): LineMatch {
    const actor = this.requireHuman(scope, cmd.reason);
    this.matchableDocument(scope, cmd.documentId);
    if (cmd.itemId !== null && !this.catalog.getItem(scope, cmd.itemId)) throw new DomainError('UNKNOWN_ITEM');
    return this.tx(() => {
      const cur = this.lines(scope, cmd.documentId).find((l) => l.lineNo === cmd.lineNo);
      if (!cur) throw new DomainError('NOT_FOUND');
      if (cur.version !== cmd.expectedVersion) throw new DomainError('VERSION_CONFLICT');
      if (cmd.remember && (cmd.itemId === null || !cur.sellerCode)) throw new DomainError('REMEMBER_REQUIRES_ITEM_AND_SELLER_CODE');
      this.db.prepare("UPDATE esf_match_line SET itemId=?,method='MANUAL',confidence=1,status='MANUAL',decidedBy=?,reason=?,inheritedFrom=NULL,version=version+1 WHERE tenantId=? AND orgId=? AND documentId=? AND lineNo=?")
        .run(cmd.itemId, actor, cmd.reason.trim(), scope.tenantId, scope.orgId, cmd.documentId, cmd.lineNo);
      this.history(scope, cmd.documentId, `LINE:${cmd.lineNo}`, { ref: cur.itemId, status: cur.status }, { ref: cmd.itemId, status: 'MANUAL' }, actor, cmd.reason.trim());
      this.audit(scope, cmd.documentId, 'MATCH_LINE_OVERRIDE', actor);
      if (cmd.remember) {
        const bin = (this.db.prepare('SELECT counterpartyBin FROM esf_match_input WHERE tenantId=? AND orgId=? AND documentId=?').get(scope.tenantId, scope.orgId, cmd.documentId) as { counterpartyBin: string }).counterpartyBin;
        this.db.prepare('INSERT INTO esf_counterparty_item_map(tenantId,orgId,counterpartyBin,sellerCode,itemId,learnedBy,learnedFrom) VALUES(?,?,?,?,?,?,?) ON CONFLICT(tenantId,orgId,counterpartyBin,sellerCode) DO UPDATE SET itemId=excluded.itemId,learnedBy=excluded.learnedBy,learnedFrom=excluded.learnedFrom')
          .run(scope.tenantId, scope.orgId, bin, cur.sellerCode, cmd.itemId, actor, cmd.documentId);
        this.history(scope, cmd.documentId, `MAP:${bin}:${cur.sellerCode}`, { ref: null, status: null }, { ref: cmd.itemId, status: 'LEARNED' }, actor, cmd.reason.trim());
        this.audit(scope, cmd.documentId, 'COUNTERPARTY_MAP_LEARNED', actor);
      }
      return this.lines(scope, cmd.documentId).find((l) => l.lineNo === cmd.lineNo)!;
    });
  }

  overrideBasis(scope: Scope, cmd: { documentId: string; basisId: string | null; reason: string; expectedVersion: number }): BasisMatch {
    const actor = this.requireHuman(scope, cmd.reason);
    this.matchableDocument(scope, cmd.documentId);
    if (cmd.basisId !== null && !this.bases.get(scope, cmd.basisId)) throw new DomainError('UNKNOWN_BASIS');
    return this.tx(() => {
      const cur = this.basis(scope, cmd.documentId);
      if (!cur) throw new DomainError('NOT_FOUND');
      if (cur.version !== cmd.expectedVersion) throw new DomainError('VERSION_CONFLICT');
      this.db.prepare("UPDATE esf_match_basis SET basisId=?,method='MANUAL',confidence=1,status='MANUAL',decidedBy=?,reason=?,inheritedFrom=NULL,version=version+1 WHERE tenantId=? AND orgId=? AND documentId=?")
        .run(cmd.basisId, actor, cmd.reason.trim(), scope.tenantId, scope.orgId, cmd.documentId);
      this.history(scope, cmd.documentId, 'BASIS', { ref: cur.basisId, status: cur.status }, { ref: cmd.basisId, status: 'MANUAL' }, actor, cmd.reason.trim());
      this.audit(scope, cmd.documentId, 'MATCH_BASIS_OVERRIDE', actor);
      return this.basis(scope, cmd.documentId)!;
    });
  }

  lines(scope: Scope, documentId: string): LineMatch[] {
    this.store.get(scope, documentId);
    const rows = this.db.prepare('SELECT * FROM esf_match_line WHERE tenantId=? AND orgId=? AND documentId=? ORDER BY lineNo').all(scope.tenantId, scope.orgId, documentId) as Record<string, unknown>[];
    return rows.map((r) => ({
      lineNo: Number(r.lineNo), sellerCode: r.sellerCode as string | null, barcode: r.barcode as string | null, name: String(r.name), unit: String(r.unit),
      quantity: String(r.quantity), itemId: r.itemId as string | null, method: r.method as LineMethod, confidence: Number(r.confidence),
      status: r.status as MatchStatus, candidates: JSON.parse(String(r.candidates)), version: Number(r.version),
      decidedBy: String(r.decidedBy), reason: r.reason as string | null, inheritedFrom: r.inheritedFrom as string | null,
    }));
  }

  basis(scope: Scope, documentId: string): BasisMatch | null {
    this.store.get(scope, documentId);
    const r = this.db.prepare('SELECT * FROM esf_match_basis WHERE tenantId=? AND orgId=? AND documentId=?').get(scope.tenantId, scope.orgId, documentId) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      basisId: r.basisId as string | null, method: r.method as BasisMethod, confidence: Number(r.confidence), status: r.status as MatchStatus,
      candidates: JSON.parse(String(r.candidates)), version: Number(r.version), decidedBy: String(r.decidedBy),
      reason: r.reason as string | null, inheritedFrom: r.inheritedFrom as string | null,
    };
  }

  historyOf(scope: Scope, documentId: string): Array<{ target: string; fromRef: string | null; toRef: string | null; fromStatus: string | null; toStatus: string; actorId: string; reason: string | null }> {
    this.store.get(scope, documentId);
    return this.db.prepare('SELECT target,fromRef,toRef,fromStatus,toStatus,actorId,reason FROM esf_match_history WHERE tenantId=? AND orgId=? AND documentId=? ORDER BY id')
      .all(scope.tenantId, scope.orgId, documentId) as never;
  }

  /** "Ready" only means every line and the basis have a decision; it creates nothing. */
  summary(scope: Scope, documentId: string): MatchSummary {
    const lines = this.lines(scope, documentId);
    const basis = this.basis(scope, documentId);
    const decided = lines.filter((l) => l.status === 'AUTO_MATCHED' || l.status === 'MANUAL').length;
    const basisDecided = basis !== null && (basis.status === 'AUTO_MATCHED' || basis.status === 'MANUAL');
    return {
      documentId, lines: lines.length, decided, needsReview: lines.length - decided,
      basisStatus: basis?.status ?? null,
      readyForReceiptCommand: lines.length > 0 && decided === lines.length && basisDecided,
      accountingEffect: 'NONE',
    };
  }

  /** Original → … → latest correction, as stored. */
  chain(scope: Scope, documentId: string): ChainLink[] {
    const link = (d: Document): ChainLink => ({ documentId: d.id, externalId: d.externalId, revision: d.revision, correctionOf: d.correctionOf });
    const seen = new Set<string>();
    let head = this.store.get(scope, documentId);
    seen.add(head.id);
    for (let prev = this.findOriginal(scope, head); prev && !seen.has(prev.id); prev = this.findOriginal(scope, prev)) {
      seen.add(prev.id);
      head = prev;
    }
    const out: ChainLink[] = [link(head)];
    const visited = new Set([head.id]);
    for (let cur: Document | undefined = head; cur?.externalId;) {
      const next = this.db.prepare("SELECT * FROM documents WHERE tenantId=? AND orgId=? AND direction='IN' AND correctionOf=? ORDER BY rowid LIMIT 1")
        .get(scope.tenantId, scope.orgId, cur.externalId) as unknown as Document | undefined;
      if (!next || visited.has(next.id)) break;
      visited.add(next.id);
      out.push(link(next));
      cur = next;
    }
    return out;
  }
}
