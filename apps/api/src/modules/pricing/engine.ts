// FP-027: расчёт цены, скидки и округления по скомпилированному набору правил (чистые функции, только Decimal).
// Один и тот же набор (SnapshotPayload) используется сервером для предпросмотра и кассой в офлайне — поэтому расчёт
// детерминирован и не зависит от БД: те же входные данные и снимок → те же суммы до тиына.
import { Prisma } from '@prisma/client';

// decimal.js из поставки Prisma (тот же, что в суммах БД); своя копия — с явной точностью и округлением.
const Decimal = Prisma.Decimal;
const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
type Dec = Prisma.Decimal;

export const ENGINE_VERSION = 1;

export interface PayloadPriceList {
  id: string;
  name: string;
  priority: number;
  validFrom: string; // YYYY-MM-DD, включительно
  validTo: string | null; // включительно; null — бессрочно
  storeIds: string[]; // пусто — все магазины организации
  items: { productId: string; price: string; minQty: string }[];
}

export type DiscountKind = 'PERCENT' | 'AMOUNT' | 'FIXED_PRICE';

export interface PayloadDiscount {
  id: string;
  name: string;
  kind: DiscountKind;
  value: string; // PERCENT — проценты; AMOUNT — сумма на единицу; FIXED_PRICE — цена за единицу
  priority: number;
  validFrom: string;
  validTo: string | null;
  storeIds: string[];
  productIds: string[]; // пусто вместе с groupIds — на все товары
  groupIds: string[];
  minQty: string | null; // по количеству в строке
  minReceiptAmount: string | null; // по сумме чека до скидок
}

export interface SnapshotPayload {
  engineVersion: number;
  organizationId: string;
  currency: string;
  rounding: { receiptStep: string; receiptMode: 'HALF_UP' | 'DOWN' };
  priceLists: PayloadPriceList[];
  discounts: PayloadDiscount[];
  /** Группа товара — для скидок на группу. */
  productGroups: Record<string, string | null>;
}

export interface PriceLineInput {
  productId: string;
  qty: string;
}

export interface PricedLine {
  productId: string;
  qty: string;
  basePrice: string | null; // null — цены нет ни в одном действующем прайс-листе
  priceListId: string | null;
  priceListName: string | null;
  gross: string; // basePrice × qty, до тиына
  discountId: string | null;
  discountName: string | null;
  discount: string; // сумма скидки по строке, до тиына
  amount: string; // gross − discount
  /** Почему не применены другие скидки (для предпросмотра) */
  notes: string[];
}

export interface PricingResult {
  date: string;
  storeId: string | null;
  lines: PricedLine[];
  gross: string;
  discount: string;
  total: string; // Σ amount строк
  rounding: string; // округление итога чека (может быть отрицательным)
  payable: string; // total + rounding
  missing: string[]; // товары без цены
}

export class PricingError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

const money = (v: Dec) => v.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
const fmt = (v: Dec) => money(v).toFixed(2);
const inInterval = (from: string, to: string | null, day: string) => from <= day && (to === null || day <= to);
const forStore = (storeIds: string[], storeId: string | null) => storeIds.length === 0 || (storeId !== null && storeIds.includes(storeId));

/** Цена товара на дату: действующие прайс-листы магазина → наибольший приоритет → наибольший порог количества ≤ qty. */
export function basePrice(p: SnapshotPayload, productId: string, qty: Dec, day: string, storeId: string | null) {
  const lists = p.priceLists
    .filter((l) => inInterval(l.validFrom, l.validTo, day) && forStore(l.storeIds, storeId))
    // Приоритет; при равном — более поздний старт (новая акция перекрывает базовый лист); затем id — детерминированно.
    .sort((a, b) => b.priority - a.priority || b.validFrom.localeCompare(a.validFrom) || a.id.localeCompare(b.id));
  for (const l of lists) {
    const tiers = l.items.filter((i) => i.productId === productId && new D(i.minQty).lte(qty)).sort((a, b) => new D(b.minQty).cmp(new D(a.minQty)));
    if (tiers.length) return { list: l, price: new D(tiers[0].price) };
  }
  return null;
}

function discountApplies(d: PayloadDiscount, p: SnapshotPayload, line: { productId: string; qty: Dec }, day: string, storeId: string | null, receiptGross: Dec): string | null {
  if (!inInterval(d.validFrom, d.validTo, day)) return 'не действует на дату';
  if (!forStore(d.storeIds, storeId)) return 'не для этого магазина';
  const anyProduct = d.productIds.length === 0 && d.groupIds.length === 0;
  const group = p.productGroups[line.productId] ?? null;
  if (!anyProduct && !d.productIds.includes(line.productId) && !(group && d.groupIds.includes(group))) return 'не на этот товар';
  if (d.minQty && line.qty.lt(new D(d.minQty))) return `от ${new D(d.minQty).toString()} шт.`;
  if (d.minReceiptAmount && receiptGross.lt(new D(d.minReceiptAmount))) return `при чеке от ${fmt(new D(d.minReceiptAmount))}`;
  return null;
}

/** Скидка по строке (до тиына), не больше суммы строки; FIXED_PRICE выше базовой цены скидкой не считается. */
export function discountAmount(d: PayloadDiscount, price: Dec, qty: Dec, gross: Dec): Dec {
  const v = new D(d.value);
  let x: Dec;
  if (d.kind === 'PERCENT') x = gross.times(v).div(100);
  else if (d.kind === 'AMOUNT') x = v.times(qty);
  else x = price.minus(v).times(qty);
  x = money(Decimal.max(x, 0) as Dec);
  return Decimal.min(x, gross) as Dec;
}

/** Округление итога чека до шага (0.01 — без округления; 1, 5, 10 ₸ — наличный расчёт). */
export function roundReceipt(total: Dec, step: string, mode: 'HALF_UP' | 'DOWN'): Dec {
  const s = new D(step);
  if (s.lte(0)) throw new PricingError('ROUNDING_STEP', 'Шаг округления должен быть больше нуля');
  const n = total.div(s).toDecimalPlaces(0, mode === 'DOWN' ? Decimal.ROUND_DOWN : Decimal.ROUND_HALF_UP);
  return money(n.times(s) as Dec);
}

/**
 * Расчёт чека. На строку — одна скидка (не суммируются): с наибольшим приоритетом, при равном — самая выгодная
 * покупателю, затем по id. Скидка от суммы чека считается от суммы до скидок.
 */
export function evaluate(p: SnapshotPayload, input: { date: string; storeId?: string | null; lines: PriceLineInput[] }): PricingResult {
  if (p.engineVersion !== ENGINE_VERSION) throw new PricingError('ENGINE_VERSION', `Снимок для версии расчёта ${p.engineVersion}, поддерживается ${ENGINE_VERSION}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new PricingError('DATE', 'Дата — ГГГГ-ММ-ДД');
  const storeId = input.storeId ?? null;
  const base = input.lines.map((l, i) => {
    let qty: Dec;
    try { qty = new D(l.qty); } catch { throw new PricingError('QTY', `Строка ${i + 1}: количество — число`); }
    if (!qty.isFinite() || qty.lte(0)) throw new PricingError('QTY', `Строка ${i + 1}: количество больше нуля`);
    const bp = basePrice(p, l.productId, qty, input.date, storeId);
    const gross = bp ? money(bp.price.times(qty) as Dec) : new D(0);
    return { l, qty, bp, gross };
  });
  const receiptGross = base.reduce((s, x) => s.plus(x.gross), new D(0)) as Dec;

  const lines: PricedLine[] = base.map(({ l, qty, bp, gross }) => {
    const notes: string[] = [];
    let best: { d: PayloadDiscount; amount: Dec } | null = null;
    if (bp) {
      for (const d of p.discounts) {
        const why = discountApplies(d, p, { productId: l.productId, qty }, input.date, storeId, receiptGross);
        if (why) {
          if (why !== 'не на этот товар' && why !== 'не для этого магазина' && why !== 'не действует на дату') notes.push(`«${d.name}»: ${why}`);
          continue;
        }
        const amount = discountAmount(d, bp.price, qty, gross);
        if (amount.lte(0)) continue;
        if (!best || d.priority > best.d.priority || (d.priority === best.d.priority && (amount.gt(best.amount) || (amount.eq(best.amount) && d.id < best.d.id)))) best = { d, amount };
      }
    }
    const discount = best ? best.amount : new D(0);
    return {
      productId: l.productId, qty: qty.toString(), basePrice: bp ? fmt(bp.price) : null, priceListId: bp?.list.id ?? null, priceListName: bp?.list.name ?? null,
      gross: fmt(gross), discountId: best?.d.id ?? null, discountName: best?.d.name ?? null, discount: fmt(discount), amount: fmt(gross.minus(discount) as Dec), notes,
    };
  });
  const sum = (k: 'gross' | 'discount' | 'amount') => lines.reduce((s, x) => s.plus(x[k]), new D(0)) as Dec;
  const total = sum('amount');
  const payable = roundReceipt(total, p.rounding.receiptStep, p.rounding.receiptMode);
  return {
    date: input.date, storeId, lines, gross: fmt(sum('gross')), discount: fmt(sum('discount')), total: fmt(total),
    rounding: fmt(payable.minus(total) as Dec), payable: fmt(payable), missing: lines.filter((x) => x.basePrice === null).map((x) => x.productId),
  };
}
