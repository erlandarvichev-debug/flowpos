/**
 * FP-014 acceptance: manual override audited; receipt creates no stock/VAT; correction chain preserved.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { EsfStore, type Scope } from './core.ts';
import {
  EsfMatchingService, type CatalogLookup, type BasisLookup, type CatalogItem, type BasisCandidate, type NormalizedInbound,
} from './matching.ts';

const SELLER = '123456789012';
const OTHER_SELLER = '999999999999';
const sys: Scope = { tenantId: 't1', orgId: 'o1' };
const alice: Scope = { ...sys, actorId: 'alice' };
const foreign: Scope = { tenantId: 't1', orgId: 'o2', actorId: 'mallory' };

class FakeCatalog implements CatalogLookup {
  private items: Record<string, Array<CatalogItem & { barcodes?: string[] }>>;
  constructor(items: Record<string, Array<CatalogItem & { barcodes?: string[] }>>) { this.items = items; }
  private of(s: Scope) { return this.items[`${s.tenantId}/${s.orgId}`] ?? []; }
  getItem(s: Scope, id: string) { return this.of(s).find((i) => i.itemId === id) ?? null; }
  findByBarcode(s: Scope, b: string) { return this.of(s).filter((i) => i.barcodes?.includes(b)); }
  searchByName(s: Scope, n: string) { return this.of(s).filter((i) => i.name.toLowerCase() === n.trim().toLowerCase()); }
}
class FakeBases implements BasisLookup {
  private list: Array<BasisCandidate & { scope: string; bin: string }>;
  constructor(list: Array<BasisCandidate & { scope: string; bin: string }>) { this.list = list; }
  get(s: Scope, id: string) { return this.list.find((b) => b.basisId === id && b.scope === `${s.tenantId}/${s.orgId}`) ?? null; }
  find(s: Scope, bin: string, ref: { kind: string; number: string; date: string }) {
    return this.list.filter((b) => b.scope === `${s.tenantId}/${s.orgId}` && b.bin === bin && b.kind === ref.kind && b.number === ref.number && b.date === ref.date);
  }
}

const catalog = new FakeCatalog({
  't1/o1': [
    { itemId: 'milk', name: 'Молоко 1л', unit: 'шт', barcodes: ['4870001'] },
    { itemId: 'bread', name: 'Хлеб', unit: 'шт', barcodes: ['4870002'] },
    { itemId: 'sugar', name: 'Сахар', unit: 'кг', barcodes: ['4870003'] },
    { itemId: 'dupA', name: 'Вода', unit: 'шт', barcodes: ['4870009'] },
    { itemId: 'dupB', name: 'Вода', unit: 'шт', barcodes: ['4870009'] },
  ],
  't1/o2': [{ itemId: 'foreign-item', name: 'Чужой', unit: 'шт' }],
});
const bases = new FakeBases([
  { scope: 't1/o1', bin: SELLER, basisId: 'contract-7', kind: 'CONTRACT', number: '7', date: '2026-01-10' },
  { scope: 't1/o1', bin: SELLER, basisId: 'supply-1', kind: 'SUPPLY', number: 'S-1', date: '2026-10-01' },
  { scope: 't1/o1', bin: SELLER, basisId: 'supply-1b', kind: 'SUPPLY', number: 'S-1', date: '2026-10-01' },
]);

let store: EsfStore;
let svc: EsfMatchingService;
let seq = 0;

function receive(extra: { correctionOf?: string; schemaVersion?: string; externalId?: string } = {}) {
  const externalId = extra.externalId ?? `remote-${++seq}`;
  const [d] = store.ingest(sys, [{ externalId, revision: '1', schemaVersion: extra.schemaVersion ?? 'synthetic-v1', xml: `<SyntheticInvoice n="${externalId}"/>`, correctionOf: extra.correctionOf }], `c${seq}`);
  return d;
}

const inbound = (over: Partial<NormalizedInbound> = {}): NormalizedInbound => ({
  counterpartyBin: SELLER,
  lines: [
    { lineNo: 1, sellerCode: 'SUP-MILK', barcode: '4870001', name: 'Молоко 1л', unit: 'шт', quantity: '10' },
    { lineNo: 2, sellerCode: 'SUP-BREAD', name: 'Хлеб', unit: 'шт', quantity: '5' },
  ],
  basis: { kind: 'CONTRACT', number: '7', date: '2026-01-10' },
  ...over,
});

beforeEach(() => {
  store = new EsfStore(':memory:');
  svc = new EsfMatchingService(store, catalog, bases);
});
afterEach(() => store.close());

describe('FP-014: automatic proposals', () => {
  it('auto-matches a unique barcode with matching unit and sends a name-only hit to review', () => {
    const d = receive();
    const s = svc.match(sys, d.id, inbound());
    const [milk, bread] = svc.lines(sys, d.id);
    assert.deepEqual([milk.status, milk.method, milk.itemId, milk.confidence], ['AUTO_MATCHED', 'BARCODE', 'milk', 0.9]);
    assert.deepEqual([bread.status, bread.method, bread.itemId], ['REVIEW_REQUIRED', 'NAME', 'bread']);
    assert.equal(svc.basis(sys, d.id)!.basisId, 'contract-7');
    assert.deepEqual([s.lines, s.decided, s.needsReview, s.readyForReceiptCommand], [2, 1, 1, false]);
  });

  it('never auto-decides on unit mismatch, ambiguous barcode or no hit', () => {
    const d = receive();
    svc.match(sys, d.id, inbound({
      lines: [
        { lineNo: 1, barcode: '4870003', name: 'Сахар', unit: 'мешок', quantity: '1' },
        { lineNo: 2, barcode: '4870009', name: 'Вода', unit: 'шт', quantity: '1' },
        { lineNo: 3, name: 'Неизвестный товар', unit: 'шт', quantity: '1' },
      ],
    }));
    const [sugar, water, unknown] = svc.lines(sys, d.id);
    assert.equal(sugar.status, 'REVIEW_REQUIRED');
    assert(sugar.confidence < 0.5);
    assert.deepEqual([water.status, water.itemId, water.candidates], ['REVIEW_REQUIRED', null, ['dupA', 'dupB']]);
    assert.deepEqual([unknown.status, unknown.itemId, unknown.method], ['UNMATCHED', null, 'NONE']);
  });

  it('sends an ambiguous basis to review and a missing basis to UNMATCHED', () => {
    const a = receive();
    svc.match(sys, a.id, inbound({ basis: { kind: 'SUPPLY', number: 'S-1', date: '2026-10-01' } }));
    assert.deepEqual(svc.basis(sys, a.id)!.candidates, ['supply-1', 'supply-1b']);
    assert.equal(svc.basis(sys, a.id)!.status, 'REVIEW_REQUIRED');
    const b = receive();
    svc.match(sys, b.id, inbound({ basis: undefined }));
    assert.equal(svc.basis(sys, b.id)!.status, 'UNMATCHED');
  });

  it('is idempotent for identical input and rejects different input', () => {
    const d = receive();
    const first = svc.match(sys, d.id, inbound());
    assert.deepEqual(svc.match(sys, d.id, inbound()), first);
    assert.throws(() => svc.match(sys, d.id, inbound({ counterpartyBin: OTHER_SELLER })), /MATCH_INPUT_CONFLICT/);
    assert.equal(svc.lines(sys, d.id).length, 2);
  });

  it('refuses quarantined and outbound documents', () => {
    const q = receive({ schemaVersion: 'unknown-v9' });
    assert.equal(q.state, 'QUARANTINED');
    assert.throws(() => svc.match(sys, q.id, inbound()), /MATCH_NOT_ALLOWED/);
    const out = store.create(sys, 'op-out', { number: 'N1', amountMinor: '100', currency: 'KZT' });
    assert.throws(() => svc.match(sys, out.id, inbound()), /MATCH_NOT_ALLOWED/);
  });

  it('validates input', () => {
    const d = receive();
    assert.throws(() => svc.match(sys, d.id, inbound({ counterpartyBin: '123' })), /INVALID_COUNTERPARTY_BIN/);
    assert.throws(() => svc.match(sys, d.id, inbound({ lines: [] })), /INVALID_LINES/);
    const l = inbound().lines[0];
    assert.throws(() => svc.match(sys, d.id, inbound({ lines: [l, { ...l }] })), /INVALID_LINE_NO/);
    assert.throws(() => svc.match(sys, d.id, inbound({ lines: [{ ...l, quantity: '-1' }] })), /INVALID_QUANTITY/);
    assert.throws(() => svc.match(sys, d.id, inbound({ basis: { kind: 'CONTRACT', number: '7', date: '10.01.2026' } })), /INVALID_BASIS/);
  });
});

describe('FP-014: manual override is audited', () => {
  it('requires a human actor and a reason', () => {
    const d = receive();
    svc.match(sys, d.id, inbound());
    const cmd = { documentId: d.id, lineNo: 2, itemId: 'bread', reason: 'checked with supplier', expectedVersion: 1 };
    assert.throws(() => svc.overrideLine(sys, cmd), /ACTOR_REQUIRED/);
    assert.throws(() => svc.overrideLine({ ...sys, actorId: 'system-fixture' }, cmd), /ACTOR_REQUIRED/);
    assert.throws(() => svc.overrideLine(alice, { ...cmd, reason: ' ' }), /REASON_REQUIRED/);
  });

  it('rejects unknown items and stale versions', () => {
    const d = receive();
    svc.match(sys, d.id, inbound());
    const cmd = { documentId: d.id, lineNo: 2, itemId: 'bread', reason: 'checked', expectedVersion: 1 };
    assert.throws(() => svc.overrideLine(alice, { ...cmd, itemId: 'nope' }), /UNKNOWN_ITEM/);
    svc.overrideLine(alice, cmd);
    assert.throws(() => svc.overrideLine(alice, cmd), /VERSION_CONFLICT/);
  });

  it('records who, what, from-to and why in history and audit', () => {
    const d = receive();
    svc.match(sys, d.id, inbound());
    const line = svc.overrideLine(alice, { documentId: d.id, lineNo: 1, itemId: 'bread', reason: 'supplier ships bread under this code', expectedVersion: 1 });
    assert.deepEqual([line.status, line.itemId, line.decidedBy, line.version, line.confidence], ['MANUAL', 'bread', 'alice', 2, 1]);

    const h = svc.historyOf(sys, d.id).filter((r) => r.target === 'LINE:1');
    assert.equal(h.length, 2);
    assert.deepEqual(h[0], { target: 'LINE:1', fromRef: null, toRef: 'milk', fromStatus: null, toStatus: 'AUTO_MATCHED', actorId: 'system-matcher', reason: 'auto:BARCODE' });
    assert.deepEqual(h[1], { target: 'LINE:1', fromRef: 'milk', toRef: 'bread', fromStatus: 'AUTO_MATCHED', toStatus: 'MANUAL', actorId: 'alice', reason: 'supplier ships bread under this code' });

    const audit = store.db.prepare("SELECT event,actorId FROM audit WHERE documentId=? AND event LIKE 'MATCH_%' ORDER BY id").all(d.id);
    assert.deepEqual((audit as Array<{ event: string; actorId: string }>).map((a) => [a.event, a.actorId]), [['MATCH_PROPOSED', 'system-matcher'], ['MATCH_LINE_OVERRIDE', 'alice']]);
  });

  it('keeps history append-only at the database level', () => {
    const d = receive();
    svc.match(sys, d.id, inbound());
    assert.throws(() => store.db.prepare("UPDATE esf_match_history SET actorId='x'").run(), /HISTORY_APPEND_ONLY/);
    assert.throws(() => store.db.prepare('DELETE FROM esf_match_history').run(), /HISTORY_APPEND_ONLY/);
  });

  it('records an explicit "no catalog item" decision', () => {
    const d = receive();
    svc.match(sys, d.id, inbound());
    const line = svc.overrideLine(alice, { documentId: d.id, lineNo: 2, itemId: null, reason: 'delivery service, not stock', expectedVersion: 1 });
    assert.deepEqual([line.status, line.itemId], ['MANUAL', null]);
  });

  it('learns a counterparty code only on request and only for that seller', () => {
    const d = receive();
    svc.match(sys, d.id, inbound());
    assert.throws(() => svc.overrideLine(alice, { documentId: d.id, lineNo: 2, itemId: null, reason: 'nope', expectedVersion: 1, remember: true }), /REMEMBER_REQUIRES/);
    svc.overrideLine(alice, { documentId: d.id, lineNo: 2, itemId: 'bread', reason: 'confirmed', expectedVersion: 1, remember: true });
    assert(store.db.prepare("SELECT 1 FROM audit WHERE event='COUNTERPARTY_MAP_LEARNED' AND actorId='alice'").get());

    const next = receive();
    svc.match(sys, next.id, inbound());
    const bread = svc.lines(sys, next.id)[1];
    assert.deepEqual([bread.status, bread.method, bread.itemId, bread.confidence], ['AUTO_MATCHED', 'COUNTERPARTY_CODE', 'bread', 1]);

    const otherSeller = receive();
    svc.match(sys, otherSeller.id, inbound({ counterpartyBin: OTHER_SELLER, basis: undefined }));
    assert.equal(svc.lines(sys, otherSeller.id)[1].method, 'NAME');
  });

  it('decides the basis manually with the same audit trail', () => {
    const d = receive();
    svc.match(sys, d.id, inbound({ basis: { kind: 'SUPPLY', number: 'S-1', date: '2026-10-01' } }));
    assert.throws(() => svc.overrideBasis(alice, { documentId: d.id, basisId: 'ghost', reason: 'x-ref', expectedVersion: 1 }), /UNKNOWN_BASIS/);
    const b = svc.overrideBasis(alice, { documentId: d.id, basisId: 'supply-1b', reason: 'second delivery', expectedVersion: 1 });
    assert.deepEqual([b.status, b.basisId, b.decidedBy], ['MANUAL', 'supply-1b', 'alice']);
    assert(store.db.prepare("SELECT 1 FROM audit WHERE event='MATCH_BASIS_OVERRIDE' AND actorId='alice'").get());
  });
});

describe('FP-014: receipt creates no stock/VAT', () => {
  it('matching leaves the document, approvals and jobs untouched and creates no accounting rows', () => {
    const d = receive();
    const before = store.get(sys, d.id);
    const count = (t: string) => Number(store.db.prepare(`SELECT count(*) n FROM ${t}`).get()!.n);
    const baseline = { documents: count('documents'), approvals: count('approvals'), jobs: count('jobs') };

    svc.match(sys, d.id, inbound());
    svc.overrideLine(alice, { documentId: d.id, lineNo: 2, itemId: 'bread', reason: 'checked delivery note', expectedVersion: 1 });
    const s = svc.summary(sys, d.id);
    assert.equal(s.readyForReceiptCommand, true);
    assert.equal(s.accountingEffect, 'NONE');

    const after = store.get(sys, d.id);
    assert.deepEqual([after.state, after.version, after.payloadHash], [before.state, before.version, before.payloadHash]);
    assert.deepEqual({ documents: count('documents'), approvals: count('approvals'), jobs: count('jobs') }, baseline);

    const tables = (store.db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','trigger')").all() as Array<{ name: string }>).map((r) => r.name);
    assert.deepEqual(tables.filter((n) => /stock|inventory|movement|ledger|vat|posting|journal/i.test(n)), []);
  });
});

describe('FP-014: correction chain preserved', () => {
  function originalWithManualDecision() {
    const orig = receive({ externalId: 'esf-100' });
    svc.match(sys, orig.id, inbound());
    svc.overrideLine(alice, { documentId: orig.id, lineNo: 2, itemId: 'bread', reason: 'confirmed by phone', expectedVersion: 1 });
    return orig;
  }

  it('inherits decisions for unchanged lines and re-matches changed ones', () => {
    const orig = originalWithManualDecision();
    const corr = receive({ externalId: 'esf-101', correctionOf: 'esf-100' });
    const lines = inbound().lines;
    svc.match(sys, corr.id, inbound({ lines: [{ ...lines[0], name: 'Молоко 1л', barcode: '4870001', sellerCode: 'SUP-MILK-NEW', quantity: '12' }, { ...lines[1], quantity: '4' }] }));

    const [l1, l2] = svc.lines(sys, corr.id);
    assert.deepEqual([l1.inheritedFrom, l1.method, l1.status], [null, 'BARCODE', 'AUTO_MATCHED']);
    assert.deepEqual([l2.inheritedFrom, l2.status, l2.itemId, l2.decidedBy, l2.reason, l2.quantity], [orig.id, 'MANUAL', 'bread', 'alice', 'confirmed by phone', '4']);
    assert.equal(svc.basis(sys, corr.id)!.inheritedFrom, orig.id);
    assert(store.db.prepare("SELECT 1 FROM audit WHERE documentId=? AND event='MATCH_PROPOSED_FROM_CORRECTION_CHAIN'").get(corr.id));
  });

  it('never modifies the original when the correction is overridden', () => {
    const orig = originalWithManualDecision();
    const snapshot = JSON.stringify([svc.lines(sys, orig.id), svc.basis(sys, orig.id), svc.historyOf(sys, orig.id)]);
    const corr = receive({ externalId: 'esf-201', correctionOf: 'esf-100' });
    svc.match(sys, corr.id, inbound());
    svc.overrideLine(alice, { documentId: corr.id, lineNo: 2, itemId: null, reason: 'returned in correction', expectedVersion: 1 });
    assert.equal(JSON.stringify([svc.lines(sys, orig.id), svc.basis(sys, orig.id), svc.historyOf(sys, orig.id)]), snapshot);
  });

  it('does not inherit undecided lines or decisions across counterparties', () => {
    const orig = receive({ externalId: 'esf-300' });
    svc.match(sys, orig.id, inbound());
    const corr = receive({ externalId: 'esf-301', correctionOf: 'esf-300' });
    svc.match(sys, corr.id, inbound());
    assert.equal(svc.lines(sys, corr.id)[1].inheritedFrom, null, 'REVIEW_REQUIRED is re-evaluated, not copied');

    const orig2 = originalWithManualDecision();
    const corr2 = receive({ externalId: 'esf-102', correctionOf: 'esf-100' });
    svc.match(sys, corr2.id, inbound({ counterpartyBin: OTHER_SELLER }));
    assert(svc.lines(sys, corr2.id).every((l) => l.inheritedFrom === null), `no inheritance from ${orig2.id}`);
  });

  it('returns the chain original → correction → correction from any member', () => {
    const a = receive({ externalId: 'esf-400' });
    const b = receive({ externalId: 'esf-401', correctionOf: 'esf-400' });
    const c = receive({ externalId: 'esf-402', correctionOf: 'esf-401' });
    const ids = (from: string) => svc.chain(sys, from).map((x) => x.documentId);
    assert.deepEqual(ids(a.id), [a.id, b.id, c.id]);
    assert.deepEqual(ids(c.id), [a.id, b.id, c.id]);
    assert.deepEqual(svc.chain(sys, b.id)[1], { documentId: b.id, externalId: 'esf-401', revision: '1', correctionOf: 'esf-400' });
  });
});

describe('FP-014: tenant/organization isolation', () => {
  it('another organization cannot read, match or override, and cannot use its own items', () => {
    const d = receive();
    svc.match(sys, d.id, inbound());
    assert.throws(() => svc.lines(foreign, d.id), /NOT_FOUND/);
    assert.throws(() => svc.match(foreign, d.id, inbound()), /NOT_FOUND/);
    assert.throws(() => svc.overrideLine(foreign, { documentId: d.id, lineNo: 1, itemId: 'foreign-item', reason: 'steal', expectedVersion: 1 }), /UNKNOWN_ITEM|NOT_FOUND/);
    assert.throws(() => svc.overrideLine(alice, { documentId: d.id, lineNo: 1, itemId: 'foreign-item', reason: 'cross-org', expectedVersion: 1 }), /UNKNOWN_ITEM/);
    assert.throws(() => svc.chain(foreign, d.id), /NOT_FOUND/);
  });
});
