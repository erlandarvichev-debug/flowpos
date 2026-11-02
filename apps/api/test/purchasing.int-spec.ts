// FP-035: потребность по правилам пополнения (свободно = факт − резервы, плюс заказано и не принято), заказы поставщикам
// по потребности, бюджет закупок месяца (сверх — только после согласования), поступление по заказу, возврат поставщику по
// поступлению (причина, не больше принятого, цены и партии поступления) — на настоящей БД.
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { PurchasingService } from '../src/modules/accounting/purchasing/purchasing.service';
import { OrgContext } from '../src/modules/accounting/access/org-context';
import { makeServices, makeOrg, makeTrade, ctxFor } from './accounting-helpers';

const prisma = new PrismaService();
const s = makeServices(prisma);
const purchasing = new PurchasingService(prisma, s.trade);
const D = Prisma.Decimal;

async function code(p: Promise<unknown>) {
  try { await p; return 'OK'; } catch (e: any) { return e?.response?.code ?? e?.code ?? e?.message; }
}
async function colleague(ctx: OrgContext) {
  const user = await prisma.user.create({ data: { organizationId: ctx.organizationId, email: `pur-${randomUUID()}@test.local`, passwordHash: 'x', firstName: 'Второй', lastName: 'Сотрудник' } });
  await prisma.orgMembership.create({ data: { userId: user.id, organizationId: ctx.organizationId, role: 'chief_accountant' } });
  return ctxFor(ctx.organizationId, user.id, 'chief_accountant');
}

beforeAll(async () => {
  await prisma.$connect();
  await s.chart.bootstrap();
});
afterAll(() => prisma.$disconnect());

async function world() {
  const ctx = await makeOrg(prisma, 'accountant');
  const t = await makeTrade(prisma, ctx, { vatPayer: false });
  const sup = (qty: string, price = '100', extra: any = {}) => s.trade.create(ctx, { docType: 'SUPPLY', date: '2026-10-01', counterpartyId: t.supplier.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty, price, ...(extra.line ?? {}) }], ...(extra.doc ?? {}) });
  return { ctx, t, sup };
}

describe('FP-035: потребность и заказы поставщикам', () => {
  it('потребность = уровень − (свободно + в заказах), когда ниже точки заказа; заказы по потребности — по поставщикам и последним ценам', async () => {
    const { ctx, t, sup } = await world();
    await sup('3', '100');
    expect(await code(purchasing.setRule(ctx, { storeId: t.s1.id, productId: t.goods.id, minQty: '10', maxQty: '5' }))).toBe('RULE_RANGE');
    expect(await code(purchasing.setRule(ctx, { storeId: t.s1.id, productId: t.service.id, minQty: '1', maxQty: '5' }))).toBe('REF_FOREIGN');
    // Позже товар брали у другого поставщика дороже — цена в потребности всё равно от поставщика из правила.
    const other = await prisma.counterparty.create({ data: { name: 'ТОО Другой поставщик', type: 'SUPPLIER', organizationId: ctx.organizationId } });
    await s.trade.create(ctx, { docType: 'SUPPLY', date: '2026-10-01', counterpartyId: other.id, storeId: t.s2.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '1', price: '120' }] });
    await purchasing.setRule(ctx, { storeId: t.s1.id, productId: t.goods.id, minQty: '5', maxQty: '20', supplierId: t.supplier.id });
    expect((await purchasing.needs(ctx, { storeId: t.s1.id })).items.map((i: any) => [i.free, i.onOrder, i.need, i.price])).toEqual([['3', '0', '17', '100.00']]);
    // Резерв под заказ покупателя уменьшает свободное — потребность растёт.
    const co = await s.trade.create(ctx, { docType: 'CUSTOMER_ORDER', date: '2026-10-02', counterpartyId: t.customer.id, storeId: t.s1.id, lines: [{ productId: t.goods.id, qty: '2', price: '300' }] });
    await s.trade.reserve(ctx, co.id);
    expect((await purchasing.needs(ctx, { storeId: t.s1.id })).items[0]).toMatchObject({ free: '1', need: '19' });

    expect(await code(purchasing.createOrders(ctx, { storeId: t.s1.id, lines: [{ productId: t.goods2.id, qty: '1' }] }))).toBe('SUPPLIER_REQUIRED');
    const [po] = await purchasing.createOrders(ctx, { storeId: t.s1.id, date: '2026-10-03', lines: [{ productId: t.goods.id, qty: '19' }] });
    const order = await s.trade.get(ctx, po.id);
    expect([order.docType, order.counterpartyId, order.lines[0].qty.toString(), order.lines[0].price!.toString()]).toEqual(['PURCHASE_ORDER', t.supplier.id, '19', '100']);
    await s.trade.post(ctx, po.id);
    // Заказано и не принято — учитывается: потребности больше нет.
    expect((await purchasing.needs(ctx, { storeId: t.s1.id })).items).toEqual([]);
    expect((await purchasing.needs(ctx, { storeId: t.s1.id, all: '1' })).items[0]).toMatchObject({ onOrder: '19', need: '0' });
    // Частичное поступление: принятое уходит из «в заказах» в остаток.
    const rcv = await s.trade.fromBase(ctx, po.id, 'SUPPLY', '2026-10-04');
    await s.trade.update(ctx, rcv.id, { expectedVersion: rcv.version, lines: [{ productId: t.goods.id, qty: '10', price: '100', expectedQty: '19', discrepancyReason: 'SHORTAGE' }] });
    await s.trade.post(ctx, rcv.id);
    expect((await purchasing.needs(ctx, { storeId: t.s1.id, all: '1' })).items[0]).toMatchObject({ free: '11', onOrder: '9', need: '0' });
    // Закрытый заказ больше не ждём: «в заказах» — 0; свободно 11 ≥ точки заказа 5 — потребности нет, пока не продадут.
    await s.trade.closeOrder(ctx, po.id, { reason: 'Поставщик не довезёт остаток' });
    expect((await purchasing.needs(ctx, { storeId: t.s1.id, all: '1' })).items[0]).toMatchObject({ onOrder: '0', need: '0' });
    await s.trade.create(ctx, { docType: 'DEMAND', date: '2026-10-05', counterpartyId: t.customer.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '7', price: '300' }] });
    expect((await purchasing.needs(ctx, { storeId: t.s1.id })).items[0]).toMatchObject({ free: '4', onOrder: '0', need: '16' });
  });
});

describe('FP-035: бюджет закупок', () => {
  it('заказы месяца сверх бюджета — только после согласования другим сотрудником; другой месяц — без бюджета', async () => {
    const { ctx, t } = await world();
    const boss = await colleague(ctx);
    expect(await code(purchasing.setBudget(ctx, { period: '2026-13', amount: '1' }))).toBe('BAD_PERIOD');
    await purchasing.setBudget(ctx, { period: '2026-10', amount: '1000' });
    const po = (qty: string, date = '2026-10-05') => s.trade.create(ctx, { docType: 'PURCHASE_ORDER', date, counterpartyId: t.supplier.id, storeId: t.s1.id, lines: [{ productId: t.goods.id, qty, price: '100' }] });
    const free = await s.trade.create(ctx, { docType: 'PURCHASE_ORDER', date: '2026-10-05', counterpartyId: t.supplier.id, storeId: t.s1.id, lines: [{ productId: t.goods.id, qty: '1' }] });
    expect(await code(s.trade.post(ctx, free.id))).toBe('PRICE_REQUIRED');
    // Не считаются: черновик этого месяца и проведённый заказ другого месяца.
    await po('5');
    expect((await s.trade.post(ctx, (await po('3', '2026-09-20')).id)).status).toBe('POSTED');
    const a = await po('8');
    expect((await s.trade.post(ctx, a.id)).status).toBe('POSTED');
    const b = await po('3');
    expect(await purchasing.budgetFor(ctx, b.id)).toMatchObject({ period: '2026-10', budget: '1000.00', committed: '800.00', amount: '300.00', overBudget: true });
    expect(await code(s.trade.post(ctx, b.id))).toBe('APPROVAL_REQUIRED');
    const ap = await s.approvals.request(ctx, { docKind: 'TRADE', docId: b.id, expectedVersion: b.version });
    expect(await code(s.approvals.decide(ctx, ap.id, { decision: 'APPROVE' }))).toBe('FOUR_EYES');
    await s.approvals.decide(boss, ap.id, { decision: 'APPROVE' });
    expect((await s.trade.post(ctx, b.id)).status).toBe('POSTED');
    // В пределах остатка — без согласования (бюджет поднят), в месяце без бюджета — тоже.
    await purchasing.setBudget(ctx, { period: '2026-10', amount: '5000' });
    expect((await s.trade.post(ctx, (await po('2')).id)).status).toBe('POSTED');
    expect((await s.trade.post(ctx, (await po('50', '2026-11-02')).id)).status).toBe('POSTED');
    expect((await purchasing.budgets(ctx)).map((x) => [x.period, x.amount.toString()])).toEqual([['2026-10', '5000']]);
  });
});

describe('FP-035: поступление по заказу и возврат поставщику', () => {
  it('поступление — поставщик и товары заказа, цена по накладной; возврат — по поступлению, с причиной, не больше принятого, по его цене и партии', async () => {
    const { ctx, t, sup } = await world();
    await prisma.product.update({ where: { id: t.goods.id }, data: { lotTracking: true } });
    const po = await s.trade.create(ctx, { docType: 'PURCHASE_ORDER', date: '2026-10-01', counterpartyId: t.supplier.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '10', price: '100' }] });
    const rcv = (extra: any) => s.trade.create(ctx, { docType: 'SUPPLY', date: '2026-10-02', counterpartyId: t.supplier.id, storeId: t.s1.id, baseId: po.id, lines: [{ productId: t.goods.id, qty: '5', price: '105', lotNumber: 'P1' }], ...extra });
    expect(await code(rcv({ counterpartyId: t.customer.id }))).toBe('BASIS_COUNTERPARTY');
    expect(await code(rcv({ lines: [{ productId: t.goods2.id, qty: '1', price: '1' }] }))).toBe('BASIS_PRODUCT');
    const r = await rcv({ status: 'POSTED' });
    expect(r.lines[0].price!.toString()).toBe('105'); // цена накладной, не заказа
    await sup('3', '100', { line: { lotNumber: 'P2' } });

    const back = (extra: any) => s.trade.create(ctx, { docType: 'PURCHASE_RETURN', date: '2026-10-05', counterpartyId: t.supplier.id, storeId: t.s1.id, baseId: r.id, lines: [{ productId: t.goods.id, qty: '2', price: '1' }], ...extra });
    expect(await code(back({ status: 'POSTED' }))).toBe('RETURN_REASON_REQUIRED');
    expect(await code(back({ returnReason: 'брак', status: 'POSTED' }))).toBe('RETURN_REASON_REQUIRED');
    expect(await code(back({ returnReason: 'брак упаковки', baseId: undefined }))).toBe('RETURN_BASIS_REQUIRED');
    expect(await code(back({ returnReason: 'брак упаковки', status: 'POSTED', lines: [{ productId: t.goods.id, qty: '6' }] }))).toBe('RETURN_EXCEEDS_SHIPPED');
    expect(await code(back({ returnReason: 'брак упаковки', lines: [{ productId: t.goods.id, qty: '1', lotNumber: 'P2' }] }))).toBe('RETURN_LOT_NOT_SHIPPED');
    const ret = await back({ returnReason: 'брак упаковки', status: 'POSTED' });
    expect([ret.lines[0].price!.toString(), ret.lines[0].lotNumber, (ret.attributes as any).returnReason]).toEqual(['105', 'P1', 'брак упаковки']);
    expect((await prisma.stockMovement.findMany({ where: { sourceId: ret.id } })).map((m) => `${m.kind}:${m.lotNumber}:${m.qty}`)).toEqual(['PURCHASE_RETURN:P1:-2']);
    expect(ret.entry!.postings.filter((p: any) => p.account.code === '3310').map((p: any) => `${p.side}:${new D(p.amount).toFixed(2)}`)).toEqual(['D:210.00']);
    // «Создать на основании» — черновик остатка (3 из 5) без причины; провести — только с причиной.
    const left = await s.trade.fromBase(ctx, r.id, 'PURCHASE_RETURN', '2026-10-06');
    expect([left.status, left.lines[0].qty.toString(), left.lines[0].lotNumber]).toEqual(['DRAFT', '3', 'P1']);
    expect(await code(s.trade.post(ctx, left.id))).toBe('RETURN_REASON_REQUIRED');
    const fixed = await s.trade.update(ctx, left.id, { expectedVersion: left.version, returnReason: 'пересорт по поставке' } as any);
    expect((await s.trade.post(ctx, left.id, undefined, fixed.version)).status).toBe('POSTED');
    // Поступление двумя партиями — «создать на основании» возврата раскладывает по партиям поступления.
    const two = await s.trade.create(ctx, { docType: 'SUPPLY', date: '2026-10-07', counterpartyId: t.supplier.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '2', price: '100', lotNumber: 'Q1' }, { productId: t.goods.id, qty: '1', price: '100', lotNumber: 'Q2' }] });
    const split = await s.trade.fromBase(ctx, two.id, 'PURCHASE_RETURN', '2026-10-08');
    expect(split.lines.map((l: any) => [l.lotNumber, l.qty.toString()])).toEqual([['Q1', '2'], ['Q2', '1']]);
  });
});
