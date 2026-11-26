import { PrismaService } from '../src/prisma/prisma.service';
import { makeServices, makeOrg, makeTrade } from './accounting-helpers';

const prisma = new PrismaService();
const s = makeServices(prisma);

describe('Внутренние заказы и договоры', () => {
  afterAll(() => prisma.$disconnect());
  it('внутренний заказ → перемещение по нему (частями), без проводок; закрытый/исполненный — понятно', async () => {
    const ctx = await makeOrg(prisma);
    const t = await makeTrade(prisma, ctx, { vatPayer: false });
    await s.trade.create(ctx, { docType: 'SUPPLY', date: '2026-10-01', counterpartyId: t.supplier.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '20', price: '100' }] });
    const io = await s.trade.create(ctx, { docType: 'INTERNAL_ORDER', date: '2026-10-02', storeId: t.s1.id, storeToId: t.s2.id, lines: [{ productId: t.goods.id, qty: '8' }], status: 'POSTED' });
    expect(io.number).toMatch(/^ВЗ/);
    expect((io as any).entry ?? null).toBeNull();
    const mv = await s.trade.fromBase(ctx, io.id, 'MOVE', '2026-10-03');
    expect([mv.storeId, mv.storeToId]).toEqual([t.s1.id, t.s2.id]);
    const cur = await prisma.document.findUniqueOrThrow({ where: { id: mv.id } });
    await s.trade.update(ctx, mv.id, { expectedVersion: cur.version, lines: [{ productId: t.goods.id, qty: '5' }] } as any);
    await s.trade.post(ctx, mv.id);
    const v = await s.trade.get(ctx, io.id) as any;
    expect(v.fulfillment.state).toBe('PARTIAL');
    const rest = await s.trade.fromBase(ctx, io.id, 'MOVE', '2026-10-04');
    expect(rest.lines.map((l: any) => Number(l.qty))).toEqual([3]);

    const k = await prisma.contract.create({ data: { organizationId: ctx.organizationId, counterpartyId: t.customer.id, number: 'Д-1', paymentDays: 15 } });
    await s.trade.create(ctx, { docType: 'DEMAND', date: '2026-10-05', counterpartyId: t.customer.id, contractId: k.id, storeId: t.s1.id, lines: [{ productId: t.goods.id, qty: '1', price: '200' }] });
    const reg = await s.refs.contractRegistry(ctx, { active: '1' });
    expect(reg.find((r: any) => r.id === k.id)).toMatchObject({ number: 'Д-1', documents: 1, counterparty: { name: 'ТОО Покупатель' } });
  });
});
