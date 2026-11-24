import { PrismaService } from '../src/prisma/prisma.service';
import { D } from '../src/modules/accounting/common/money';
import { makeServices, makeOrg, makeTrade } from './accounting-helpers';

const prisma = new PrismaService();
const s = makeServices(prisma);

/** Итог документа = сумма к оплате, как в проводках расчётов (1210 — покупатель, 3310 — поставщик). */
describe('итог торгового документа и НДС «сверху»', () => {
  afterAll(() => prisma.$disconnect());

  const total = async (id: string) => new D((await prisma.document.findUniqueOrThrow({ where: { id } })).total as any).toFixed(2);
  const settled = async (ctx: any, id: string, account: string) => {
    const doc = await s.trade.get(ctx, id);
    return doc.entry!.postings.filter((p: any) => p.account.code === account).reduce((a: any, p: any) => a.plus(p.amount), new D(0)).toFixed(2);
  };

  it('цены без НДС: итог включает НДС и совпадает с долгом покупателя; с НДС — сумма строк', async () => {
    const ctx = await makeOrg(prisma);
    const t = await makeTrade(prisma, ctx, { vatPayer: true });
    await s.trade.create(ctx, { docType: 'SUPPLY', date: '2026-10-01', counterpartyId: t.supplier.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '10', price: '500' }] });

    const net = await s.trade.create(ctx, { docType: 'DEMAND', date: '2026-10-02', counterpartyId: t.customer.id, storeId: t.s1.id, vatIncluded: false, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '2', price: '1000' }] });
    expect(new D(await total(net.id)).gt(2000)).toBe(true);
    expect(await total(net.id)).toBe(await settled(ctx, net.id, '1210'));

    const gross = await s.trade.create(ctx, { docType: 'DEMAND', date: '2026-10-02', counterpartyId: t.customer.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '2', price: '1000' }] });
    expect(await total(gross.id)).toBe('2000.00');
    expect(await total(gross.id)).toBe(await settled(ctx, gross.id, '1210'));

    // изменение проведённого документа пересчитывает итог тем же правилом
    const cur = await prisma.document.findUniqueOrThrow({ where: { id: net.id } });
    await s.trade.update(ctx, net.id, { expectedVersion: cur.version, reason: 'Проверка', lines: [{ productId: t.goods.id, qty: '3', price: '1000' }] });
    expect(new D(await total(net.id)).gt(3000)).toBe(true);
    expect(await total(net.id)).toBe(await settled(ctx, net.id, '1210'));
  });

  it('реализация без основания и без цены — не молча 0, а цена из прайс-листов (нет в прайсе — понятная ошибка)', async () => {
    const ctx = await makeOrg(prisma);
    const t = await makeTrade(prisma, ctx, { vatPayer: true });
    await expect(s.trade.create(ctx, { docType: 'DEMAND', date: '2026-10-02', counterpartyId: t.customer.id, storeId: t.s1.id, lines: [{ productId: t.goods.id, qty: '1' }] }))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: 'PRICE_MISSING' }) });
  });

  it('на основании: две строки одного товара 5 + 3, отгружено 6 → остаток 2', async () => {
    const ctx = await makeOrg(prisma);
    const t = await makeTrade(prisma, ctx, { vatPayer: true });
    await s.trade.create(ctx, { docType: 'SUPPLY', date: '2026-10-01', counterpartyId: t.supplier.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '20', price: '500' }] });
    const order = await s.trade.create(ctx, { docType: 'CUSTOMER_ORDER', date: '2026-10-02', counterpartyId: t.customer.id, storeId: t.s1.id, lines: [{ productId: t.goods.id, qty: '5', price: '1000' }, { productId: t.goods.id, qty: '3', price: '1000' }] });
    await s.trade.create(ctx, { docType: 'DEMAND', date: '2026-10-03', counterpartyId: t.customer.id, storeId: t.s1.id, baseId: order.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '6' }] });
    const next = await s.trade.fromBase(ctx, order.id, 'DEMAND', '2026-10-04');
    const left = (await prisma.documentLine.findMany({ where: { documentId: next.id } })).reduce((a, l) => a.plus(l.qty as any), new D(0));
    expect(left.toFixed(3)).toBe('2.000');
  });

  it('не плательщик НДС: «без НДС» ничего не добавляет', async () => {
    const ctx = await makeOrg(prisma);
    const t = await makeTrade(prisma, ctx, { vatPayer: false });
    const sup = await s.trade.create(ctx, { docType: 'SUPPLY', date: '2026-10-01', counterpartyId: t.supplier.id, storeId: t.s1.id, vatIncluded: false, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '4', price: '250' }] });
    expect(await total(sup.id)).toBe('1000.00');
    expect(await total(sup.id)).toBe(await settled(ctx, sup.id, '3310'));
  });
});

describe('Оплата реализаций в журнале и карточке', () => {
  afterAll(() => prisma.$disconnect());
  it('не оплачена → частично → оплачена; остаток долга считается по документу', async () => {
    const ctx = await makeOrg(prisma);
    const t = await makeTrade(prisma, ctx, { vatPayer: false });
    await s.trade.create(ctx, { docType: 'SUPPLY', date: '2026-10-01', counterpartyId: t.supplier.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '10', price: '100' }] });
    const sale = await s.trade.create(ctx, { docType: 'DEMAND', date: '2026-10-02', counterpartyId: t.customer.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '4', price: '250' }] });
    const state = async () => (await s.trade.list(ctx, { docType: 'DEMAND' })).items.find((i: any) => i.id === sale.id)!.payment;
    expect(await state()).toEqual({ status: 'UNPAID', paid: '0.00', debt: '1000.00' });
    const pay = (amount: string) => s.trade.create(ctx, { docType: 'PAYMENT_IN', date: '2026-10-03', counterpartyId: t.customer.id, bankAccountId: t.bank.id, amount, status: 'POSTED' } as any);
    await pay('400');
    expect(await state()).toEqual({ status: 'PARTIAL', paid: '400.00', debt: '600.00' });
    await pay('600');
    expect((await s.trade.get(ctx, sale.id) as any).payment).toEqual({ status: 'PAID', paid: '1000.00', debt: '0.00' });
    // фильтр журнала по периоду (даты Казахстана) и сумма по выборке
    const l = await s.trade.list(ctx, { docType: 'DEMAND', from: '2026-10-02', to: '2026-10-02' });
    expect([l.total, l.sum]).toEqual([1, '1000.00']);
    expect((await s.trade.list(ctx, { docType: 'DEMAND', from: '2026-10-03', to: '2026-10-05' })).total).toBe(0);
  });
});
