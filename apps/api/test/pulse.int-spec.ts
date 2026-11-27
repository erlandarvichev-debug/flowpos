import { PrismaService } from '../src/prisma/prisma.service';
import { pulse } from '../src/modules/accounting/reports/pulse';
import { makeServices, makeOrg, makeTrade } from './accounting-helpers';

const prisma = new PrismaService();
const s = makeServices(prisma);

describe('Пульс бизнеса', () => {
  afterAll(() => prisma.$disconnect());
  it('деньги по дням, выручка и прибыль со сравнением, запасы, расходы', async () => {
    const ctx = await makeOrg(prisma);
    const t = await makeTrade(prisma, ctx, { vatPayer: false });
    await s.trade.create(ctx, { docType: 'SUPPLY', date: '2026-09-10', counterpartyId: t.supplier.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '20', price: '100' }] });
    await s.trade.create(ctx, { docType: 'DEMAND', date: '2026-09-20', counterpartyId: t.customer.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '2', price: '200' }] });
    await s.trade.create(ctx, { docType: 'DEMAND', date: '2026-10-05', counterpartyId: t.customer.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '5', price: '300' }] });
    const pay = async (docType: string, date: string, body: any) => { const d = await s.docs.create(ctx, { docType, date, body }); await s.docs.post(ctx, d.id); };
    await pay('BANK_IN', '2026-09-25', { bankAccountId: t.bank.id, operation: 'CUSTOMER', counterpartyId: t.customer.id, amount: '400' });
    await pay('BANK_IN', '2026-10-06', { bankAccountId: t.bank.id, operation: 'CUSTOMER', counterpartyId: t.customer.id, amount: '1000' });
    await pay('BANK_OUT', '2026-10-07', { bankAccountId: t.bank.id, operation: 'SUPPLIER', counterpartyId: t.supplier.id, amount: '700' });

    const r = await pulse(prisma, ctx, { from: '2026-10-01', to: '2026-10-31' });
    expect(r.period).toMatchObject({ prevFrom: '2026-08-31', prevTo: '2026-09-30', days: 31 });
    expect(r.money).toMatchObject({ start: '400.00', inflow: '1000.00', outflow: '700.00', end: '700.00', prevInflow: '400.00' });
    expect(r.series).toHaveLength(31);
    expect(r.series.find((x) => x.date === '2026-10-06')).toMatchObject({ money: '1400.00' });
    expect(r.series.find((x) => x.date === '2026-10-05')).toMatchObject({ revenue: '1500.00' });
    expect(r.revenue).toMatchObject({ value: '1500.00', prev: '400.00', delta: 275 });
    expect(r.grossProfit).toMatchObject({ value: '1000.00', prev: '200.00' });
    expect(r.stock).toMatchObject({ start: '1800.00', value: '1300.00' });
    expect(r.expenses.value).toBe('0.00');
    expect(r.netProfit.value).toBe('1000.00');
  });
});
