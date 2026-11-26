import { PrismaService } from '../src/prisma/prisma.service';
import { moneyFlow, stockTurnover } from '../src/modules/accounting/reports/flows';
import { makeServices, makeOrg, makeTrade } from './accounting-helpers';

const prisma = new PrismaService();
const s = makeServices(prisma);

describe('Обороты товаров и движение денег', () => {
  afterAll(() => prisma.$disconnect());
  it('на начало / приход / расход / на конец; ДДС без переводов между своими счетами', async () => {
    const ctx = await makeOrg(prisma);
    const t = await makeTrade(prisma, ctx, { vatPayer: false });
    await s.trade.create(ctx, { docType: 'SUPPLY', date: '2026-09-20', counterpartyId: t.supplier.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '10', price: '100' }] });
    await s.trade.create(ctx, { docType: 'SUPPLY', date: '2026-10-03', counterpartyId: t.supplier.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '5', price: '100' }] });
    await s.trade.create(ctx, { docType: 'DEMAND', date: '2026-10-05', counterpartyId: t.customer.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '4', price: '250' }] });

    const r = await stockTurnover(prisma, ctx, { from: '2026-10-01', to: '2026-10-31' });
    expect(r.lines.find((l) => l.productId === t.goods.id)).toMatchObject({ openQty: '10', openSum: '1000.00', inQty: '5', inSum: '500.00', outQty: '4', outSum: '400.00', closeQty: '11', closeSum: '1100.00' });

    const pay = async (docType: string, body: any) => { const d = await s.docs.create(ctx, { docType, date: '2026-10-06', body }); await s.docs.post(ctx, d.id); };
    await pay('BANK_IN', { bankAccountId: t.bank.id, operation: 'CUSTOMER', counterpartyId: t.customer.id, amount: '1000' });
    await pay('BANK_OUT', { bankAccountId: t.bank.id, operation: 'SUPPLIER', counterpartyId: t.supplier.id, amount: '600' });
    await pay('BANK_OUT', { bankAccountId: t.bank.id, operation: 'TRANSFER', toCashboxId: t.cash.id, amount: '100' });
    const m = await moneyFlow(prisma, ctx, { from: '2026-10-01', to: '2026-10-31', by: 'operation' });
    expect([m.opening, m.inflow, m.outflow, m.net, m.closing]).toEqual(['0.00', '1000.00', '600.00', '400.00', '400.00']);
    expect(m.lines.map((l) => [l.name, l.net])).toEqual([['Оплата от покупателей', '1000.00'], ['Оплата поставщикам', '-600.00']]);
    expect(m.months).toEqual(['2026-10']);
  });
});
