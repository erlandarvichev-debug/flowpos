import { PrismaService } from '../src/prisma/prisma.service';
import { LoyaltyService } from '../src/modules/accounting/loyalty/loyalty.service';
import { makeServices, makeOrg, makeTrade } from './accounting-helpers';

const prisma = new PrismaService();
const s = makeServices(prisma);
const loyalty = new LoyaltyService(prisma);

describe('Бонусная программа', () => {
  afterAll(() => prisma.$disconnect());
  it('начисление % от продаж, снятие при отмене, списание с лимитами, ручная правка с причиной', async () => {
    const ctx = await makeOrg(prisma);
    const t = await makeTrade(prisma, ctx, { vatPayer: false });
    await s.trade.create(ctx, { docType: 'SUPPLY', date: '2026-01-01', counterpartyId: t.supplier.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '50', price: '100' }] });
    await loyalty.saveSettings(ctx, { isActive: true, accrualPercent: '5', maxPayPercent: '30' });
    const today = new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10);
    const sale = await s.trade.create(ctx, { docType: 'DEMAND', date: today, counterpartyId: t.customer.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '4', price: '250' }] });
    const b = await loyalty.balances(ctx, {});
    expect(b.find((r) => r.counterpartyId === t.customer.id)).toMatchObject({ accrued: '50.00', balance: '50.00' });
    // повторное чтение не начисляет дважды
    expect((await loyalty.history(ctx, t.customer.id)).balance).toBe('50.00');

    await expect(loyalty.move(ctx, { counterpartyId: t.customer.id, points: '60' })).rejects.toMatchObject({ response: expect.objectContaining({ code: 'NOT_ENOUGH_POINTS' }) });
    const sale2 = await s.trade.create(ctx, { docType: 'DEMAND', date: today, counterpartyId: t.customer.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '1', price: '100' }] });
    await expect(loyalty.move(ctx, { counterpartyId: t.customer.id, points: '40', documentId: sale2.id })).rejects.toMatchObject({ response: expect.objectContaining({ code: 'POINTS_LIMIT' }) });
    const h = await loyalty.move(ctx, { counterpartyId: t.customer.id, points: '30', documentId: sale2.id });
    expect(h.balance).toBe('25.00'); // 50 + 5 − 30
    await expect(loyalty.move(ctx, { counterpartyId: t.customer.id, kind: 'ADJUST', points: '10' })).rejects.toMatchObject({ response: expect.objectContaining({ code: 'REASON_REQUIRED' }) });
    expect((await loyalty.move(ctx, { counterpartyId: t.customer.id, kind: 'ADJUST', points: '10', comment: 'Подарок на день рождения' })).balance).toBe('35.00');

    // отмена продажи снимает её начисление
    await s.trade.unpost(ctx, sale.id);
    expect((await loyalty.history(ctx, t.customer.id)).balance).toBe('-15.00');
  });
});
