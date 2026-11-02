// FP-033: партии и сроки годности. Приход партионного товара — с номером партии (и сроком, если ведётся); расход без
// указанной партии списывает партии по FEFO (раньше истекающие — первыми); просроченную партию нельзя продать,
// переместить или вернуть в оборот — только списать (или вернуть поставщику, инвентаризировать). Остаток партии в
// минус не уходит — это проверяет и БД (sql/120_fp033_lots.sql).
import { Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;
type Dec = Prisma.Decimal;
const D = Prisma.Decimal;

export class LotError extends Error {
  constructor(public code: string, message: string, public fix?: string) { super(message); }
}

/** Виды движений, которым просроченная партия разрешена (списание, возврат поставщику, инвентаризация). */
export const EXPIRED_ALLOWED = ['WRITE_OFF', 'PURCHASE_RETURN', 'INVENTORY_SHORTAGE'];

export interface LotBalance { lotNumber: string; expiryDate: Date | null; qty: Dec }

const dayOf = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
/** Партия просрочена на дату документа: срок годности раньше даты (день срока — ещё годен). */
export const isExpired = (expiry: Date | null | undefined, on: Date) => !!expiry && dayOf(expiry) < dayOf(on);

/** Остатки партий товара на складе/ячейке (> 0), в порядке FEFO: срок по возрастанию (без срока — в конце), номер. */
export async function lotBalances(tx: Tx, productId: string, storeId: string, binId: string | null): Promise<LotBalance[]> {
  const rows = await tx.$queryRaw<{ lot: string; expiry: Date | null; qty: string }[]>`
    SELECT lot_number AS lot, max(expiry_date) AS expiry, sum(qty)::text AS qty FROM stock_movements
    WHERE product_id = ${productId} AND store_id = ${storeId} AND bin_id IS NOT DISTINCT FROM ${binId} AND lot_number IS NOT NULL
    GROUP BY lot_number HAVING sum(qty) > 0`;
  return rows
    .map((r) => ({ lotNumber: r.lot, expiryDate: r.expiry, qty: new D(r.qty) }))
    .sort((a, b) => (a.expiryDate?.getTime() ?? Infinity) - (b.expiryDate?.getTime() ?? Infinity) || a.lotNumber.localeCompare(b.lotNumber));
}

/**
 * FEFO: какие партии и сколько списать. Просроченные пропускаются, если вид движения их не допускает. Возвращает куски
 * и нехватку (сколько не покрыто партиями).
 */
export function allocateFefo(balances: LotBalance[], qty: Dec, on: Date, allowExpired: boolean) {
  const pieces: { lotNumber: string; expiryDate: Date | null; qty: Dec }[] = [];
  let need = qty;
  for (const b of balances) {
    if (need.lte(0)) break;
    if (!allowExpired && isExpired(b.expiryDate, on)) continue;
    const take = D.min(need, b.qty);
    pieces.push({ lotNumber: b.lotNumber, expiryDate: b.expiryDate, qty: take });
    need = need.minus(take);
  }
  return { pieces, shortfall: need };
}

/** Проверка строк документа по партиям: приход партионного — с партией (и сроком, если ведётся). */
export function checkLotLine(n: number, incoming: boolean, p: { lotTracking: boolean; expiryTracking: boolean; name: string }, l: { lotNumber?: string | null; expiryDate?: Date | null }) {
  if (!incoming) return;
  if (p.lotTracking && !l.lotNumber) throw new LotError('LOT_REQUIRED', `Строка ${n}: «${p.name}» учитывается по партиям — укажите номер партии`, 'Введите номер партии (серию) с упаковки или накладной.');
  if (p.expiryTracking && !l.expiryDate) throw new LotError('EXPIRY_REQUIRED', `Строка ${n}: «${p.name}» — укажите срок годности`);
}
