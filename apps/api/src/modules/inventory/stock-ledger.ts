// FP-030: журнал складских движений. Остаток (stock.qty) меняется только вставкой движения — триггер БД прибавляет
// количество к строке остатка; прямая запись количества отклоняется (sql/100_fp030_stock_ledger.sql). Здесь — как
// документ превращается в движения и как они отменяются (встречными движениями, исходные не трогаются).
import { Prisma } from '@prisma/client';
import { EXPIRED_ALLOWED, LotError, allocateFefo, isExpired, lotBalances } from './lots';

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
  lines: {
    lineNo: number; productId: string; qty: Dec | number | string; amount?: Dec | number | string | null; binId?: string | null; binToId?: string | null;
    lotNumber?: string | null; expiryDate?: Date | null; bookQty?: Dec | number | string | null; price?: Dec | number | string | null;
  }[];
}

export interface PlannedMove {
  storeId: string;
  binId: string | null; // FP-032: ячейка
  productId: string;
  qty: Dec;
  kind: string;
  sourceLine: number;
  docValue: Dec | null; // стоимость по документу (для прихода по цене)
  lotNumber: string | null; // FP-033: партия (null — подбирается FEFO для партионного расхода)
  expiryDate: Date | null;
}

/** Движения документа (без записи): что прибавится и что убудет на каких складах. Услуги и нулевые строки — без движений. */
export function plannedMoves(doc: LedgerDoc, services: Set<string> = new Set()): PlannedMove[] {
  const out: PlannedMove[] = [];
  const lot = (l: LedgerDoc['lines'][number]) => ({ lotNumber: l.lotNumber ?? null, expiryDate: l.expiryDate ?? null });
  // FP-033: инвентаризация — движение на разницу «факт − учётное» (излишек по цене строки, недостача — по себестоимости).
  if (doc.docType === 'INVENTORY') {
    if (!doc.storeId) return out;
    for (const l of doc.lines) {
      if (services.has(l.productId) || l.bookQty == null) continue;
      const diff = new D(l.qty).minus(l.bookQty);
      if (diff.isZero()) continue;
      out.push({
        storeId: doc.storeId, binId: l.binId ?? null, productId: l.productId, qty: diff, kind: diff.gt(0) ? 'INVENTORY_SURPLUS' : 'INVENTORY_SHORTAGE',
        sourceLine: l.lineNo, docValue: diff.gt(0) && l.price != null ? diff.times(l.price).toDecimalPlaces(2) : null, ...lot(l),
      });
    }
    return out;
  }
  const lines = doc.lines.filter((l) => !services.has(l.productId) && !new D(l.qty).isZero());
  if (doc.docType === 'MOVE') {
    if (!doc.storeId || !doc.storeToId) return out;
    for (const l of lines) {
      out.push({ storeId: doc.storeId, binId: l.binId ?? null, productId: l.productId, qty: new D(l.qty).neg(), kind: 'TRANSFER_OUT', sourceLine: l.lineNo, docValue: null, ...lot(l) });
      out.push({ storeId: doc.storeToId, binId: l.binToId ?? null, productId: l.productId, qty: new D(l.qty), kind: 'TRANSFER_IN', sourceLine: l.lineNo, docValue: null, ...lot(l) });
    }
    return out;
  }
  const k = MOVE_KIND[doc.docType];
  if (!k || !doc.storeId) return out;
  for (const l of lines) {
    const docValue = PRICED_IN.includes(k.kind) && l.amount != null ? new D(l.amount) : null;
    out.push({ storeId: doc.storeId, binId: l.binId ?? null, productId: l.productId, qty: new D(l.qty).times(k.sign), kind: k.kind, sourceLine: l.lineNo, docValue, ...lot(l) });
  }
  return out;
}

export async function serviceIds(tx: Tx, doc: LedgerDoc) {
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
export async function recordDocumentMoves(tx: Tx, doc: LedgerDoc, opts: { userId?: string | null; reason?: string; strictLots?: boolean } = {}) {
  const planned = await expandLots(tx, doc, plannedMoves(doc, await serviceIds(tx, doc)), opts.strictLots !== false);
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
      organizationId: orgs.get(m.storeId)!, productId: m.productId, storeId: m.storeId, binId: m.binId, qty: m.qty, value, valueBasis: basis, kind: m.kind,
      lotNumber: m.lotNumber, expiryDate: m.expiryDate,
      sourceType: LEDGER_SOURCE, sourceId: doc.id, sourceLine: m.sourceLine, sourceVersion: doc.version ?? null,
      occurredAt: doc.date, createdBy: opts.userId ?? null, reason: opts.reason ?? null,
    };
  });
  await insertMoves(tx, rows);
  return rows;
}

/** Вставка движений; нехватка партии из БД (LOT_INSUFFICIENT) — понятная ошибка. */
async function insertMoves(tx: Tx, rows: any[]) {
  // По одной строке, в порядке документа: проверка партии в БД видит предыдущие движения этого же документа.
  for (const r of rows) {
    try {
      await tx.stockMovement.create({ data: r });
    } catch (e: any) {
      const m = String(e?.meta?.message ?? e?.message ?? '').match(/LOT_INSUFFICIENT: ([^"`\n]*)/);
      if (m) throw new LotError('LOT_INSUFFICIENT', `Не хватает партии: ${m[1].trim()}`, 'Уменьшите количество или выберите другую партию.');
      throw e;
    }
  }
}

/**
 * FP-033: партии расхода. Партионный товар без указанной партии списывается по FEFO (для продажи и перемещения —
 * без просроченных); указанная партия — проверяется на срок. Перемещение переносит те же партии на склад-получатель.
 * strict: нехватка партий — ошибка (документы учёта); иначе (касса, старые модули) остаток уходит без партии.
 */
async function expandLots(tx: Tx, doc: LedgerDoc, planned: PlannedMove[], strict: boolean): Promise<PlannedMove[]> {
  const ids = [...new Set(planned.map((m) => m.productId))];
  if (!ids.length) return planned;
  const tracked = new Map((await tx.product.findMany({ where: { id: { in: ids }, lotTracking: true }, select: { id: true, name: true } })).map((p) => [p.id, p.name]));
  const out: PlannedMove[] = [];
  for (let i = 0; i < planned.length; i++) {
    const m = planned[i];
    const pairIn = m.kind === 'TRANSFER_OUT' ? planned[i + 1] : undefined;
    if (m.qty.gte(0) || !tracked.has(m.productId)) {
      out.push(m);
      if (pairIn) { out.push(pairIn); i++; }
      continue;
    }
    const allowExpired = EXPIRED_ALLOWED.includes(m.kind);
    let pieces: { lotNumber: string | null; expiryDate: Date | null; qty: Prisma.Decimal }[];
    if (m.lotNumber) {
      const bal = (await lotBalances(tx, m.productId, m.storeId, m.binId)).find((b) => b.lotNumber === m.lotNumber);
      const expiry = m.expiryDate ?? bal?.expiryDate ?? null;
      if (!allowExpired && isExpired(expiry, doc.date)) {
        throw new LotError('LOT_EXPIRED', `Партия ${m.lotNumber} «${tracked.get(m.productId)}» просрочена (годна до ${expiry!.toISOString().slice(0, 10)}) — её можно только списать`, 'Выберите другую партию или оформите списание.');
      }
      pieces = [{ lotNumber: m.lotNumber, expiryDate: expiry, qty: m.qty.neg() }];
    } else {
      const { pieces: got, shortfall } = allocateFefo(await lotBalances(tx, m.productId, m.storeId, m.binId), m.qty.neg(), doc.date, allowExpired);
      pieces = got;
      if (shortfall.gt(0)) {
        if (strict) {
          throw new LotError('LOT_INSUFFICIENT', `«${tracked.get(m.productId)}»: годных партий не хватает ${shortfall.toString()}`, allowExpired ? 'Проверьте остатки партий.' : 'Просроченные партии продать нельзя — спишите их; проверьте остатки партий.');
        }
        pieces.push({ lotNumber: null, expiryDate: null, qty: shortfall });
      }
    }
    for (const p of pieces) {
      out.push({ ...m, qty: p.qty.neg(), lotNumber: p.lotNumber, expiryDate: p.expiryDate });
      if (pairIn) out.push({ ...pairIn, qty: p.qty, lotNumber: p.lotNumber, expiryDate: p.expiryDate });
    }
    if (pairIn) i++;
  }
  return out;
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
      organizationId: orgs.get(m.storeId)!, productId: m.productId, storeId: m.storeId, binId: m.binId, qty: m.qty.neg(), value: null, valueBasis: PRE_LEDGER, kind: m.kind,
      lotNumber: m.lotNumber, expiryDate: m.expiryDate,
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
  // Сначала отменяются расходы (возвращают партии), потом приходы — иначе отмена прихода проданной партии упёрлась бы в ноль.
  open.sort((a, b) => Number(new D(a.qty).gt(0)) - Number(new D(b.qty).gt(0)));
  const rows = open.map((m) => ({
    organizationId: m.organizationId, productId: m.productId, storeId: m.storeId, binId: m.binId, qty: new D(m.qty).neg(),
    lotNumber: m.lotNumber, expiryDate: m.expiryDate,
    value: m.value == null ? null : new D(m.value).neg(), valueBasis: m.value == null ? null : 'REVERSAL', kind: m.kind,
    sourceType: m.sourceType, sourceId: m.sourceId, sourceLine: m.sourceLine, sourceVersion: m.sourceVersion, reversesId: m.id,
    occurredAt: m.occurredAt, createdBy: opts.userId ?? null, reason: opts.reason ?? 'Отмена проведения',
  }));
  await insertMoves(tx, rows);
  return rows;
}

/** Документ старого модуля, созданный сразу проведённым: движения по его строкам (стоимость — по документу). */
export async function recordLegacyPosted(tx: Tx, docId: string, userId?: string | null) {
  const doc = await tx.document.findUnique({ where: { id: docId }, include: { lines: true } });
  if (!doc || doc.status !== 'POSTED') return [];
  return recordDocumentMoves(tx, doc, { userId, strictLots: false });
}
