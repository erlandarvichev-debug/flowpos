import { PrismaService } from '../src/prisma/prisma.service';
import { ProductionService } from '../src/modules/accounting/production/production.service';
import { stockTurnover } from '../src/modules/accounting/reports/flows';
import { makeServices, makeOrg, makeTrade } from './accounting-helpers';

const prisma = new PrismaService();
const s = makeServices(prisma);
const prod = new ProductionService(prisma, s.trade);

describe('Производство', () => {
  afterAll(() => prisma.$disconnect());

  it('техкарта → выпуск: сырьё списано на 8110, продукция оприходована по себестоимости сырья; отмена возвращает остатки', async () => {
    const ctx = await makeOrg(prisma);
    const t = await makeTrade(prisma, ctx, { vatPayer: false });
    const product = await prisma.product.create({ data: { name: 'Пирожок', uomId: t.uom.id, organizationId: ctx.organizationId } });
    await s.trade.create(ctx, { docType: 'SUPPLY', date: '2026-10-01', counterpartyId: t.supplier.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '10', price: '100' }, { productId: t.goods2.id, qty: '10', price: '30' }] });

    await expect(prod.saveRecipe(ctx, null, { name: 'Пирожок', productId: product.id, materials: [] })).rejects.toMatchObject({ response: expect.objectContaining({ code: 'MATERIALS_REQUIRED' }) });
    const r = await prod.saveRecipe(ctx, null, { name: 'Пирожок', productId: product.id, outputQty: '10', materials: [{ productId: t.goods.id, qty: '2' }, { productId: t.goods2.id, qty: '5' }] });
    expect(r.materials.map((m: any) => m.name)).toHaveLength(2);

    // выпуск 20 шт: сырьё × 2
    const o = await prod.createOrder(ctx, { recipeId: r.id, qty: '20', storeId: t.s1.id, date: '2026-10-05' });
    expect(o.number).toMatch(/^ПР-2026-/);
    expect(o.materials.map((m: any) => m.qty)).toEqual(['4.000', '10.000']);
    const done = await prod.complete(ctx, o.id);
    expect(done).toMatchObject({ status: 'DONE', cost: expect.anything() });
    expect(Number(done.cost)).toBe(700); // 4×100 + 10×30
    expect(done.documents.map((d: any) => d.docType).sort()).toEqual(['ENTER', 'LOSS']);

    const turn = await stockTurnover(prisma, ctx, { from: '2026-10-01', to: '2026-10-31' });
    expect(turn.lines.find((l) => l.productId === product.id)).toMatchObject({ closeQty: '20', closeSum: '700.00' });
    expect(turn.lines.find((l) => l.productId === t.goods.id)).toMatchObject({ closeQty: '6' });
    // 8110 закрыт в ноль
    const b = await prisma.$queryRaw<{ s: string }[]>`SELECT COALESCE(SUM(CASE WHEN p.side='D' THEN p.amount ELSE -p.amount END),0)::text s FROM acc_postings p JOIN acc_accounts a ON a.id=p.account_id WHERE p.organization_id=${ctx.organizationId} AND p.is_active AND p.ledger='BU' AND a.code='8110'`;
    expect(Number(b[0].s)).toBe(0);

    // отмена — остатки как до выпуска
    await prod.cancel(ctx, o.id);
    const turn2 = await stockTurnover(prisma, ctx, { from: '2026-10-01', to: '2026-10-31' });
    expect(turn2.lines.find((l) => l.productId === t.goods.id)).toMatchObject({ closeQty: '10' });
    expect(turn2.lines.find((l) => l.productId === product.id)).toBeUndefined();
  });

  it('не хватает сырья — выпуск не проводится, план остаётся', async () => {
    const ctx = await makeOrg(prisma);
    const t = await makeTrade(prisma, ctx, { vatPayer: false });
    const product = await prisma.product.create({ data: { name: 'Салат', uomId: t.uom.id, organizationId: ctx.organizationId } });
    const o = await prod.createOrder(ctx, { productId: product.id, qty: '1', storeId: t.s1.id, materials: [{ productId: t.goods.id, qty: '3' }] });
    await expect(prod.complete(ctx, o.id)).rejects.toBeTruthy();
    expect((await prod.order(ctx, o.id)).status).toBe('PLANNED');
  });
});
