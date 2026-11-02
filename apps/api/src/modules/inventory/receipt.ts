// FP-030: приёмка поступления — частичная и с расхождениями. Строка поступления хранит принятое количество (qty —
// идёт в остаток и учёт), количество по документу поставщика или заказу (expectedQty), отказ при приёмке (rejectedQty:
// брак, пересорт — товар не принят) и причину. Недостача = ожидалось − принято − отказ, излишек — наоборот.
import { Prisma } from '@prisma/client';

type Dec = Prisma.Decimal;
const D = Prisma.Decimal;

export const DISCREPANCY_REASONS = ['SHORTAGE', 'SURPLUS', 'DAMAGED', 'WRONG_ITEM', 'OTHER'] as const;
export const REASON_LABEL: Record<string, string> = {
  SHORTAGE: 'недостача', SURPLUS: 'излишек', DAMAGED: 'брак / повреждение', WRONG_ITEM: 'пересорт', OTHER: 'другое',
};

export interface ReceiptLineIn { qty: Dec; expectedQty: Dec | null; rejectedQty: Dec | null; discrepancyReason: string | null; discrepancyNote: string | null }

export class ReceiptError extends Error {
  constructor(public code: string, message: string, public fix?: string) { super(message); }
}

/** Расхождение строки: недостача, излишек, отказ (количество ≥ 0). */
export function discrepancyOf(l: { qty: Dec | string | number; expectedQty?: Dec | string | number | null; rejectedQty?: Dec | string | number | null }) {
  const qty = new D(l.qty);
  const rejected = new D(l.rejectedQty ?? 0);
  if (l.expectedQty == null) return { expected: null as Dec | null, accepted: qty, rejected, shortage: new D(0), surplus: new D(0), has: rejected.gt(0) };
  const expected = new D(l.expectedQty);
  const diff = expected.minus(qty).minus(rejected);
  const shortage = diff.gt(0) ? diff : new D(0);
  const surplus = diff.lt(0) ? diff.neg() : new D(0);
  return { expected, accepted: qty, rejected, shortage, surplus, has: shortage.gt(0) || surplus.gt(0) || rejected.gt(0) };
}

/**
 * Проверка строки приёмки (n — номер строки для сообщения). Поля приёмки — только у поступления. Принято 0 — можно,
 * если товар ожидался (не пришёл или весь в отказе). Расхождение — с причиной, причина — по существу расхождения.
 */
export function checkReceiptLine(docType: string, n: number, l: ReceiptLineIn) {
  const any = l.expectedQty != null || l.rejectedQty != null || !!l.discrepancyReason || !!l.discrepancyNote;
  if (docType !== 'SUPPLY') {
    // FP-033: у списания и инвентаризации — своя причина (проверяется отдельно); ожидаемое и отказ — только у поступления.
    const reasonOnly = docType === 'LOSS' || docType === 'INVENTORY';
    if (l.expectedQty != null || l.rejectedQty != null || (!reasonOnly && (l.discrepancyReason || l.discrepancyNote))) {
      throw new ReceiptError('RECEIPT_FIELDS', `Строка ${n}: ожидаемое количество, отказ и причина расхождения указываются только в поступлении`);
    }
    if (docType === 'INVENTORY') return; // факт может быть 0 — проверка в checkInventoryLine
    if (l.qty.lte(0)) throw new ReceiptError('BAD_QTY', `Строка ${n}: количество должно быть больше нуля`);
    return;
  }
  if (l.qty.lt(0)) throw new ReceiptError('BAD_QTY', `Строка ${n}: принятое количество не может быть отрицательным`);
  if (l.expectedQty != null && l.expectedQty.lt(0)) throw new ReceiptError('BAD_QTY', `Строка ${n}: количество по документу не может быть отрицательным`);
  if (l.rejectedQty != null && l.rejectedQty.lt(0)) throw new ReceiptError('BAD_QTY', `Строка ${n}: отказ не может быть отрицательным`);
  if (l.expectedQty == null && (l.rejectedQty != null || l.discrepancyReason)) {
    throw new ReceiptError('RECEIPT_EXPECTED_REQUIRED', `Строка ${n}: для расхождения укажите количество по документу поставщика`, 'Заполните «По документу» — сколько указано в накладной поставщика или заказе.');
  }
  if (l.qty.isZero() && !(l.expectedQty?.gt(0))) throw new ReceiptError('BAD_QTY', `Строка ${n}: количество должно быть больше нуля`);
  const r = discrepancyOf(l);
  const reason = l.discrepancyReason;
  if (reason && !(DISCREPANCY_REASONS as readonly string[]).includes(reason)) throw new ReceiptError('RECEIPT_REASON', `Строка ${n}: неизвестная причина расхождения ${reason}`);
  if (!r.has) {
    if (reason) throw new ReceiptError('RECEIPT_REASON', `Строка ${n}: расхождения нет — причина не нужна`);
    return;
  }
  if (!reason) {
    throw new ReceiptError('RECEIPT_REASON_REQUIRED', `Строка ${n}: принято ${r.accepted} из ${r.expected}${r.rejected.gt(0) ? `, отказ ${r.rejected}` : ''} — укажите причину расхождения`, 'Выберите причину: недостача, излишек, брак, пересорт или другое (с пояснением).');
  }
  const fits =
    reason === 'OTHER' ||
    (reason === 'SHORTAGE' && r.shortage.gt(0)) ||
    (reason === 'SURPLUS' && r.surplus.gt(0)) ||
    ((reason === 'DAMAGED' || reason === 'WRONG_ITEM') && r.rejected.gt(0));
  if (!fits) {
    throw new ReceiptError('RECEIPT_REASON', `Строка ${n}: причина «${REASON_LABEL[reason]}» не соответствует расхождению (недостача ${r.shortage}, излишек ${r.surplus}, отказ ${r.rejected})`);
  }
  if (reason === 'OTHER' && !(l.discrepancyNote ?? '').trim()) throw new ReceiptError('RECEIPT_REASON', `Строка ${n}: для причины «другое» нужно пояснение`);
}

/** Сводка расхождений поступления: по строкам и сумма претензии (недостача и отказ по цене строки). */
export function receiptSummary(lines: { lineNo: number; productId: string; qty: any; price?: any; expectedQty?: any; rejectedQty?: any; discrepancyReason?: string | null; discrepancyNote?: string | null }[]) {
  const rows = lines
    .map((l) => ({ l, r: discrepancyOf(l) }))
    .filter(({ r }) => r.has)
    .map(({ l, r }) => {
      const price = l.price == null ? null : new D(l.price);
      const claimQty = r.shortage.plus(r.rejected);
      return {
        lineNo: l.lineNo, productId: l.productId, expected: r.expected?.toString() ?? null, accepted: r.accepted.toString(), rejected: r.rejected.toString(),
        shortage: r.shortage.toString(), surplus: r.surplus.toString(), reason: l.discrepancyReason ?? null, note: l.discrepancyNote ?? null,
        claimAmount: price ? price.times(claimQty).toDecimalPlaces(2).toFixed(2) : null,
        surplusAmount: price ? price.times(r.surplus).toDecimalPlaces(2).toFixed(2) : null,
      };
    });
  const sum = (k: 'claimAmount' | 'surplusAmount') => rows.reduce((a, x) => a.plus(x[k] ?? 0), new D(0)).toFixed(2);
  return { lines: rows, claimAmount: sum('claimAmount'), surplusAmount: sum('surplusAmount'), hasDiscrepancy: rows.length > 0 };
}
