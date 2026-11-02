// FP-034: цепочка «заказ покупателя → реализация → возврат». Цены и НДС фиксируются в заказе (снимок на дату заказа:
// прайс-листы и скидки FP-027, ставка НДС) и дальше не пересчитываются: реализация по заказу берёт цены заказа,
// возврат — цены реализации. Исполнение — частями, но не больше заказанного; возврат — не больше отгруженного
// (за вычетом прежних возвратов); проверка при проведении под блокировкой документа-основания.
import { Prisma } from '@prisma/client';
import { AccError } from '../common/acc-error';
import { OrgContext } from '../access/org-context';
import { PricingService } from '../../pricing/pricing.service';
import { evaluate } from '../../pricing/engine';
import { standardVatRate } from './vat';

type Tx = Prisma.TransactionClient;
type Dec = Prisma.Decimal;
const D = Prisma.Decimal;

/** Документ-основание → какие документы по нему исполняются (для лимитов и цен). */
export const BASIS: Record<string, { base: string[]; what: string; prices: boolean; strictStore: boolean }> = {
  DEMAND: { base: ['CUSTOMER_ORDER'], what: 'заказ покупателя', prices: true, strictStore: true },
  SALES_RETURN: { base: ['DEMAND'], what: 'реализация', prices: true, strictStore: false },
  RETAIL_RETURN: { base: ['RETAIL_DEMAND'], what: 'розничный чек', prices: true, strictStore: false },
  // FP-035: поступление по заказу поставщику — поставщик и товары заказа; цены — по накладной (могут отличаться).
  SUPPLY: { base: ['PURCHASE_ORDER'], what: 'заказ поставщику', prices: false, strictStore: false },
  PURCHASE_RETURN: { base: ['SUPPLY'], what: 'поступление', prices: true, strictStore: false },
};
export const RETURNS = ['SALES_RETURN', 'RETAIL_RETURN', 'PURCHASE_RETURN'];
/** Возврат поставщику — приход основания (партии прихода); возврат покупателя — расход основания. */
const lotsSign = (docType: string) => (docType === 'PURCHASE_RETURN' ? 1 : -1);

interface LineIn { productId: string; qty: string | number; price?: string | number; discount?: string | number; vatRate?: string | number | null; lotNumber?: string | null; expiryDate?: string | null }
interface DocIn {
  docType: string; date: string; storeId?: string; counterpartyId?: string; baseId?: string; lines?: LineIn[]; comment?: string;
  vatIncluded?: boolean; noBasis?: boolean; returnReason?: string; pricing?: any;
}

/**
 * Снимок цен заказа: строки без цены — по прайс-листам и скидкам на дату заказа (склад заказа); ставка НДС строки
 * фиксируется явно (товара или стандартная на дату). Источник цен — в реквизитах заказа (pricing).
 */
export async function snapshotOrder(tx: Tx, ctx: OrgContext, input: DocIn) {
  if (input.docType !== 'CUSTOMER_ORDER') return;
  const lines = input.lines ?? [];
  const date = String(input.date).slice(0, 10);
  const need = lines.filter((l) => l.price === undefined || l.price === null || l.price === '');
  const pricing: any[] = [];
  if (need.length) {
    const svc = new PricingService(tx as any);
    const scope = { tenantId: ctx.tenantId, organizationId: ctx.organizationId, userId: ctx.userId };
    const at = new Date(date + 'T00:00:00.000Z');
    const payload = await svc.compile(scope, input.storeId ?? null, at, at, tx as any);
    const res = evaluate(payload, { date, storeId: input.storeId ?? null, lines: need.map((l) => ({ productId: l.productId, qty: String(l.qty) })) });
    res.lines.forEach((p, i) => {
      const l = need[i];
      if (p.basePrice === null) throw new AccError('PRICE_MISSING', `Нет цены «${l.productId}» в действующих прайс-листах на ${date}`, { fix: 'Укажите цену в строке или добавьте товар в прайс-лист.', details: { productId: l.productId } });
      l.price = p.basePrice;
      const gross = new D(p.gross), disc = new D(p.discount);
      if (disc.gt(0) && gross.gt(0)) l.discount = disc.div(gross).times(100).toDecimalPlaces(2).toString();
      pricing.push({ productId: l.productId, priceListId: p.priceListId, priceListName: p.priceListName, discountId: p.discountId, discountName: p.discountName, basePrice: p.basePrice, discount: p.discount });
    });
  }
  // Ставка НДС — явно в строке: изменение ставки или карточки товара после заказа цену заказа не меняет.
  const products = await tx.product.findMany({ where: { id: { in: lines.map((l) => l.productId) } }, select: { id: true, vatRate: true } });
  const std = await standardVatRate(tx, new Date(date + 'T00:00:00.000Z'));
  for (const l of lines) {
    if (l.vatRate === undefined || l.vatRate === null || l.vatRate === '') {
      l.vatRate = (products.find((p) => p.id === l.productId)?.vatRate ?? std).toString();
    }
  }
  if (pricing.length) input.pricing = { at: date, source: 'live', lines: pricing };
}

/**
 * Документ по основанию: реализация — по заказу (склад и покупатель заказа, цены и НДС заказа), возврат — по реализации
 * (покупатель и цены реализации; склад по умолчанию — склад реализации). Цены из запроса не принимаются — берутся из
 * основания. Возврат без основания — только явно, с причиной.
 */
export async function applyBasis(tx: Tx, input: DocIn) {
  const rule = BASIS[input.docType];
  if (!rule) return;
  if (!input.baseId) {
    if (RETURNS.includes(input.docType)) {
      if (!input.noBasis || String(input.returnReason ?? '').trim().length < 5) {
        throw new AccError('RETURN_BASIS_REQUIRED', 'Возврат оформляется на основании реализации', { fix: 'Откройте реализацию и выберите «Создать на основании → Возврат». Без основания — отметьте «без основания» и укажите причину (не короче 5 символов).' });
      }
    }
    return;
  }
  const base = await tx.document.findUnique({ where: { id: input.baseId }, include: { lines: { orderBy: { lineNo: 'asc' } } } });
  if (!base || !rule.base.includes(base.docType)) {
    // Основание другого вида (например, возврат поставщику по поступлению) — не по этой цепочке.
    if (RETURNS.includes(input.docType) || input.docType === 'DEMAND' || input.docType === 'SUPPLY') throw new AccError('BASIS_WRONG', `Основание должно быть: ${rule.what}`);
    return;
  }
  const a = (base.attributes ?? {}) as any;
  if (base.deleted || base.status === 'CANCELLED') throw new AccError('BASE_CANCELLED', `Документ ${base.number} помечен на удаление`);
  if (base.docType.endsWith('_ORDER') && a.closed) throw new AccError('ORDER_CLOSED', `Заказ ${base.number} закрыт — по нему больше не отгружают`, { fix: a.closed.reason ? `Причина закрытия: ${a.closed.reason}` : undefined });
  if (RETURNS.includes(input.docType) && base.status !== 'POSTED') throw new AccError('BASE_NOT_POSTED', `Возврат — только по проведённой реализации (${base.number} — черновик)`);
  if (base.counterpartyId && input.counterpartyId && input.counterpartyId !== base.counterpartyId) {
    throw new AccError('BASIS_COUNTERPARTY', `Покупатель отличается от покупателя основания ${base.number}`);
  }
  input.counterpartyId = base.counterpartyId ?? input.counterpartyId;
  if (rule.strictStore) {
    if (base.storeId && input.storeId && input.storeId !== base.storeId) {
      throw new AccError('ORDER_STORE', `Отгрузка по заказу ${base.number} — со склада заказа`, { fix: 'Смените склад в заказе (резерв перерезервируется) или отгрузите без основания.' });
    }
    input.storeId = base.storeId ?? input.storeId;
  } else if (!input.storeId) input.storeId = base.storeId ?? undefined;
  if (a.vatIncluded !== undefined) input.vatIncluded = a.vatIncluded;
  const lots = RETURNS.includes(input.docType) ? await shippedLots(tx, base.id, lotsSign(input.docType)) : new Map<string, { lotNumber: string; expiryDate: Date | null }[]>();
  for (const [i, l] of (input.lines ?? []).entries()) {
    const b = base.lines.find((x) => x.productId === l.productId);
    if (!b) throw new AccError('BASIS_PRODUCT', `Строка ${i + 1}: товара нет в основании ${base.number}`);
    if (rule.prices) {
      l.price = b.price?.toString() ?? '0';
      l.discount = b.discount?.toString() ?? undefined;
      l.vatRate = b.vatRate?.toString() ?? null;
    }
    // Возврат партионного товара — той партией, что отгружали: одна — подставляется, несколько — указать.
    const shipped = lots.get(l.productId) ?? [];
    if (shipped.length && RETURNS.includes(input.docType)) {
      const lot = (l.lotNumber ?? '').trim();
      if (!lot) {
        if (shipped.length > 1) throw new AccError('LOT_REQUIRED', `Строка ${i + 1}: по ${base.number} отгружены партии ${shipped.map((x) => x.lotNumber).join(', ')} — укажите, какая возвращается`);
        l.lotNumber = shipped[0].lotNumber;
        l.expiryDate = shipped[0].expiryDate ? shipped[0].expiryDate.toISOString().slice(0, 10) : null;
      } else {
        const hit = shipped.find((x) => x.lotNumber === lot);
        if (!hit) throw new AccError('RETURN_LOT_NOT_SHIPPED', `Строка ${i + 1}: партия ${lot} по ${base.number} не отгружалась (отгружены: ${shipped.map((x) => x.lotNumber).join(', ')})`);
        l.expiryDate = hit.expiryDate ? hit.expiryDate.toISOString().slice(0, 10) : null;
      }
    }
  }
}

/** Партии, отгруженные документом (действующие движения расхода), по товару. */
export async function shippedLots(tx: Tx, docId: string, sign: 1 | -1 = -1) {
  const rows = await tx.$queryRaw<{ product_id: string; lot: string; expiry: Date | null }[]>`
    SELECT m.product_id, m.lot_number AS lot, max(m.expiry_date) AS expiry FROM stock_movements m
    WHERE m.source_id = ${docId} AND sign(m.qty) = ${sign} AND m.lot_number IS NOT NULL AND m.reverses_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM stock_movements r WHERE r.reverses_id = m.id)
    GROUP BY m.product_id, m.lot_number ORDER BY m.product_id, m.lot_number`;
  const out = new Map<string, { lotNumber: string; expiryDate: Date | null }[]>();
  for (const r of rows) out.set(r.product_id, [...(out.get(r.product_id) ?? []), { lotNumber: r.lot, expiryDate: r.expiry }]);
  return out;
}

/** Сумма количеств по товарам. */
const byProduct = (lines: { productId: string; qty: any }[]) => {
  const m = new Map<string, Dec>();
  for (const l of lines) m.set(l.productId, (m.get(l.productId) ?? new D(0)).plus(l.qty));
  return m;
};

/**
 * При проведении: не больше заказанного (реализация по заказу) и не больше отгруженного за вычетом прежних возвратов
 * (возврат). Основание блокируется — параллельные отгрузки/возвраты по нему идут по очереди.
 */
export async function assertBasisLimits(tx: Tx, doc: { id: string; docType: string; attributes: any; lines: { productId: string; qty: any }[] }) {
  const rule = BASIS[doc.docType];
  const baseId = doc.attributes?.baseId;
  // FP-035: возврат поставщику проводится только с причиной (брак, пересорт, излишек…); черновик — можно без неё.
  if (doc.docType === 'PURCHASE_RETURN' && String(doc.attributes?.returnReason ?? '').trim().length < 5) {
    throw new AccError('RETURN_REASON_REQUIRED', 'Укажите причину возврата поставщику (не короче 5 символов)', { fix: 'Например: брак, пересорт, просрочка, излишек по поставке.' });
  }
  // FP-035: заказ поставщику проводится с ценами (иначе бюджет закупок не контролируется).
  if (doc.docType === 'PURCHASE_ORDER') {
    const bad = (doc.lines as any[]).findIndex((l) => !l.price || new D(l.price).lte(0));
    if (bad >= 0) throw new AccError('PRICE_REQUIRED', `Заказ поставщику, строка ${bad + 1}: укажите цену — без неё не проверить бюджет закупок`);
    return;
  }
  // Поступление сверх заказа — излишек: фиксируется расхождением приёмки (FP-030), не запрещается.
  if (!rule || !baseId || doc.docType === 'SUPPLY') return;
  await tx.$queryRaw`SELECT id FROM documents WHERE id = ${baseId} FOR UPDATE`;
  const base = await tx.document.findUnique({ where: { id: baseId }, include: { lines: true } });
  if (!base || !rule.base.includes(base.docType)) return;
  if (base.docType.endsWith('_ORDER') && (base.attributes as any)?.closed) throw new AccError('ORDER_CLOSED', `Заказ ${base.number} закрыт`);
  const siblings = await tx.document.findMany({
    where: { docType: doc.docType as any, status: 'POSTED', deleted: false, id: { not: doc.id }, attributes: { path: ['baseId'], equals: baseId } },
    include: { lines: true },
  });
  const limit = byProduct(base.lines), done = byProduct(siblings.flatMap((x) => x.lines)), mine = byProduct(doc.lines);
  for (const [productId, q] of mine) {
    const left = (limit.get(productId) ?? new D(0)).minus(done.get(productId) ?? 0);
    if (q.gt(left)) {
      const product = await tx.product.findUnique({ where: { id: productId }, select: { name: true } });
      throw RETURNS.includes(doc.docType)
        ? new AccError('RETURN_EXCEEDS_SHIPPED', `«${product?.name ?? productId}»: по ${base.number} можно вернуть ${D.max(left, 0)}, в возврате ${q}`, { status: 409, details: { productId, left: left.toString() } })
        : new AccError('ORDER_OVERSHIP', `«${product?.name ?? productId}»: по заказу ${base.number} осталось отгрузить ${D.max(left, 0)}, в реализации ${q}`, { status: 409, details: { productId, left: left.toString() } });
    }
  }
}
