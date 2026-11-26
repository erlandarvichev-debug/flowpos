import { PrismaService } from '../src/prisma/prisma.service';
import { profitability } from '../src/modules/accounting/reports/profitability';
import { makeServices, makeOrg, makeTrade } from './accounting-helpers';

const prisma = new PrismaService();
const s = makeServices(prisma);

describe('Прибыльность', () => {
  afterAll(() => prisma.$disconnect());

  it('выручка, возврат, себестоимость, прибыль и маржа по товарам и покупателям; сравнение с прошлым периодом', async () => {
    const ctx = await makeOrg(prisma);
    const t = await makeTrade(prisma, ctx, { vatPayer: false });
    await s.trade.create(ctx, { docType: 'SUPPLY', date: '2026-09-01', counterpartyId: t.supplier.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '20', price: '100' }, { productId: t.goods2.id, qty: '10', price: '50' }] });
    await s.trade.create(ctx, { docType: 'DEMAND', date: '2026-09-15', counterpartyId: t.customer.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '1', price: '150' }] });
    const sale = await s.trade.create(ctx, { docType: 'DEMAND', date: '2026-10-05', counterpartyId: t.customer.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '5', price: '200' }, { productId: t.goods2.id, qty: '2', price: '40' }] });
    await s.trade.create(ctx, { docType: 'SALES_RETURN', date: '2026-10-06', counterpartyId: t.customer.id, storeId: t.s1.id, baseId: sale.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '1' }] });

    const r = await profitability(prisma, ctx, { from: '2026-10-01', to: '2026-10-31', groupBy: 'product', compare: '1' });
    const g1 = r.lines.find((l: any) => l.key === t.goods.id)!;
    expect(g1).toMatchObject({ revenue: '1000.00', returns: '200.00', netRevenue: '800.00', cost: '400.00', profit: '400.00', margin: 50, markup: 100, qty: '5', returnsQty: '1' });
    const g2 = r.lines.find((l: any) => l.key === t.goods2.id)!;
    expect(g2).toMatchObject({ revenue: '80.00', cost: '100.00', profit: '-20.00', lossMaking: true, abc: 'C' });
    expect(r.totals).toMatchObject({ netRevenue: '880.00', cost: '500.00', profit: '380.00' });
    expect(r.previous).toMatchObject({ from: '2026-09-01', to: '2026-09-30', profit: '50.00' });
    expect(g1.prevProfit).toBe('50.00');

    const byCp = await profitability(prisma, ctx, { from: '2026-10-01', to: '2026-10-31', groupBy: 'counterparty' });
    expect(byCp.lines).toHaveLength(1);
    expect(byCp.lines[0]).toMatchObject({ key: t.customer.id, name: 'ТОО Покупатель', profit: '380.00', documents: 2 });
    const byDoc = await profitability(prisma, ctx, { from: '2026-10-01', to: '2026-10-31', groupBy: 'document' });
    expect(byDoc.lines.map((l: any) => l.key).sort()).toHaveLength(2);
    await expect(profitability(prisma, ctx, { from: '01.10.2026', to: '2026-10-31' })).rejects.toMatchObject({ response: expect.objectContaining({ code: 'BAD_DATE' }) });
  });
});
