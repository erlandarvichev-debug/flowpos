// FP-030: журнал складских движений. Остаток (stock.qty) меняется только вставкой движения — триггер БД прибавляет
// количество к строке остатка; прямая запись количества отклоняется (sql/100_fp030_stock_ledger.sql). Здесь — как
// документ превращается в движения и как они отменяются (встречными движениями, исходные не трогаются).
import { Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;
type Dec = Prisma.Decimal;
const D = Prisma.Decimal;

export const LEDGER_SOURCE = 'TRADE_DOCUMENT';
/** Отмена документа, проведённого до журнала: встречная к начальному остатку (BACKFILL), стоимость неизвестна. */
export const PRE_LEDGER = 'PRE_LEDGER';

/** Вид движения и знак для документа: + приход на склад документа, − расход. Перемещение — два движения. */
export const MOVE_KIND: Record<string, { kind: string; sign: 1 | -1 }> = {
  SUPPLY: { kind: 'RECEIPT', sign: 1 },
  SALES_RETURN: { kind: 'SALES_RETURN', sign: 1 },
  ENTER: { kind: 'ENTER', sign: 1 },
  RETAIL_RETURN: { kind: 'RETAIL_RETURN', sign: 1 },
  DEMAND: { kind: 'SHIPMENT', sign: -1 },
  PURCHASE_RETURN: { kind: 'PURCHASE_RETURN', sign: -1 },
  LOSS: { kind: 'WRITE_OFF', sign: -1 },
  RETAIL_DEMAND: { kind: 'RETAIL_SALE', sign: -1 },
};

/** Приходы, у которых стоимость известна из документа (цена поставщика / оприходования). */
const PRICED_IN = ['RECEIPT', 'ENTER'];

export interface LedgerDoc {
  id: string;
  docType: string;
  date: Date;
  version?: number | null;
  organizationId?: string | null;
  storeId: string | null;
  storeToId: string | null;
  lines: { lineNo: number; productId: string; qty: Dec | number | string; amount?: Dec | number | string | null }[];
}

export interface PlannedMove {
  storeId: string;
  productId: string;
  qty: Dec;
  kind: string;
  sourceLine: number;
  docValue: Dec | null; // стоимость по документу (для прихода по цене)
}

/** Движения документа (без записи): что прибавится и что убудет на каких складах. Услуги и нулевые строки — без движений. */
export function plannedMoves(doc: LedgerDoc, services: Set<string> = new Set()): PlannedMove[] {
  const out: PlannedMove[] = [];
  const lines = doc.lines.filter((l) => !services.has(l.productId) && !new D(l.qty).isZero());
  if (doc.docType === 'MOVE') {
    if (!doc.storeId || !doc.storeToId) return out;
    for (const l of lines) {
      out.push({ storeId: doc.storeId, productId: l.productId, qty: new D(l.qty).neg(), kind: 'TRANSFER_OUT', sourceLine: l.lineNo, docValue: null });
      out.push({ storeId: doc.storeToId, productId: l.productId, qty: new D(l.qty), kind: 'TRANSFER_IN', sourceLine: l.lineNo, docValue: null });
    }
    return out;
  }
  const k = MOVE_KIND[doc.docType];
  if (!k || !doc.storeId) return out;
  for (const l of lines) {
    const docValue = PRICED_IN.includes(k.kind) && l.amount != null ? new D(l.amount) : null;
    out.push({ storeId: doc.storeId, productId: l.productId, qty: new D(l.qty).times(k.sign), kind: k.kind, sourceLine: l.lineNo, docValue });
  }
  return out;
}

async function serviceIds(tx: Tx, doc: LedgerDoc) {
  const ids = [...new Set(doc.lines.map((l) => l.productId))];
  if (!ids.length) return new Set<string>();
  return new Set((await tx.product.findMany({ where: { id: { in: ids }, kind: 'SERVICE' }, select: { id: true } })).map((p) => p.id));
}

async function storeOrgs(tx: Tx, storeIds: string[]) {
  const rows = await tx.store.findMany({ where: { id: { in: [...new Set(storeIds)] } }, select: { id: true, organizationId: true } });
  return new Map(rows.map((r) => [r.id, r.organizationId]));
}

/**
 * Записать движения проведённого документа. Стоимость прихода — из учёта (себестоимость поступления без НДС, если
 * документ отражён автопилотом), иначе — сумма строки документа. Стоимость расхода определяется себестоимостью
 * (FP-031) и в отчёте берётся из записей себестоимости. Вызывать после отражения в учёте (автопилота).
 */
export async function recordDocumentMoves(tx: Tx, doc: LedgerDoc, opts: { userId?: string | null; reason?: string } = {}) {
  const planned = plannedMoves(doc, await serviceIds(tx, doc));
  if (!planned.length) return [];
  const orgs = await storeOrgs(tx, planned.map((m) => m.storeId));
  const acc = await tx.accStockMove.findMany({
    where: { sourceType: LEDGER_SOURCE, sourceId: doc.id, isActive: true, direction: 'IN', knownCost: { not: null } },
    select: { lineNo: true, storeId: true, productId: true, knownCost: true },
  });
  const rows = planned.map((m) => {
    let value: Dec | null = null;
    let basis: string | null = null;
    if (m.qty.gt(0)) {
      const a = acc.find((x) => x.lineNo === m.sourceLine && x.storeId === m.storeId && x.productId === m.productId);
      if (a?.knownCost != null) { value = new D(a.knownCost); basis = 'ACCOUNTING'; }
      else if (m.docValue) { value = m.docValue; basis = 'DOCUMENT'; }
    }
    return {
      organizationId: orgs.get(m.storeId)!, productId: m.productId, storeId: m.storeId, qty: m.qty, value, valueBasis: basis, kind: m.kind,
      sourceType: LEDGER_SOURCE, sourceId: doc.id, sourceLine: m.sourceLine, sourceVersion: doc.version ?? null,
      occurredAt: doc.date, createdBy: opts.userId ?? null, reason: opts.reason ?? null,
    };
  });
  await tx.stockMovement.createMany({ data: rows });
  return rows;
}

/**
 * Отменить движения документа встречными (исходные неизменны; одно встречное на исходное — уникальность в БД).
 * Документ, проведённый до журнала (движений нет вовсе), — его влияние уже в начальном остатке: отменяется
 * обратными движениями по строкам документа.
 */
export async function reverseDocumentMoves(tx: Tx, doc: LedgerDoc, opts: { userId?: string | null; reason?: string } = {}) {
  const all = await tx.stockMovement.findMany({ where: { sourceType: LEDGER_SOURCE, sourceId: doc.id }, orderBy: [{ createdAt: 'asc' }, { sourceLine: 'asc' }] });
  if (!all.length) {
    const planned = plannedMoves(doc, await serviceIds(tx, doc));
    if (!planned.length) return [];
    const orgs = await storeOrgs(tx, planned.map((m) => m.storeId));
    const rows = planned.map((m) => ({
      organizationId: orgs.get(m.storeId)!, productId: m.productId, storeId: m.storeId, qty: m.qty.neg(), value: null, valueBasis: PRE_LEDGER, kind: m.kind,
      sourceType: LEDGER_SOURCE, sourceId: doc.id, sourceLine: m.sourceLine, sourceVersion: doc.version ?? null, occurredAt: doc.date,
      createdBy: opts.userId ?? null, reason: opts.reason ?? 'Снятие проведения документа, проведённого до журнала движений',
    }));
    await tx.stockMovement.createMany({ data: rows });
    return rows;
  }
  const reversed = new Set(all.filter((m) => m.reversesId).map((m) => m.reversesId!));
  // Отмена проведения «до журнала» — сама встречная (к начальному остатку), повторно не отменяется.
  const open = all.filter((m) => !m.reversesId && m.valueBasis !== PRE_LEDGER && !reversed.has(m.id));
  if (!open.length) return [];
  const rows = open.map((m) => ({
    organizationId: m.organizationId, productId: m.productId, storeId: m.storeId, binId: m.binId, qty: new D(m.qty).neg(),
    value: m.value == null ? null : new D(m.value).neg(), valueBasis: m.value == null ? null : 'REVERSAL', kind: m.kind,
    sourceType: m.sourceType, sourceId: m.sourceId, sourceLine: m.sourceLine, sourceVersion: m.sourceVersion, reversesId: m.id,
    occurredAt: m.occurredAt, createdBy: opts.userId ?? null, reason: opts.reason ?? 'Отмена проведения',
  }));
  await tx.stockMovement.createMany({ data: rows });
  return rows;
}

/** Документ старого модуля, созданный сразу проведённым: движения по его строкам (стоимость — по документу). */
export async function recordLegacyPosted(tx: Tx, docId: string, userId?: string | null) {
  const doc = await tx.document.findUnique({ where: { id: docId }, include: { lines: true } });
  if (!doc || doc.status !== 'POSTED') return [];
  return recordDocumentMoves(tx, doc, { userId });
}
