// FP-031: себестоимость и дополнительные расходы — эталон (себестоимость продаж 2200, прибыль 800, остаток 8800) обоими
// методами, доп. расходы после продажи и на перемещённую партию, детерминированное округление, метод периода — на
// настоящей БД.
import { Prisma } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { makeServices, makeOrg, makeTrade } from './accounting-helpers';
import { OrgContext } from '../src/modules/accounting/access/org-context';

const prisma = new PrismaService();
const s = makeServices(prisma);
const D = Prisma.Decimal;

async function code(p: Promise<unknown>) {
  try { await p; return 'OK'; } catch (e: any) { return e?.response?.code ?? e?.message; }
}
/** Сальдо (Дт − Кт) действующих проводок счёта; по товару и складу — если заданы. */
async function bal(ctx: OrgContext, account: string, f: { productId?: string; storeId?: string } = {}) {
  const rows = await prisma.accPosting.findMany({ where: { organizationId: ctx.organizationId, isActive: true, account: { code: account }, ...f } });
  return rows.reduce((a, r) => (r.side === 'D' ? a.plus(r.amount) : a.minus(r.amount)), new D(0)).toFixed(2);
}

beforeAll(async () => {
  await prisma.$connect();
  await s.chart.bootstrap();
});
afterAll(() => prisma.$disconnect());

async function world(method: 'FIFO' | 'AVERAGE', vatPayer = false) {
  const ctx = await makeOrg(prisma);
  const t = await makeTrade(prisma, ctx, { vatPayer, method });
  const supply = (lines: any[], date = '2026-10-01', storeId = t.s1.id) => s.trade.create(ctx, { docType: 'SUPPLY', date, counterpartyId: t.supplier.id, storeId, status: 'POSTED', lines });
  const landed = (baseId: string, amount: string, date = '2026-10-02', extra: any = {}) =>
    s.trade.create(ctx, { docType: 'LANDED_COST', date, counterpartyId: t.supplier.id, baseId, status: 'POSTED', lines: [{ productId: t.service.id, qty: '1', price: amount }], ...extra });
  const sale = (productId: string, qty: string, price: string, date = '2026-10-03', storeId = t.s1.id) =>
    s.trade.create(ctx, { docType: 'DEMAND', date, counterpartyId: t.customer.id, storeId, status: 'POSTED', lines: [{ productId, qty, price }] });
  return { ctx, t, supply, landed, sale };
}

describe('FP-031: эталон себестоимости с доп. расходами', () => {
  it.each(['FIFO', 'AVERAGE'] as const)('%s: 10 × 1000 + доставка 1000, продажа 2 × 1500 → себестоимость 2200, прибыль 800, остаток 8800', async (method) => {
    const { ctx, t, supply, landed, sale } = await world(method);
    const sup = await supply([{ productId: t.goods.id, qty: '10', price: '1000' }]);
    const lc = await landed(sup.id, '1000');
    expect(lc.number).toMatch(/^ДР-2026-/);
    expect(lc.entry!.postings.map((p: any) => `${p.side}${p.account.code}:${new D(p.amount).toFixed(2)}`).sort()).toEqual(['C3310:1000.00', 'D1330:1000.00']);
    expect(lc.movements).toEqual([]); // количество не меняется
    await sale(t.goods.id, '2', '1500');
    expect([await bal(ctx, '7010'), await bal(ctx, '6010'), await bal(ctx, '1330')]).toEqual(['2200.00', '-3000.00', '8800.00']);
    expect(new D(await bal(ctx, '6010')).neg().minus(await bal(ctx, '7010')).toFixed(2)).toBe('800.00');
    expect(await bal(ctx, '3310')).toBe('-11000.00');
    // Повторный пересчёт ничего не меняет (версии записей себестоимости те же).
    const before = await prisma.accEntry.findMany({ where: { organizationId: ctx.organizationId, sourceType: 'COST', status: 'ACTIVE' }, select: { id: true, sourceVersion: true }, orderBy: { id: 'asc' } });
    await prisma.$transaction((tx) => s.cost.recalcProducts(tx, ctx, [t.goods.id]));
    expect(await prisma.accEntry.findMany({ where: { organizationId: ctx.organizationId, sourceType: 'COST', status: 'ACTIVE' }, select: { id: true, sourceVersion: true }, orderBy: { id: 'asc' } })).toEqual(before);
  });

  it.each(['FIFO', 'AVERAGE'] as const)('%s: доп. расходы после продажи — доля проданного в себестоимость на их дату, итог тот же', async (method) => {
    const { ctx, t, supply, landed, sale } = await world(method);
    const sup = await supply([{ productId: t.goods.id, qty: '10', price: '1000' }]);
    await sale(t.goods.id, '2', '1500', '2026-10-02');
    const lc = await landed(sup.id, '1000', '2026-10-05');
    const cost = (await s.trade.get(ctx, lc.id)).costEntries.flatMap((e: any) => e.postings).map((p: any) => `${p.side}${p.account.code}:${new D(p.amount).toFixed(2)}`).sort();
    expect(cost).toEqual(['C1330:200.00', 'D7010:200.00']);
    expect([await bal(ctx, '7010'), await bal(ctx, '1330')]).toEqual(['2200.00', '8800.00']);
    await sale(t.goods.id, '8', '1500', '2026-10-06');
    expect([await bal(ctx, '7010'), await bal(ctx, '1330')]).toEqual(['11000.00', '0.00']);
  });

  it('FIFO: доп. расходы на партию, часть которой перемещена, — стоимость следует за партией на другой склад', async () => {
    const { ctx, t, supply, landed, sale } = await world('FIFO');
    const sup = await supply([{ productId: t.goods.id, qty: '10', price: '1000' }]);
    const mv = await s.trade.create(ctx, { docType: 'MOVE', date: '2026-10-02', storeId: t.s1.id, storeToId: t.s2.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '4' }] });
    expect(mv.status).toBe('POSTED');
    await landed(sup.id, '1000', '2026-10-03');
    expect([await bal(ctx, '1330', { storeId: t.s1.id }), await bal(ctx, '1330', { storeId: t.s2.id })]).toEqual(['6600.00', '4400.00']);
    await sale(t.goods.id, '4', '2000', '2026-10-04', t.s2.id);
    expect([await bal(ctx, '7010'), await bal(ctx, '1330', { storeId: t.s2.id })]).toEqual(['4400.00', '0.00']);
  });

  it('распределение по сумме и по количеству, НДС доп. расходов к зачёту, округление — детерминированно', async () => {
    const { ctx, t, supply, landed } = await world('FIFO', true);
    // Цены без НДС: суммы строк 900 и 90 (1 × 900, 9 × 10).
    const sup = await s.trade.create(ctx, { docType: 'SUPPLY', date: '2026-10-01', counterpartyId: t.supplier.id, storeId: t.s1.id, vatIncluded: false, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '1', price: '900' }, { productId: t.goods2.id, qty: '9', price: '10' }] });
    const byAmount = await landed(sup.id, '116', '2026-10-02'); // с НДС 16%: 100 + 16
    const inv = (doc: any) => doc.entry.postings.filter((p: any) => p.account.code === '1330').map((p: any) => [p.productId ?? null, new D(p.amount).toFixed(2)]);
    // 100 × 900/990 = 90.909 → 90.91; 100 × 90/990 = 9.0909 → 9.09 (сумма 100.00)
    expect(inv(await s.trade.get(ctx, byAmount.id)).map((x: any) => x[1])).toEqual(['90.91', '9.09']);
    expect((await s.trade.get(ctx, byAmount.id)).entry!.postings.filter((p: any) => p.account.code === '1420').map((p: any) => new D(p.amount).toFixed(2))).toEqual(['16.00']);
    const byQty = await landed(sup.id, '116', '2026-10-02', { allocation: 'QTY' });
    expect(inv(await s.trade.get(ctx, byQty.id)).map((x: any) => x[1])).toEqual(['10.00', '90.00']);
    // Остаток округления: 100 на три равные строки → 33.34 / 33.33 / 33.33 (лишний тиын — первой строке).
    const sup3 = await s.trade.create(ctx, { docType: 'SUPPLY', date: '2026-10-01', counterpartyId: t.supplier.id, storeId: t.s1.id, vatIncluded: false, status: 'POSTED', lines: [1, 2, 3].map(() => ({ productId: t.goods.id, qty: '1', price: '10' })) });
    const r3 = await landed(sup3.id, '116', '2026-10-02');
    expect(inv(await s.trade.get(ctx, r3.id)).map((x: any) => x[1])).toEqual(['33.34', '33.33', '33.33']);
    expect(await bal(ctx, '1330')).toBe(new D(990).plus(30).plus(300).toFixed(2));
  });

  it('средняя: последняя единица забирает весь остаток стоимости — остаток 0 без копеек', async () => {
    const { ctx, t, supply, sale } = await world('AVERAGE');
    await supply([{ productId: t.goods.id, qty: '1', price: '50' }, { productId: t.goods.id, qty: '2', price: '25' }]);
    await sale(t.goods.id, '2', '100', '2026-10-02');
    expect(await bal(ctx, '7010')).toBe('66.67');
    await sale(t.goods.id, '1', '100', '2026-10-03');
    expect([await bal(ctx, '7010'), await bal(ctx, '1330')]).toEqual(['100.00', '0.00']);
  });
});

describe('FP-031: доп. расходы — проверки и зависимости', () => {
  it('основание обязательно, проведённое, не позже; поступление с доп. расходами не снять и не изменить', async () => {
    const { ctx, t, supply, landed } = await world('FIFO');
    expect(await code(s.trade.create(ctx, { docType: 'LANDED_COST', date: '2026-10-02', counterpartyId: t.supplier.id, lines: [{ productId: t.service.id, qty: '1', price: '10' }] }))).toBe('LANDED_BASE_REQUIRED');
    const draft = await s.trade.create(ctx, { docType: 'SUPPLY', date: '2026-10-01', counterpartyId: t.supplier.id, storeId: t.s1.id, lines: [{ productId: t.goods.id, qty: '1', price: '10' }] });
    expect(await code(landed(draft.id, '10'))).toBe('LANDED_BASE_NOT_POSTED');
    const sale = await s.trade.create(ctx, { docType: 'DEMAND', date: '2026-10-01', counterpartyId: t.customer.id, storeId: t.s1.id, lines: [{ productId: t.goods.id, qty: '1', price: '10' }] });
    expect(await code(landed(sale.id, '10'))).toBe('LANDED_BASE_REQUIRED');
    const sup = await supply([{ productId: t.goods.id, qty: '5', price: '10' }], '2026-10-05');
    expect(await code(landed(sup.id, '10', '2026-10-04'))).toBe('LANDED_BEFORE_BASE');
    // Черновик тоже не создать (проверка при сохранении, а не только при проведении).
    const draftLc = (baseId: string, date: string) => s.trade.create(ctx, { docType: 'LANDED_COST', date, counterpartyId: t.supplier.id, baseId, lines: [{ productId: t.service.id, qty: '1', price: '10' }] });
    expect(await code(draftLc(sup.id, '2026-10-04'))).toBe('LANDED_BEFORE_BASE');
    expect(await code(draftLc(draft.id, '2026-10-05'))).toBe('LANDED_BASE_NOT_POSTED');
    expect(await code(landed(sup.id, '10', '2026-10-05', { allocation: 'WEIGHT' }))).toBe('BAD_ALLOCATION');
    const lc = await landed(sup.id, '10', '2026-10-05');
    expect(lc.storeId).toBe(t.s1.id);

    expect(await code(s.trade.unpost(ctx, sup.id))).toBe('LANDED_COST_DEPENDS');
    expect(await code(s.trade.cancel(ctx, sup.id))).toBe('LANDED_COST_DEPENDS');
    expect(await code(s.trade.update(ctx, sup.id, { expectedVersion: (await s.trade.get(ctx, sup.id)).version, reason: 'правка', lines: [{ productId: t.goods.id, qty: '4', price: '10' }] }))).toBe('LANDED_COST_DEPENDS');
    // Сначала доп. расходы — потом поступление.
    await s.trade.unpost(ctx, lc.id);
    expect(await bal(ctx, '1330')).toBe('50.00');
    expect((await s.trade.unpost(ctx, sup.id)).status).toBe('DRAFT');
    expect(await bal(ctx, '1330')).toBe('0.00');
  });

  it('пробное проведение доп. расходов показывает проводки и ничего не пишет', async () => {
    const { ctx, t, supply } = await world('FIFO');
    const sup = await supply([{ productId: t.goods.id, qty: '2', price: '100' }]);
    const lc = await s.trade.create(ctx, { docType: 'LANDED_COST', date: '2026-10-02', counterpartyId: t.supplier.id, baseId: sup.id, lines: [{ productId: t.service.id, qty: '1', price: '30' }] });
    const sim = await s.trade.simulate(ctx, lc.id);
    expect(sim.error).toBeNull();
    expect(sim.entry.postings.map((p: any) => `${p.side}${p.account.code}:${new D(p.amount).toFixed(2)}`).sort()).toEqual(['C3310:30.00', 'D1330:30.00']);
    expect(await bal(ctx, '1330')).toBe('200.00');
  });
});

describe('FP-031: метод оценки — метод периода', () => {
  it('смена метода — только с 1-го числа и в открытом периоде; другие поля политики — с любой даты', async () => {
    const ctx = await makeOrg(prisma);
    await makeTrade(prisma, ctx, { method: 'FIFO' });
    expect(await code(s.refs.addPolicy(ctx, { validFrom: '2026-10-15', inventoryMethod: 'AVERAGE' }))).toBe('METHOD_PERIOD_START');
    expect((await s.refs.addPolicy(ctx, { validFrom: '2026-10-15', allowNegativeStock: true })).inventoryMethod).toBe('FIFO');
    await prisma.accPeriodLock.create({ data: { organizationId: ctx.organizationId, lockedUntil: new Date('2026-09-30') } });
    expect(await code(s.refs.addPolicy(ctx, { validFrom: '2026-09-01', inventoryMethod: 'AVERAGE' }))).toBe('METHOD_PERIOD_CLOSED');
    expect((await s.refs.addPolicy(ctx, { validFrom: '2026-11-01', inventoryMethod: 'AVERAGE' })).inventoryMethod).toBe('AVERAGE');
  });

  it('метод берётся на 1-е число месяца: версия с середины месяца действует со следующего', async () => {
    const { ctx, t, supply, sale } = await world('FIFO');
    // Как в старых данных: политика AVERAGE с 15 октября (до правила FP-031 так можно было).
    await prisma.accPolicy.create({ data: { organizationId: ctx.organizationId, validFrom: new Date('2026-10-15'), inventoryMethod: 'AVERAGE' } });
    await supply([{ productId: t.goods.id, qty: '1', price: '10' }], '2026-10-01');
    await supply([{ productId: t.goods.id, qty: '1', price: '20' }], '2026-10-02');
    await sale(t.goods.id, '1', '100', '2026-10-20'); // октябрь — ещё FIFO: 10 (средняя дала бы 15)
    expect(await bal(ctx, '7010')).toBe('10.00');
    await supply([{ productId: t.goods.id, qty: '1', price: '40' }], '2026-11-02');
    await sale(t.goods.id, '1', '100', '2026-11-10'); // ноябрь — средняя: (20 + 40) / 2 = 30 (FIFO дал бы 20)
    expect(await bal(ctx, '7010')).toBe('40.00');
  });
});
