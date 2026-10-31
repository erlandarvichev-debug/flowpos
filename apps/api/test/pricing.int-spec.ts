// FP-027: прайс-листы (приоритет/интервал), скидки, округление, предпросмотр и неизменяемые снимки для кассы на
// настоящей БД; только своя организация.
import { randomUUID } from 'crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { Scope } from '../src/common/scope';
import { PricingService } from '../src/modules/pricing/pricing.service';
import { evaluate } from '../src/modules/pricing/engine';
import { DEFAULT_TENANT, defaultTenant, makeOrg } from './accounting-helpers';

const prisma = new PrismaService();
const pricing = new PricingService(prisma);
const uid = () => randomUUID().slice(0, 8);
const scope = (c: { tenantId: string; organizationId: string; userId: string }): Scope => ({ tenantId: c.tenantId, organizationId: c.organizationId, userId: c.userId, role: 'owner' });
async function code(p: Promise<unknown>) {
  try { await p; return 'OK'; } catch (e: any) { return e?.response?.code ?? e?.status ?? e?.message; }
}

let A: Scope, A2: Scope, B: Scope, t2: string;
const products: string[] = [];
async function product(tenantId: string, groupId?: string) {
  const uom = (await prisma.uom.findFirst({ where: { tenantId } })) ?? (await prisma.uom.create({ data: { tenantId, name: 'шт', shortName: 'шт' } }));
  const p = await prisma.product.create({ data: { tenantId, name: `Цена ${uid()}`, uomId: uom.id, groupId } });
  products.push(p.id);
  return p.id;
}

beforeAll(async () => {
  await prisma.$connect();
  await defaultTenant(prisma);
  A = scope(await makeOrg(prisma));
  A2 = scope(await makeOrg(prisma));
  t2 = (await prisma.tenant.create({ data: { name: `Цены 2 ${uid()}` } })).id;
  const orgB = await prisma.organization.create({ data: { tenantId: t2, name: `B ${uid()}` } });
  B = { tenantId: t2, organizationId: orgB.id, userId: 'user-b', role: 'owner' };
});

afterAll(async () => {
  await prisma.priceListItem.deleteMany({ where: { productId: { in: products } } });
  await prisma.product.deleteMany({ where: { id: { in: products } } });
  await prisma.uom.deleteMany({ where: { tenantId: t2 } });
  await prisma.organization.deleteMany({ where: { tenantId: t2 } });
  await prisma.tenant.delete({ where: { id: t2 } });
  await prisma.$disconnect();
});

async function activeList(s: Scope, name: string, priority: number, validFrom: string, validTo: string | null, items: { productId: string; price: string; minQty?: string }[], storeIds: string[] = []) {
  const l = await pricing.createPriceList(s, { name, priority, validFrom, validTo, storeIds });
  await pricing.setItems(s, l.id, { upsert: items });
  await pricing.updatePriceList(s, l.id, { status: 'ACTIVE' });
  return l;
}

describe('FP-027: управление ценами и скидками', () => {
  it('ссылки только своей организации и клиента; проверки ввода; пустой лист не активируется', async () => {
    const pA = await product(DEFAULT_TENANT);
    const pB = await product(t2);
    const storeA2 = await prisma.store.create({ data: { organizationId: A2.organizationId, name: `Склад ${uid()}` } });
    expect(await code(pricing.createPriceList(A, { name: 'x', validFrom: '2026-01-01', storeIds: [storeA2.id] }))).toBe('REF_FOREIGN');
    expect(await code(pricing.createPriceList(A, { name: 'x', validFrom: '2026-05-01', validTo: '2026-04-01' }))).toBe('INTERVAL');
    expect(await code(pricing.createPriceList(A, { name: 'x', validFrom: '2026-01-01', priority: 1.5 }))).toBe('PRIORITY');
    const l = await pricing.createPriceList(A, { name: 'Розница', validFrom: '2026-01-01' });
    expect(await code(pricing.updatePriceList(A, l.id, { status: 'ACTIVE' }))).toBe('EMPTY_LIST');
    expect(await code(pricing.setItems(A, l.id, { upsert: [{ productId: pB, price: '10' }] }))).toBe('REF_FOREIGN');
    expect(await code(pricing.setItems(A, l.id, { upsert: [{ productId: pA, price: '10.005' }] }))).toBe('NUMBER');
    expect(await code(pricing.setItems(A, l.id, { upsert: [{ productId: pA, price: '10', minQty: '0' }] }))).toBe('NUMBER');
    await pricing.setItems(A, l.id, { upsert: [{ productId: pA, price: '10' }, { productId: pA, price: '9', minQty: '10' }] });
    await pricing.setItems(A, l.id, { upsert: [{ productId: pA, price: '11' }], remove: [{ productId: pA, minQty: '10' }] });
    expect((await pricing.getPriceList(A, l.id)).items.map((i) => [i.price.toFixed(2), i.minQty.toString()])).toEqual([['11.00', '1']]);
    // Другая организация того же клиента не видит и не меняет.
    expect(await code(pricing.getPriceList(A2, l.id))).toBe(404);
    expect(await code(pricing.setItems(A2, l.id, { upsert: [{ productId: pA, price: '1' }] }))).toBe(404);
    expect(await code(pricing.createDiscount(A, { name: 'x', kind: 'PERCENT', value: '101', validFrom: '2026-01-01' }))).toBe('NUMBER');
    expect(await code(pricing.createDiscount(A, { name: 'x', kind: 'BOGO', value: '1', validFrom: '2026-01-01' }))).toBe('KIND');
    expect(await code(pricing.createDiscount(A, { name: 'x', kind: 'PERCENT', value: '5', validFrom: '2026-01-01', productIds: [pB] }))).toBe('REF_FOREIGN');
    expect(await code(pricing.updateSettings(A, { receiptStep: '0' }))).toBe('NUMBER');
  });
});

describe('FP-027: предпросмотр и снимки', () => {
  it('приоритет и интервал: акция поверх розницы в свои даты; черновик, архив и чужая организация не влияют', async () => {
    const milk = await product(DEFAULT_TENANT);
    await activeList(A, 'Розница', 0, '2026-01-01', null, [{ productId: milk, price: '500' }]);
    await activeList(A, 'Акция недели', 10, '2026-11-02', '2026-11-08', [{ productId: milk, price: '420' }]);
    const draft = await pricing.createPriceList(A, { name: 'Черновик', priority: 100, validFrom: '2026-01-01' });
    await pricing.setItems(A, draft.id, { upsert: [{ productId: milk, price: '1' }] });
    const archived = await activeList(A, 'Старый', 50, '2026-01-01', null, [{ productId: milk, price: '2' }]);
    await pricing.updatePriceList(A, archived.id, { status: 'ARCHIVED' });
    await activeList(A2, 'Чужая организация', 1000, '2026-01-01', null, [{ productId: milk, price: '3' }]);
    const at = async (date: string) => (await pricing.preview(A, { date, lines: [{ productId: milk, qty: '2' }] })).lines[0];
    expect(await at('2026-11-01')).toMatchObject({ basePrice: '500.00', priceListName: 'Розница', amount: '1000.00' });
    expect(await at('2026-11-02')).toMatchObject({ basePrice: '420.00', priceListName: 'Акция недели' });
    expect(await at('2026-11-09')).toMatchObject({ basePrice: '500.00' });
    expect(await code(pricing.preview(A, { date: '2026-11-01', lines: [] }))).toBe('LINES');
  });

  it('скидки и округление в предпросмотре: что применено и почему не применено другое', async () => {
    const S = scope(await makeOrg(prisma));
    const group = await prisma.productGroup.create({ data: { tenantId: DEFAULT_TENANT, name: `Молочка ${uid()}` } });
    const milk = await product(DEFAULT_TENANT, group.id);
    const bread = await product(DEFAULT_TENANT);
    await activeList(S, 'Розница', 0, '2026-01-01', null, [{ productId: milk, price: '499.90' }, { productId: bread, price: '250' }]);
    await pricing.createDiscount(S, { name: 'Молочка −7%', kind: 'PERCENT', value: '7', validFrom: '2026-01-01', groupIds: [group.id], status: 'ACTIVE' });
    await pricing.createDiscount(S, { name: 'Хлеб от 5 шт.', kind: 'AMOUNT', value: '30', validFrom: '2026-01-01', productIds: [bread], minQty: '5', status: 'ACTIVE' });
    await pricing.createDiscount(S, { name: 'Черновик −90%', kind: 'PERCENT', value: '90', validFrom: '2026-01-01' });
    await pricing.updateSettings(S, { receiptStep: '5', receiptMode: 'HALF_UP' });
    const r = await pricing.preview(S, { date: '2026-11-03', lines: [{ productId: milk, qty: '3' }, { productId: bread, qty: '2' }] });
    expect(r.lines.map((l) => [l.gross, l.discountName, l.discount, l.amount])).toEqual([
      ['1499.70', 'Молочка −7%', '104.98', '1394.72'],
      ['500.00', null, '0.00', '500.00'],
    ]);
    expect(r.lines[1].notes).toEqual(['«Хлеб от 5 шт.»: от 5 шт.']);
    expect(r).toMatchObject({ gross: '1999.70', discount: '104.98', total: '1894.72', rounding: '0.28', payable: '1895.00', source: { live: true } });
  });

  it('снимок для кассы: версия и hash; повтор без изменений — та же версия; снимок неизменяем и считает как раньше', async () => {
    const S = scope(await makeOrg(prisma));
    const tea = await product(DEFAULT_TENANT);
    const l = await activeList(S, 'Розница', 0, '2026-01-01', null, [{ productId: tea, price: '700' }]);
    const v1 = await pricing.publishSnapshot(S, { from: '2026-11-03', horizonDays: 7 });
    expect(v1).toMatchObject({ version: 1, storeKey: '*', validFrom: '2026-11-03', horizonTo: '2026-11-10', unchanged: false, hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(await pricing.publishSnapshot(S, { from: '2026-11-03', horizonDays: 7 })).toMatchObject({ version: 1, unchanged: true });
    // Цена изменилась — новая версия; первая остаётся как была.
    await pricing.setItems(S, l.id, { upsert: [{ productId: tea, price: '750' }] });
    const v2 = await pricing.publishSnapshot(S, { from: '2026-11-03', horizonDays: 7 });
    expect(v2).toMatchObject({ version: 2, unchanged: false });
    expect(v2.hash).not.toBe(v1.hash);
    const line = { date: '2026-11-04', lines: [{ productId: tea, qty: '1' }] };
    expect((await pricing.preview(S, { ...line, snapshotId: v1.id })).lines[0].basePrice).toBe('700.00');
    expect((await pricing.preview(S, { ...line, snapshotId: v2.id })).lines[0].basePrice).toBe('750.00');
    expect(await code(pricing.preview(S, { date: '2026-11-11', lines: line.lines, snapshotId: v1.id }))).toBe('SNAPSHOT_RANGE');
    await expect(prisma.pricingSnapshot.update({ where: { id: v1.id }, data: { hash: 'x' } })).rejects.toThrow(/неизменяем/);
    await expect(prisma.pricingSnapshot.delete({ where: { id: v1.id } })).rejects.toThrow(/неизменяем/);

    // Касса: последний снимок с телом; та же версия у кассы — без тела. Расчёт по телу совпадает с сервером.
    const latest: any = await pricing.latestSnapshot(S);
    expect(latest).toMatchObject({ version: 2, hash: v2.hash });
    expect(await pricing.latestSnapshot(S, undefined, '2')).toMatchObject({ version: 2, notModified: true });
    expect(evaluate(latest.payload, line)).toEqual((({ source, ...rest }) => rest)(await pricing.preview(S, line) as any));
    // Чужая организация не получает снимок и не считает по нему.
    expect(await code(pricing.preview(A2, { ...line, snapshotId: v2.id }))).toBe(404);
  });

  it('снимок магазина: свои правила магазина и общие; касса магазина без своего снимка получает общий', async () => {
    const S = scope(await makeOrg(prisma));
    const st1 = await prisma.store.create({ data: { organizationId: S.organizationId, name: `М1 ${uid()}` } });
    const st2 = await prisma.store.create({ data: { organizationId: S.organizationId, name: `М2 ${uid()}` } });
    const juice = await product(DEFAULT_TENANT);
    await activeList(S, 'Розница', 0, '2026-01-01', null, [{ productId: juice, price: '300' }]);
    await activeList(S, 'Магазин 1', 5, '2026-01-01', null, [{ productId: juice, price: '280' }], [st1.id]);
    const s1 = await pricing.publishSnapshot(S, { storeId: st1.id, from: '2026-11-03' });
    const all = await pricing.publishSnapshot(S, { from: '2026-11-03' });
    expect(s1.storeKey).toBe(st1.id);
    const p1: any = await pricing.latestSnapshot(S, st1.id);
    expect(p1.id).toBe(s1.id);
    expect(p1.payload.priceLists.map((x: any) => x.name).sort()).toEqual(['Магазин 1', 'Розница']);
    const p2: any = await pricing.latestSnapshot(S, st2.id);
    expect(p2.id).toBe(all.id); // своего снимка у магазина 2 нет — общий
    expect(evaluate(p2.payload, { date: '2026-11-04', storeId: st2.id, lines: [{ productId: juice, qty: '1' }] }).lines[0].basePrice).toBe('300.00');
    expect(evaluate(p2.payload, { date: '2026-11-04', storeId: st1.id, lines: [{ productId: juice, qty: '1' }] }).lines[0].basePrice).toBe('280.00');
    expect(await code(pricing.publishSnapshot(S, { storeId: st1.id, horizonDays: 40 }))).toBe('HORIZON');
  });
});
