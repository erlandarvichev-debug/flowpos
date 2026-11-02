// Акт сверки: сальдо на начало, обороты по документам (реализация — дебет, оплата и возврат — кредит), сальдо на конец;
// чужой контрагент не попадает; проверки ввода. Суммы — вручную: 1000 до периода; в периоде +500 −600 −100 → 800.
import { PrismaService } from '../src/prisma/prisma.service';
import { makeOrg, makeServices, makeTrade } from './accounting-helpers';

const prisma = new PrismaService();
const s = makeServices(prisma);
afterAll(() => prisma.$disconnect());
async function code(p: Promise<unknown>) {
  try { await p; return 'OK'; } catch (e: any) { return e?.getResponse?.()?.code ?? e?.message; }
}

describe('Акт сверки', () => {
  it('сальдо, обороты по документам, конечное сальдо; другой покупатель не входит', async () => {
    const ctx = await makeOrg(prisma);
    const t = await makeTrade(prisma, ctx, { vatPayer: false });
    const other = await prisma.counterparty.create({ data: { name: 'ТОО Другой', type: 'CUSTOMER', organizationId: ctx.organizationId } });
    await s.trade.create(ctx, { docType: 'SUPPLY', date: '2026-09-01', counterpartyId: t.supplier.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '100', price: '10' }] });
    await s.trade.create(ctx, { docType: 'DEMAND', date: '2026-09-20', counterpartyId: t.customer.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '10', price: '100' }] });
    const pay = await s.docs.create(ctx, { docType: 'BANK_IN', date: '2026-10-03', body: { bankAccountId: t.bank.id, operation: 'CUSTOMER', counterpartyId: t.customer.id, amount: '600' } });
    await s.docs.post(ctx, pay.id);
    const sale = await s.trade.create(ctx, { docType: 'DEMAND', date: '2026-10-10', counterpartyId: t.customer.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '5', price: '100' }] });
    await s.trade.create(ctx, { docType: 'SALES_RETURN', date: '2026-10-15', counterpartyId: t.customer.id, storeId: t.s1.id, status: 'POSTED', baseId: sale.id, lines: [{ productId: t.goods.id, qty: '1', price: '100' }] });
    await s.trade.create(ctx, { docType: 'DEMAND', date: '2026-10-12', counterpartyId: other.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '1', price: '100' }] });
    await s.trade.create(ctx, { docType: 'DEMAND', date: '2026-11-01', counterpartyId: t.customer.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '1', price: '100' }] });

    const r = await s.reports.reconciliation(ctx, { counterpartyId: t.customer.id, from: '2026-10-01', to: '2026-10-31' });
    expect(r.opening).toBe('1000.00');
    expect(r.rows.map((x) => [x.date, x.document.split(' №')[0], x.debit, x.credit])).toEqual([
      ['2026-10-03', 'Поступление на счёт', '0.00', '600.00'],
      ['2026-10-10', 'Реализация', '500.00', '0.00'],
      ['2026-10-15', 'Возврат от покупателя', '0.00', '100.00'],
    ]);
    expect([r.turnover.debit, r.turnover.credit, r.closing]).toEqual(['500.00', '700.00', '800.00']);
    expect(r.counterparty.name).toBe('ТОО Покупатель');

    // Поставщик: мы должны — сальдо отрицательное.
    const sup = await s.reports.reconciliation(ctx, { counterpartyId: t.supplier.id, from: '2026-09-01', to: '2026-12-31' });
    expect([sup.opening, sup.closing]).toEqual(['0.00', '-1000.00']);

    expect(await code(s.reports.reconciliation(ctx, { from: '2026-10-01', to: '2026-10-31' }))).toBe('COUNTERPARTY_REQUIRED');
    expect(await code(s.reports.reconciliation(ctx, { counterpartyId: t.customer.id, from: '2026-10-31', to: '2026-10-01' }))).toBe('BAD_PERIOD');
    const foreign = await makeOrg(prisma);
    const fcp = await prisma.counterparty.create({ data: { name: 'Чужой', type: 'CUSTOMER', organizationId: foreign.organizationId } });
    expect(await code(s.reports.reconciliation(ctx, { counterpartyId: fcp.id, from: '2026-10-01', to: '2026-10-31' }))).toBe('NOT_FOUND');
  });
});
