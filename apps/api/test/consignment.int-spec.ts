import { PrismaService } from '../src/prisma/prisma.service';
import { ConsignmentService } from '../src/modules/accounting/consignment/consignment.service';
import { makeServices, makeOrg, makeTrade } from './accounting-helpers';

const prisma = new PrismaService();
const s = makeServices(prisma);
const cons = new ConsignmentService(prisma, s.trade, s.docs, (s.trade as any).autopilot);

describe('Товары на реализации', () => {
  afterAll(() => prisma.$disconnect());
  it('передача комиссионеру → отчёт о продажах (реализация + вознаграждение в счёт долга) → остаток у него', async () => {
    const ctx = await makeOrg(prisma);
    const t = await makeTrade(prisma, ctx, { vatPayer: false });
    await s.trade.create(ctx, { docType: 'SUPPLY', date: '2026-10-01', counterpartyId: t.supplier.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '20', price: '100' }] });
    const c = await cons.addConsignee(ctx, { counterpartyId: t.customer.id });
    expect(c.storeName).toContain('ТОО Покупатель');
    await s.trade.create(ctx, { docType: 'MOVE', date: '2026-10-02', storeId: t.s1.id, storeToId: c.storeId, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '10' }] });

    const st = await cons.stock(ctx, c.storeId);
    expect(st.lines).toEqual([expect.objectContaining({ productId: t.goods.id, qty: '10', cost: '1000.00' })]);
    await expect(cons.report(ctx, { storeId: c.storeId, lines: [{ productId: t.goods.id, qty: '4', price: '' }] })).rejects.toMatchObject({ response: expect.objectContaining({ code: 'PRICE_REQUIRED' }) });

    const r = await cons.report(ctx, { storeId: c.storeId, date: '2026-10-10', feePercent: '10', lines: [{ productId: t.goods.id, qty: '4', price: '250' }] });
    expect(r.fee).toBeTruthy();
    const sale = await s.trade.get(ctx, r.demand.id) as any;
    // долг комиссионера = 1000 − 10% вознаграждения
    expect(sale.payment).toMatchObject({ debt: '900.00', paid: '100.00' });
    const list = await cons.list(ctx);
    expect(list[0]).toMatchObject({ qty: '6', cost: '600.00', sold30: expect.any(String) });
  });
});
