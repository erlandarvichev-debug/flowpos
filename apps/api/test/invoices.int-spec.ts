import { PrismaService } from '../src/prisma/prisma.service';
import { makeServices, makeOrg, makeTrade } from './accounting-helpers';

const prisma = new PrismaService();
const s = makeServices(prisma);

/** Счёт покупателю: из заказа, оплата «по счёту», отгрузка по счёту засчитывается заказу; без проводок. */
describe('Счета покупателям и поставщиков', () => {
  afterAll(() => prisma.$disconnect());

  it('заказ → счёт → частичная оплата → отгрузка по счёту; статус заказа и резерв учитывают её', async () => {
    const ctx = await makeOrg(prisma);
    const t = await makeTrade(prisma, ctx, { vatPayer: false });
    await s.trade.create(ctx, { docType: 'SUPPLY', date: '2026-10-01', counterpartyId: t.supplier.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '20', price: '100' }] });
    const old = await s.trade.create(ctx, { docType: 'DEMAND', date: '2026-10-01', counterpartyId: t.customer.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '1', price: '500' }] });
    const order = await s.trade.create(ctx, { docType: 'CUSTOMER_ORDER', date: '2026-10-02', counterpartyId: t.customer.id, storeId: t.s1.id, lines: [{ productId: t.goods.id, qty: '4', price: '250' }] });
    await s.trade.reserve(ctx, order.id);

    // счёт из заказа: строки и цены заказа, номер «СЧ», без проводок
    const draft = await s.trade.fromBase(ctx, order.id, 'INVOICE_OUT', '2026-10-02');
    expect(draft.number).toMatch(/^СЧ/);
    const inv = await s.trade.post(ctx, draft.id) as any;
    expect(inv.entry ?? null).toBeNull();
    expect(inv.invoice).toMatchObject({ status: 'UNPAID', paid: '0.00', left: '1000.00', shipped: '0.00' });
    // второй счёт по тому же заказу — нечего выставлять
    await expect(s.trade.fromBase(ctx, order.id, 'INVOICE_OUT', '2026-10-02')).rejects.toMatchObject({ response: expect.objectContaining({ code: 'BASE_FULFILLED' }) });
    expect(((await s.trade.get(ctx, order.id)) as any).invoices.map((i: any) => i.id)).toEqual([inv.id]);

    // оплата по счёту (банк, body.invoiceId)
    const pay = await s.docs.create(ctx, { docType: 'BANK_IN', date: '2026-10-03', body: { bankAccountId: t.bank.id, operation: 'CUSTOMER', counterpartyId: t.customer.id, amount: '400', invoiceId: inv.id } });
    await s.docs.post(ctx, pay.id);
    expect(((await s.trade.get(ctx, inv.id)) as any).invoice).toMatchObject({ status: 'PARTIAL', paid: '400.00', left: '600.00' });
    const row = (await s.trade.list(ctx, { docType: 'INVOICE_OUT' })).items.find((i: any) => i.id === inv.id) as any;
    expect(row.invoice.status).toBe('PARTIAL');

    // отгрузка по счёту: цены счёта, заказ видит отгрузку, резерв снят
    const ship = await s.trade.fromBase(ctx, inv.id, 'DEMAND', '2026-10-04');
    expect((ship.attributes as any).orderId).toBe(order.id);
    await s.trade.post(ctx, ship.id);
    const o = await s.trade.get(ctx, order.id) as any;
    expect(o.orderStatus).toBe('SHIPPED');
    expect(((await s.trade.get(ctx, old.id)) as any).payment.debt).toBe('500.00');
    expect(o.reservations.filter((r: any) => !r.closedAt)).toHaveLength(0);
    expect(((await s.trade.get(ctx, inv.id)) as any).invoice.shipped).toBe('1000.00');
    // оплата по счёту (аванс 400) зачтена в отгрузку по этому счёту
    expect(((await s.trade.get(ctx, ship.id)) as any).payment).toMatchObject({ debt: '600.00', paid: '400.00' });

    // срок оплаты в счёте
    const due = await s.trade.setDueDate(ctx, inv.id, { dueDate: '2026-10-10' }) as any;
    expect(due.invoice.dueDate).toBe('2026-10-10');

    // счёт поставщика из заказа поставщику
    const po = await s.trade.create(ctx, { docType: 'PURCHASE_ORDER', date: '2026-10-02', counterpartyId: t.supplier.id, storeId: t.s1.id, lines: [{ productId: t.goods.id, qty: '5', price: '100' }] });
    const invIn = await s.trade.fromBase(ctx, po.id, 'INVOICE_IN', '2026-10-02');
    expect(invIn.number).toMatch(/^СЧП/);
    const sup = await s.trade.fromBase(ctx, invIn.id, 'SUPPLY', '2026-10-05');
    expect((sup.attributes as any).orderId).toBe(po.id);
  });

  it('счёт без заказа: цены из прайса нет — понятная ошибка; с ценой — сохраняется', async () => {
    const ctx = await makeOrg(prisma);
    const t = await makeTrade(prisma, ctx, { vatPayer: false });
    await expect(s.trade.create(ctx, { docType: 'INVOICE_OUT', date: '2026-10-02', counterpartyId: t.customer.id, lines: [{ productId: t.goods.id, qty: '1' }] }))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: 'PRICE_MISSING' }) });
    const inv = await s.trade.create(ctx, { docType: 'INVOICE_OUT', date: '2026-10-02', counterpartyId: t.customer.id, lines: [{ productId: t.goods.id, qty: '2', price: '300' }] });
    expect(((await s.trade.get(ctx, inv.id)) as any).invoice).toMatchObject({ left: '600.00', status: 'UNPAID' });
  });
});
