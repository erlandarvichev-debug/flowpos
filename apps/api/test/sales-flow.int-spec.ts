// FP-034: заказ покупателя → реализация → возврат: снимок цен и НДС в заказе, частичное исполнение (не больше
// заказанного, параллельно — тоже), закрытие остатка, возврат только по основанию и не больше отгруженного, себестоимость
// возврата — из исходной отгрузки, склад возврата — на БД.
import { Prisma } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { PricingService } from '../src/modules/pricing/pricing.service';
import { OrgContext } from '../src/modules/accounting/access/org-context';
import { makeServices, makeOrg, makeTrade } from './accounting-helpers';

const prisma = new PrismaService();
const s = makeServices(prisma);
const pricing = new PricingService(prisma);
const D = Prisma.Decimal;

async function code(p: Promise<unknown>) {
  try { await p; return 'OK'; } catch (e: any) { return e?.response?.code ?? e?.code ?? e?.message; }
}
const scope = (ctx: OrgContext) => ({ tenantId: ctx.tenantId, organizationId: ctx.organizationId, userId: ctx.userId, role: 'chief_accountant' });
const costOf = async (docId: string) => ((await prisma.accEntry.findMany({ where: { sourceType: 'COST', sourceId: { startsWith: `TRADE_DOCUMENT:${docId}:` }, status: 'ACTIVE' }, include: { postings: { include: { account: true } } } })).flatMap((e) => e.postings).map((p) => `${p.side}${p.account.code}:${new D(p.amount).toFixed(2)}`).sort());

beforeAll(async () => {
  await prisma.$connect();
  await s.chart.bootstrap();
});
afterAll(() => prisma.$disconnect());

async function world(vatPayer = false) {
  const ctx = await makeOrg(prisma);
  const t = await makeTrade(prisma, ctx, { vatPayer });
  const sup = (qty: string, price = '100', date = '2026-10-01') => s.trade.create(ctx, { docType: 'SUPPLY', date, counterpartyId: t.supplier.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty, price }] });
  const order = (qty: string, extra: any = {}) => s.trade.create(ctx, { docType: 'CUSTOMER_ORDER', date: '2026-10-02', counterpartyId: t.customer.id, storeId: t.s1.id, lines: [{ productId: t.goods.id, qty, ...extra }] });
  return { ctx, t, sup, order };
}

describe('FP-034: заказ — снимок цен и НДС', () => {
  it('цена заказа — из прайс-листа на дату заказа, НДС строки фиксируется; реализация по заказу берёт их, а не текущие', async () => {
    const { ctx, t, sup, order } = await world(true);
    await sup('20', '100');
    expect(await code(order('1'))).toBe('PRICE_MISSING');
    const pl = await pricing.createPriceList(scope(ctx), { name: 'Розница', validFrom: '2026-01-01' });
    await pricing.setItems(scope(ctx), pl.id, { upsert: [{ productId: t.goods.id, price: '300' }] });
    await pricing.updatePriceList(scope(ctx), pl.id, { status: 'ACTIVE' });
    const o = await order('5');
    expect([o.lines[0].price!.toString(), o.lines[0].vatRate!.toString()]).toEqual(['300', '16']);
    expect((o.attributes as any).pricing).toMatchObject({ at: '2026-10-02', lines: [{ productId: t.goods.id, priceListId: pl.id, basePrice: '300.00' }] });
    // После заказа цена в прайсе и ставка в карточке товара изменились — заказ и отгрузка по нему не меняются.
    await pricing.setItems(scope(ctx), pl.id, { upsert: [{ productId: t.goods.id, price: '350' }] });
    await prisma.product.update({ where: { id: t.goods.id }, data: { vatRate: 0 } });
    const ship = await s.trade.fromBase(ctx, o.id, 'DEMAND', '2026-10-03');
    expect([ship.lines[0].price!.toString(), ship.lines[0].vatRate!.toString()]).toEqual(['300', '16']);
    // Цена из запроса для реализации по заказу не принимается.
    const forced = await s.trade.create(ctx, { docType: 'DEMAND', date: '2026-10-03', counterpartyId: t.customer.id, storeId: t.s1.id, baseId: o.id, lines: [{ productId: t.goods.id, qty: '1', price: '1', vatRate: '0' }] });
    expect([forced.lines[0].price!.toString(), forced.lines[0].vatRate!.toString()]).toEqual(['300', '16']);
    const posted = await s.trade.post(ctx, ship.id);
    expect(posted.entry!.postings.filter((p: any) => p.account.code === '3130').map((p: any) => new D(p.amount).toFixed(2))).toEqual(['206.90']); // 1500 с НДС 16%
  });
});

describe('FP-034: частичное исполнение заказа', () => {
  it('отгрузки частями, не больше заказанного (и параллельно), склад заказа, закрытие остатка', async () => {
    const { ctx, t, sup, order } = await world();
    await sup('30');
    const o = await order('10', { price: '200' });
    await s.trade.reserve(ctx, o.id);
    const s1 = await s.trade.fromBase(ctx, o.id, 'DEMAND', '2026-10-03');
    await s.trade.update(ctx, s1.id, { expectedVersion: s1.version, lines: [{ productId: t.goods.id, qty: '4' }] });
    await s.trade.post(ctx, s1.id);
    expect((await s.trade.get(ctx, o.id)).fulfillment).toMatchObject({ state: 'PARTIAL', lines: [{ fulfilled: '4', remaining: '6' }] });
    expect(await code(s.trade.create(ctx, { docType: 'DEMAND', date: '2026-10-03', counterpartyId: t.customer.id, storeId: t.s2.id, baseId: o.id, lines: [{ productId: t.goods.id, qty: '1' }] }))).toBe('ORDER_STORE');
    expect(await code(s.trade.create(ctx, { docType: 'DEMAND', date: '2026-10-03', counterpartyId: t.customer.id, storeId: t.s1.id, baseId: o.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '7' }] }))).toBe('ORDER_OVERSHIP');
    // Две отгрузки по 6 параллельно при остатке 6 — проходит одна.
    const [a, b] = await Promise.all([1, 2].map(() => s.trade.create(ctx, { docType: 'DEMAND', date: '2026-10-04', counterpartyId: t.customer.id, storeId: t.s1.id, baseId: o.id, lines: [{ productId: t.goods.id, qty: '6' }] })));
    const res = await Promise.allSettled([s.trade.post(ctx, a.id), s.trade.post(ctx, b.id)]);
    expect(res.filter((r) => r.status === 'fulfilled').length).toBe(1);
    expect((res.find((r) => r.status === 'rejected') as any).reason.response.code).toBe('ORDER_OVERSHIP');
    expect((await s.trade.get(ctx, o.id)).fulfillment!.state).toBe('FULFILLED');
    expect(await code(s.trade.fromBase(ctx, o.id, 'DEMAND'))).toBe('BASE_FULFILLED');

    // Закрытие остатка: причина, резерв снят, новых отгрузок нет.
    const o2 = await order('5', { price: '200' });
    await s.trade.reserve(ctx, o2.id);
    const part = await s.trade.fromBase(ctx, o2.id, 'DEMAND', '2026-10-05');
    await s.trade.update(ctx, part.id, { expectedVersion: part.version, lines: [{ productId: t.goods.id, qty: '2' }] });
    await s.trade.post(ctx, part.id);
    expect(await code(s.trade.closeOrder(ctx, o2.id, { reason: 'нет' }))).toBe('REASON_REQUIRED');
    const closed = await s.trade.closeOrder(ctx, o2.id, { reason: 'Покупатель отказался от остатка' });
    expect(closed.fulfillment).toMatchObject({ state: 'CLOSED', closed: { reason: 'Покупатель отказался от остатка' }, lines: [{ remaining: '3' }] });
    expect(await prisma.stockReservation.count({ where: { sourceId: o2.id, remaining: { gt: 0 } } })).toBe(0);
    expect(await code(s.trade.fromBase(ctx, o2.id, 'DEMAND'))).toBe('ORDER_CLOSED');
    expect(await code(s.trade.reserve(ctx, o2.id))).toBe('ORDER_CLOSED');
    expect(await code(s.trade.update(ctx, o2.id, { expectedVersion: closed.version, comment: 'правка' }))).toBe('ORDER_CLOSED');
    expect((await s.trade.versions(ctx, o2.id)).map((v) => v.action)).toContain('CLOSE');
  });
});

describe('FP-034: возврат по основанию', () => {
  it('только по проведённой реализации, цены из неё, не больше отгруженного (за вычетом прежних); без основания — явно с причиной', async () => {
    const { ctx, t, sup } = await world();
    await sup('10');
    const sale = await s.trade.create(ctx, { docType: 'DEMAND', date: '2026-10-03', counterpartyId: t.customer.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '4', price: '250' }] });
    const ret = (qty: string, extra: any = {}) => s.trade.create(ctx, { docType: 'SALES_RETURN', date: '2026-10-05', counterpartyId: t.customer.id, storeId: t.s1.id, status: 'POSTED', baseId: sale.id, lines: [{ productId: t.goods.id, qty, price: '999' }], ...extra });
    expect(await code(s.trade.create(ctx, { docType: 'SALES_RETURN', date: '2026-10-05', counterpartyId: t.customer.id, storeId: t.s1.id, lines: [{ productId: t.goods.id, qty: '1', price: '250' }] }))).toBe('RETURN_BASIS_REQUIRED');
    expect(await code(s.trade.create(ctx, { docType: 'SALES_RETURN', date: '2026-10-05', counterpartyId: t.customer.id, storeId: t.s1.id, noBasis: true, returnReason: 'нет', lines: [{ productId: t.goods.id, qty: '1', price: '250' }] }))).toBe('RETURN_BASIS_REQUIRED');
    expect((await s.trade.create(ctx, { docType: 'SALES_RETURN', date: '2026-10-05', counterpartyId: t.customer.id, storeId: t.s1.id, noBasis: true, returnReason: 'чек утерян, по акту', lines: [{ productId: t.goods.id, qty: '1', price: '250' }] })).status).toBe('DRAFT');
    expect(await code(ret('1', { counterpartyId: t.supplier.id }))).toBe('BASIS_COUNTERPARTY');
    expect(await code(ret('1', { lines: [{ productId: t.goods2.id, qty: '1' }] }))).toBe('BASIS_PRODUCT');
    expect(await code(ret('5'))).toBe('RETURN_EXCEEDS_SHIPPED');
    const r1 = await ret('2');
    expect([r1.lines[0].price!.toString(), new D(r1.total!).toFixed(2)]).toEqual(['250', '500.00']); // цена реализации, не из запроса
    await ret('2');
    expect(await code(ret('1'))).toBe('RETURN_EXCEEDS_SHIPPED');
    expect((await s.trade.get(ctx, sale.id)).returns).toMatchObject({ lines: [{ shipped: '4', returned: '4', left: '0' }] });
    expect(await code(s.trade.fromBase(ctx, sale.id, 'SALES_RETURN'))).toBe('BASE_FULFILLED');
    const draftSale = await s.trade.create(ctx, { docType: 'DEMAND', date: '2026-10-03', counterpartyId: t.customer.id, storeId: t.s1.id, lines: [{ productId: t.goods.id, qty: '1', price: '250' }] });
    expect(await code(s.trade.create(ctx, { docType: 'SALES_RETURN', date: '2026-10-05', counterpartyId: t.customer.id, storeId: t.s1.id, baseId: draftSale.id, lines: [{ productId: t.goods.id, qty: '1' }] }))).toBe('BASE_NOT_POSTED');
  });

  it('себестоимость возврата — из исходной отгрузки (не средняя склада), склад возврата — любой своей организации', async () => {
    const { ctx, t, sup } = await world();
    await sup('1', '100', '2026-10-01');
    await sup('1', '200', '2026-10-02');
    const saleA = await s.trade.create(ctx, { docType: 'DEMAND', date: '2026-10-03', counterpartyId: t.customer.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '1', price: '500' }] });
    const saleB = await s.trade.create(ctx, { docType: 'DEMAND', date: '2026-10-04', counterpartyId: t.customer.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '1', price: '500' }] });
    expect([await costOf(saleA.id), await costOf(saleB.id)]).toEqual([['C1330:100.00', 'D7010:100.00'], ['C1330:200.00', 'D7010:200.00']]);
    // Возврат по первой продаже — на другой склад, по её себестоимости 100 (средняя на пустом складе дала бы 0).
    const rA = await s.trade.create(ctx, { docType: 'SALES_RETURN', date: '2026-10-05', counterpartyId: t.customer.id, storeId: t.s2.id, baseId: saleA.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '1' }] });
    expect(await costOf(rA.id)).toEqual(['C7010:100.00', 'D1330:100.00']);
    // Склад не указан — склад реализации.
    const noStore = await s.trade.create(ctx, { docType: 'SALES_RETURN', date: '2026-10-05', counterpartyId: t.customer.id, baseId: saleB.id, lines: [{ productId: t.goods.id, qty: '1' }] });
    expect(noStore.storeId).toBe(t.s1.id);
    await s.trade.cancel(ctx, noStore.id);
    const rB = await s.trade.fromBase(ctx, saleB.id, 'SALES_RETURN', '2026-10-05');
    expect(rB.storeId).toBe(t.s1.id); // по умолчанию — склад реализации
    await s.trade.post(ctx, rB.id);
    expect(await costOf(rB.id)).toEqual(['C7010:200.00', 'D1330:200.00']);
    expect(String((await prisma.stock.findFirst({ where: { productId: t.goods.id, storeId: t.s2.id, binId: null } }))?.qty)).toBe('1');
  });

  it('партионный товар возвращается той партией, что отгружали: одна — подставляется, несколько — строками по партиям', async () => {
    const { ctx, t } = await world();
    await prisma.product.update({ where: { id: t.goods.id }, data: { lotTracking: true } });
    await s.trade.create(ctx, { docType: 'SUPPLY', date: '2026-10-01', counterpartyId: t.supplier.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '2', price: '100', lotNumber: 'A' }, { productId: t.goods.id, qty: '5', price: '100', lotNumber: 'B' }] });
    const sale = await s.trade.create(ctx, { docType: 'DEMAND', date: '2026-10-03', counterpartyId: t.customer.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '3', price: '250' }] });
    const r = await s.trade.fromBase(ctx, sale.id, 'SALES_RETURN', '2026-10-04');
    expect(r.lines.map((l: any) => [l.lotNumber, l.qty.toString()])).toEqual([['A', '2'], ['B', '1']]);
    expect(await code(s.trade.create(ctx, { docType: 'SALES_RETURN', date: '2026-10-04', counterpartyId: t.customer.id, storeId: t.s1.id, baseId: sale.id, lines: [{ productId: t.goods.id, qty: '1' }] }))).toBe('LOT_REQUIRED');
    expect(await code(s.trade.create(ctx, { docType: 'SALES_RETURN', date: '2026-10-04', counterpartyId: t.customer.id, storeId: t.s1.id, baseId: sale.id, lines: [{ productId: t.goods.id, qty: '1', lotNumber: 'Z' }] }))).toBe('RETURN_LOT_NOT_SHIPPED');
    await s.trade.post(ctx, r.id);
    expect((await prisma.stockMovement.findMany({ where: { sourceId: r.id }, orderBy: { lotNumber: 'asc' } })).map((m) => `${m.lotNumber}:${m.qty}`)).toEqual(['A:2', 'B:1']);
    // Одна партия — подставляется сама.
    const sale2 = await s.trade.create(ctx, { docType: 'DEMAND', date: '2026-10-05', counterpartyId: t.customer.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '1', price: '250', lotNumber: 'B' }] });
    const r2 = await s.trade.create(ctx, { docType: 'SALES_RETURN', date: '2026-10-06', counterpartyId: t.customer.id, storeId: t.s1.id, baseId: sale2.id, lines: [{ productId: t.goods.id, qty: '1' }] });
    expect(r2.lines[0].lotNumber).toBe('B');
  });

  it('розничный возврат — по чеку, по его цене', async () => {
    const { ctx, t, sup } = await world();
    await sup('3');
    const chk = await s.trade.create(ctx, { docType: 'RETAIL_DEMAND', date: '2026-10-03', storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '2', price: '150' }] });
    const back = await s.trade.fromBase(ctx, chk.id, 'RETAIL_RETURN', '2026-10-04');
    expect([back.docType, back.lines[0].qty.toString(), back.lines[0].price!.toString()]).toEqual(['RETAIL_RETURN', '2', '150']);
    expect(await code(s.trade.create(ctx, { docType: 'RETAIL_RETURN', date: '2026-10-04', storeId: t.s1.id, lines: [{ productId: t.goods.id, qty: '1', price: '150' }] }))).toBe('RETURN_BASIS_REQUIRED');
  });
});
