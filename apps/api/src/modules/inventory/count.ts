// FP-033: инвентаризация (сверка с фактом) и причины списаний. Учётное количество считает сервер — по журналу
// движений на конец даты инвентаризации (по складу, ячейке, партии), без движений самой инвентаризации; при проведении
// оно сверяется заново: если учёт изменился после подсчёта, проводить нельзя — сначала обновить учётные.
import { Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;
type Dec = Prisma.Decimal;
const D = Prisma.Decimal;

export const INVENTORY_REASONS: Record<string, string> = {
  NATURAL_LOSS: 'естественная убыль', DAMAGED: 'порча / бой', THEFT: 'хищение', MISCOUNT: 'пересорт',
  UNRECORDED: 'неучтённое поступление / отгрузка', OTHER: 'другое',
};
export const LOSS_REASONS: Record<string, string> = {
  DAMAGED: 'порча / бой', EXPIRED: 'истёк срок годности', THEFT: 'хищение', NATURAL_LOSS: 'естественная убыль', OTHER: 'другое',
};

export class CountError extends Error {
  constructor(public code: string, message: string, public fix?: string, public details?: any) { super(message); }
}

const endOfDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));

/** Учётное количество на конец дня `on`: склад, ячейка, партия (null — остаток без партии). */
export async function bookQty(tx: Tx, k: { productId: string; storeId: string; binId: string | null; lotNumber: string | null; on: Date; excludeSourceId?: string }) {
  const [r] = await tx.$queryRaw<{ q: string | null }[]>`
    SELECT sum(qty)::text AS q FROM stock_movements
    WHERE product_id = ${k.productId} AND store_id = ${k.storeId} AND bin_id IS NOT DISTINCT FROM ${k.binId}
      AND lot_number IS NOT DISTINCT FROM ${k.lotNumber}::text AND occurred_at < ${endOfDay(k.on)}
      AND source_id <> ${k.excludeSourceId ?? ''}`;
  return new D(r?.q ?? 0);
}

/** Позиции склада (товар, ячейка, партия, срок) с ненулевым учётным остатком на конец дня — для «заполнить по остаткам». */
export async function stockPositions(tx: Tx, storeId: string, on: Date, binId?: string | null, excludeSourceId?: string) {
  const rows = await tx.$queryRaw<{ product_id: string; bin_id: string | null; lot: string | null; expiry: Date | null; q: string }[]>`
    SELECT m.product_id, m.bin_id, m.lot_number AS lot, max(m.expiry_date) AS expiry, sum(m.qty)::text AS q
    FROM stock_movements m JOIN products p ON p.id = m.product_id
    WHERE m.store_id = ${storeId} AND m.occurred_at < ${endOfDay(on)} AND m.source_id <> ${excludeSourceId ?? ''}
      AND (${binId ?? null}::text IS NULL OR m.bin_id = ${binId ?? null})
    GROUP BY m.product_id, m.bin_id, m.lot_number, p.name HAVING sum(m.qty) <> 0
    ORDER BY p.name, m.bin_id NULLS FIRST, max(m.expiry_date) NULLS LAST, m.lot_number`;
  return rows.map((r) => ({ productId: r.product_id, binId: r.bin_id, lotNumber: r.lot, expiryDate: r.expiry, bookQty: new D(r.q) }));
}

/** Строка инвентаризации: факт ≥ 0; расхождение — с причиной и ценой оценки; «другое» — с пояснением. */
export function checkInventoryLine(n: number, l: { qty: Dec; bookQty: Dec | null; price: Dec | null; discrepancyReason: string | null; discrepancyNote: string | null }) {
  if (l.qty.lt(0)) throw new CountError('BAD_QTY', `Строка ${n}: фактическое количество не может быть отрицательным`);
  const diff = l.bookQty == null ? new D(0) : l.qty.minus(l.bookQty);
  if (diff.isZero()) {
    if (l.discrepancyReason) throw new CountError('COUNT_REASON', `Строка ${n}: расхождения нет — причина не нужна`);
    return;
  }
  if (!l.discrepancyReason) throw new CountError('COUNT_REASON_REQUIRED', `Строка ${n}: учётное ${l.bookQty}, факт ${l.qty} — укажите причину расхождения`, 'Причины: естественная убыль, порча, хищение, пересорт, неучтённое движение, другое (с пояснением).');
  if (!INVENTORY_REASONS[l.discrepancyReason]) throw new CountError('COUNT_REASON', `Строка ${n}: неизвестная причина ${l.discrepancyReason}`);
  if (l.discrepancyReason === 'OTHER' && !l.discrepancyNote) throw new CountError('COUNT_REASON', `Строка ${n}: для причины «другое» нужно пояснение`);
  if (!l.price || l.price.lte(0)) throw new CountError('COUNT_PRICE_REQUIRED', `Строка ${n}: укажите цену для оценки расхождения`, 'Для излишка — цена оприходования; для недостачи — оценка (списание всё равно по себестоимости).');
}

/** Списание: причина — по строке или по документу; «другое» — с пояснением. */
export function checkLossLine(n: number, reason: string | null, note: string | null) {
  if (!reason) throw new CountError('LOSS_REASON_REQUIRED', `Строка ${n}: укажите причину списания`, 'Порча, истёк срок, хищение, естественная убыль или другое (с пояснением).');
  if (!LOSS_REASONS[reason]) throw new CountError('LOSS_REASON', `Строка ${n}: неизвестная причина списания ${reason}`);
  if (reason === 'OTHER' && !note) throw new CountError('LOSS_REASON', `Строка ${n}: для причины «другое» нужно пояснение`);
}

/** Сумма расхождений инвентаризации (для согласования): Σ |факт − учётное| × цена. */
export function inventoryValue(lines: { qty: any; bookQty?: any; price?: any }[]) {
  return lines.reduce((a, l) => (l.bookQty == null ? a : a.plus(new D(l.qty).minus(l.bookQty).abs().times(l.price ?? 0))), new D(0)).toDecimalPlaces(2);
}
