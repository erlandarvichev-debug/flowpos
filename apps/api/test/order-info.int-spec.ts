import { PrismaService } from '../src/prisma/prisma.service';
import { makeServices, makeOrg, makeTrade } from './accounting-helpers';

const prisma = new PrismaService();
const s = makeServices(prisma);

/** Этап заказа, дата отгрузки, ответственный; статус «отгружен частично / отгружен» — по реализациям на основании. */
describe('Статусы заказов', () => {
  afterAll(() => prisma.$disconnect());

  it('этапы, дата отгрузки, ответственный; частично → отгружен; закрытый не меняется', async () => {
    const ctx = await makeOrg(prisma);
    const t = await makeTrade(prisma, ctx, { vatPayer: false });
    await s.trade.create(ctx, { docType: 'SUPPLY', date: '2026-10-01', counterpartyId: t.supplier.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '20', price: '100' }] });
    const order = await s.trade.create(ctx, { docType: 'CUSTOMER_ORDER', date: '2026-10-02', counterpartyId: t.customer.id, storeId: t.s1.id, shipDate: '2026-10-05', lines: [{ productId: t.goods.id, qty: '5', price: '200' }] } as any);
    const row = async () => (await s.trade.list(ctx, { docType: 'CUSTOMER_ORDER' })).items.find((i: any) => i.id === order.id) as any;

    // по умолчанию: «Новый», ответственный — кто создал
    let v = await s.trade.get(ctx, order.id) as any;
    expect(v.orderStatus).toBe('NEW');
    expect(v.attributes).toMatchObject({ shipDate: '2026-10-05', responsibleId: ctx.userId });
    expect(v.responsible?.id).toBe(ctx.userId);
    expect((await row()).orderStatus).toBe('NEW');

    v = await s.trade.setOrderInfo(ctx, order.id, { stage: 'ASSEMBLED' });
    expect(v.orderStatus).toBe('ASSEMBLED');
    expect((await s.trade.list(ctx, { docType: 'CUSTOMER_ORDER', responsibleId: 'me' } as any)).total).toBe(1);

    await expect(s.trade.setOrderInfo(ctx, order.id, { stage: 'SHIPPED' })).rejects.toMatchObject({ response: expect.objectContaining({ code: 'BAD_STAGE' }) });
    await expect(s.trade.setOrderInfo(ctx, order.id, { shipDate: '05.10.2026' })).rejects.toMatchObject({ response: expect.objectContaining({ code: 'BAD_DATE' }) });
    const stranger = await makeOrg(prisma);
    await expect(s.trade.setOrderInfo(ctx, order.id, { responsibleId: stranger.userId })).rejects.toMatchObject({ response: expect.objectContaining({ code: 'BAD_RESPONSIBLE' }) });

    // реализация на основании: 3 из 5 → частично, ещё 2 → отгружен (этап руками больше не виден)
    await s.trade.create(ctx, { docType: 'DEMAND', date: '2026-10-05', counterpartyId: t.customer.id, storeId: t.s1.id, baseId: order.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '3' }] });
    expect((await row()).orderStatus).toBe('PARTLY_SHIPPED');
    await s.trade.create(ctx, { docType: 'DEMAND', date: '2026-10-06', counterpartyId: t.customer.id, storeId: t.s1.id, baseId: order.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '2' }] });
    expect((await row()).orderStatus).toBe('SHIPPED');
    expect(((await s.trade.get(ctx, order.id)) as any).orderStatus).toBe('SHIPPED');

    // заказ поставщику: свои этапы; закрытый — не меняется
    const po = await s.trade.create(ctx, { docType: 'PURCHASE_ORDER', date: '2026-10-02', counterpartyId: t.supplier.id, storeId: t.s1.id, lines: [{ productId: t.goods.id, qty: '5', price: '100' }] });
    expect((await s.trade.setOrderInfo(ctx, po.id, { stage: 'SENT' }) as any).orderStatus).toBe('SENT');
    await expect(s.trade.setOrderInfo(ctx, po.id, { stage: 'ASSEMBLED' })).rejects.toMatchObject({ response: expect.objectContaining({ code: 'BAD_STAGE' }) });
    await s.trade.closeOrder(ctx, po.id, { reason: 'Поставщик не довезёт' });
    expect(((await s.trade.get(ctx, po.id)) as any).orderStatus).toBe('CLOSED');
    await expect(s.trade.setOrderInfo(ctx, po.id, { stage: 'CONFIRMED' })).rejects.toMatchObject({ response: expect.objectContaining({ code: 'ORDER_CLOSED' }) });

    // у реализации этих полей нет
    const sale = await s.trade.create(ctx, { docType: 'DEMAND', date: '2026-10-06', counterpartyId: t.customer.id, storeId: t.s1.id, lines: [{ productId: t.goods.id, qty: '1', price: '200' }] });
    await expect(s.trade.setOrderInfo(ctx, sale.id, { stage: 'NEW' })).rejects.toMatchObject({ response: expect.objectContaining({ code: 'NOT_ORDER' }) });
    expect((await s.trade.assignees(ctx)).some((u: any) => u.id === ctx.userId)).toBe(true);
  });
});
