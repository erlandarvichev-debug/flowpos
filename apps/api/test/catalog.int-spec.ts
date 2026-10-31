// FP-025: каталог на настоящей БД — штрихкоды в пределах клиента, упаковки и весовые на кассе, варианты,
// версии товара и внешние сопоставления (триггеры), старое поле штрихкода и отчёт о дублях.
import { randomInt, randomUUID } from 'crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { Scope } from '../src/common/scope';
import { ItemsService } from '../src/modules/catalog/items.service';
import { BarcodesService, resolveBarcode } from '../src/modules/catalog/barcodes.service';
import { WarehousesService } from '../src/modules/catalog/warehouses.service';
import { OutboxService } from '../src/common/outbox/outbox.service';
import { SalesService } from '../src/modules/trade/sales.service';
import { gs1CheckDigit } from '../src/modules/catalog/barcode';
import { DEFAULT_TENANT, defaultTenant } from './accounting-helpers';
import { runAsTenant } from '../src/common/db-context';

const prisma = new PrismaService();
const items = new ItemsService(prisma);
const barcodes = new BarcodesService(prisma);
const stores = new WarehousesService(prisma);
const sales = new SalesService(prisma, new OutboxService(prisma));
const uid = () => randomUUID().slice(0, 8);
/** Случайный корректный EAN-13 вне диапазона весовых (20–29). */
const ean = () => { const d = `48${String(randomInt(0, 1e10)).padStart(10, '0')}`; return d + gs1CheckDigit(d); };
const weightCode = (prefix: string, plu: string, grams: number) => { const d = `${prefix}${plu}${String(grams).padStart(10 - plu.length, '0')}`; return d + gs1CheckDigit(d); };

let t2: string;
let A: Scope, A2: Scope, B: Scope;
let uomA: string, uomB: string;

async function scopeIn(tenantId: string, name: string): Promise<Scope> {
  const org = await prisma.organization.create({ data: { tenantId, name: `${name} ${uid()}` } });
  const user = await prisma.user.create({ data: { tenantId, organizationId: org.id, email: `${name}-${uid()}@cat.local`, passwordHash: 'x', firstName: name, lastName: 'Тест' } });
  await prisma.orgMembership.create({ data: { userId: user.id, organizationId: org.id, role: 'owner' } });
  return { tenantId, organizationId: org.id, userId: user.id, role: 'owner' };
}
async function code(p: Promise<unknown>) {
  try { await p; return 'OK'; } catch (e: any) { return e?.response?.code ?? e?.status ?? e?.message; }
}
/** Созданные тестом товары основного клиента — убираются в afterAll, чтобы не копились в общей тестовой БД. */
const created: string[] = [];
const product = async (s: Scope, extra: Record<string, unknown> = {}) => {
  const p = await items.create(s, { name: `Товар ${uid()}`, uomId: s.tenantId === t2 ? uomB : uomA, ...extra });
  created.push(p.id);
  return p;
};

beforeAll(async () => {
  await prisma.$connect();
  await defaultTenant(prisma);
  t2 = (await prisma.tenant.create({ data: { name: `Каталог 2 ${uid()}` } })).id;
  A = await scopeIn(DEFAULT_TENANT, 'CatA');
  A2 = await scopeIn(DEFAULT_TENANT, 'CatA2');
  B = await scopeIn(t2, 'CatB');
  uomA = (await prisma.uom.create({ data: { tenantId: DEFAULT_TENANT, name: 'шт', shortName: 'шт' } })).id;
  uomB = (await prisma.uom.create({ data: { tenantId: t2, name: 'шт', shortName: 'шт' } })).id;
});

afterAll(async () => {
  // Свои данные основного клиента: продажи кассы теста, затем товары (варианты — раньше основных).
  const docs = (await prisma.document.findMany({ where: { lines: { some: { productId: { in: created } } } }, select: { id: true } })).map((d) => d.id);
  await prisma.outbox.deleteMany({ where: { localId: { in: docs } } });
  await prisma.documentLine.deleteMany({ where: { documentId: { in: docs } } });
  await prisma.document.deleteMany({ where: { id: { in: docs } } });
  await prisma.productBarcode.deleteMany({ where: { productId: { in: created } } });
  await prisma.product.deleteMany({ where: { id: { in: created }, parentId: { not: null } } });
  await prisma.product.deleteMany({ where: { id: { in: created } } });
  await prisma.productVersion.deleteMany({ where: { productId: { in: created } } });
  await prisma.externalMapping.deleteMany({ where: { entityId: { in: created } } });
  const orgs = (await prisma.organization.findMany({ where: { tenantId: t2 }, select: { id: true } })).map((o) => o.id);
  await prisma.productBarcode.deleteMany({ where: { tenantId: t2 } });
  await prisma.product.deleteMany({ where: { tenantId: t2 } });
  await prisma.productVersion.deleteMany({ where: { tenantId: t2 } });
  await prisma.externalMapping.deleteMany({ where: { tenantId: t2 } });
  await prisma.uom.deleteMany({ where: { tenantId: t2 } });
  await prisma.orgMembership.deleteMany({ where: { tenantId: t2 } });
  await prisma.user.deleteMany({ where: { tenantId: t2 } });
  await prisma.organization.deleteMany({ where: { id: { in: orgs } } });
  await prisma.tenant.delete({ where: { id: t2 } });
  await prisma.catalogSettings.deleteMany({ where: { tenantId: DEFAULT_TENANT } });
  await prisma.$disconnect();
});

describe('FP-025: штрихкоды', () => {
  it('один EAN у двух клиентов — законно; у клиента — один товар на код; чужая организация — без имени товара', async () => {
    const code13 = ean();
    const a = await product(A, { barcodes: [{ barcode: code13 }] });
    const b = await product(B, { barcodes: [{ barcode: code13 }] }); // раньше: глобальная уникальность — ошибка
    expect((await resolveBarcode(prisma, A, code13))!.productId).toBe(a.id);
    expect((await resolveBarcode(prisma, B, code13))!.productId).toBe(b.id);

    const a2 = await product(A);
    const taken: any = await barcodes.add(A, a2.id, { barcode: ` ${code13} ` }).catch((e) => e.response);
    expect(taken).toMatchObject({ code: 'BARCODE_TAKEN', message: expect.stringContaining(a.name), details: { productId: a.id } });

    // Личный товар другой организации того же клиента: код занят, но имя и id не раскрываются; найти его нельзя.
    const priv = await product(A2, { organizationId: A2.organizationId });
    const pc = ean();
    await barcodes.add(A2, priv.id, { barcode: pc });
    const hidden: any = await barcodes.add(A, a2.id, { barcode: pc }).catch((e) => e.response);
    expect(hidden.code).toBe('BARCODE_TAKEN');
    expect(hidden.message).not.toContain(priv.name);
    expect(hidden.details).toBeUndefined();
    expect(await resolveBarcode(prisma, A, pc)).toBeNull();
    expect(await code(barcodes.add(A, a2.id, { barcode: '4870000000015', kind: 'EAN13' }))).toBe('BARCODE_CHECK_DIGIT');
    expect(await code(barcodes.remove(B, a.id, a.barcodes[0].id))).toBe(404);
  });

  it('касса: упаковка — количество в базовых единицах, сумма как оплачено; весовой — вес из этикетки', async () => {
    const store = await stores.create(A, { name: `Склад ${uid()}` });
    const water = await product(A);
    const unit = ean(), box = ean();
    await barcodes.add(A, water.id, { barcode: unit });
    await barcodes.add(A, water.id, { barcode: box, factor: '12', uomId: uomA });
    expect(await code(barcodes.add(A, water.id, { barcode: ean(), factor: '0' }))).toBe('BARCODE_FACTOR');

    await barcodes.updateSettings(A, { prefixes: ['22'], pluLength: 5 });
    const plu = String(randomInt(10000, 99999));
    const cheese = await product(A, { plu });
    expect(await code(product(A, { plu }))).toBe('PLU_TAKEN');
    expect(await code(product(A, { plu: '123' }))).toBe('PLU_FORMAT');
    expect(await code(barcodes.updateSettings(A, { prefixes: ['22'], pluLength: 6 }))).toBe('WEIGHT_PLU_LENGTH_IN_USE');

    const sale = await runAsTenant(A.tenantId, () => sales.createPosSale(A, { storeId: store.id, items: [
      { barcode: unit, qty: 3, price: 100 },
      { barcode: box, qty: 2, price: 1100 },
      { barcode: weightCode('22', plu, 1234), qty: 1, price: 2000 }, // касса прислала 1 — количество берётся из этикетки
    ] }, `k-${uid()}`));
    const lines = await prisma.documentLine.findMany({ where: { documentId: sale.id }, orderBy: { lineNo: 'asc' } });
    expect(lines.map((l) => [l.productId, Number(l.qty), Number(l.amount)])).toEqual([
      [water.id, 3, 300],
      [water.id, 24, 2200],
      [cheese.id, 1.234, 2468],
    ]);
    expect(Number(lines[1].price)).toBeCloseTo(91.67, 2);
    expect(Number(sale.total)).toBe(4968);

    // Весовой с префиксом, который не настроен, и с неизвестным PLU — товар не найден.
    expect(await resolveBarcode(prisma, A, weightCode('23', plu, 1000))).toBeNull();
    expect(await resolveBarcode(prisma, A, weightCode('22', '00000', 1000))).toBeNull();
    // Другой клиент с такими же настройками не видит товар клиента A.
    expect(await resolveBarcode(prisma, B, weightCode('22', plu, 1000))).toBeNull();
  });

  it('старое поле штрихкода (обмен 1С/МойСклад) попадает в таблицу; занятый код не перехватывается и виден в дублях', async () => {
    const p1 = await product(A);
    const legacy = ean();
    await prisma.product.update({ where: { id: p1.id }, data: { barcode: ` ${legacy} ` } }); // как пишет воркер обмена
    expect(await prisma.productBarcode.findFirst({ where: { productId: p1.id } })).toMatchObject({ barcode: legacy, kind: 'EAN13', source: 'LEGACY' });
    expect((await resolveBarcode(prisma, A, legacy))!.productId).toBe(p1.id);

    const replaced = ean();
    await prisma.product.update({ where: { id: p1.id }, data: { barcode: replaced } });
    expect((await prisma.productBarcode.findMany({ where: { productId: p1.id } })).map((b) => b.barcode)).toEqual([replaced]);

    const p2 = await product(A);
    await prisma.product.update({ where: { id: p2.id }, data: { barcode: replaced } });
    expect((await resolveBarcode(prisma, A, replaced))!.productId).toBe(p1.id);
    const dups = await barcodes.duplicates(A);
    expect(dups).toContainEqual({ barcode: replaced, productId: p2.id, productName: p2.name, ownerId: p1.id, ownerName: p1.name });
    expect((await barcodes.duplicates(B)).find((d) => d.barcode === replaced)).toBeUndefined();

    // Код занят личным товаром другой организации клиента: дубль виден, но без имени и id чужого товара.
    const foreign = await product(A2, { organizationId: A2.organizationId });
    const fc = ean();
    await barcodes.add(A2, foreign.id, { barcode: fc });
    const p3 = await product(A);
    await prisma.product.update({ where: { id: p3.id }, data: { barcode: fc } });
    expect((await barcodes.duplicates(A)).find((d) => d.barcode === fc)).toEqual({ barcode: fc, productId: p3.id, productName: p3.name, ownerId: null, ownerName: 'товар другой организации клиента' });
    // Личный товар A2 в отчёте A как «товар с кодом» не появляется.
    expect((await barcodes.duplicates(A)).find((d) => d.productId === foreign.id)).toBeUndefined();
  });
});

describe('FP-025: варианты', () => {
  it('родитель без штрихкодов; характеристики обязательны и уникальны; без вложенности; по коду родителя не продаётся', async () => {
    const shirt = await product(A, { barcodes: [{ barcode: ean() }] });
    expect(await code(product(A, { parentId: shirt.id, attributes: { Размер: 'M' } }))).toBe('VARIANT_PARENT_BARCODE');
    await barcodes.remove(A, shirt.id, shirt.barcodes[0].id);

    const m = await product(A, { parentId: shirt.id, attributes: { Размер: 'M', Цвет: 'Белый' } });
    expect(m).toMatchObject({ kind: 'VARIANT', variantKey: 'размер=M|цвет=Белый' });
    expect(await code(product(A, { parentId: shirt.id, attributes: { ' цвет ': ' Белый', РАЗМЕР: 'M' } }))).toBe('VARIANT_DUPLICATE');
    expect(await code(product(A, { parentId: shirt.id }))).toBe('VARIANT_ATTRIBUTES');
    expect(await code(product(A, { parentId: m.id, attributes: { Рукав: 'Короткий' } }))).toBe('VARIANT_NESTED');
    expect(await code(product(A, { kind: 'VARIANT' }))).toBe('VARIANT_PARENT');
    expect(await code(product(B, { parentId: shirt.id, attributes: { Размер: 'L' } }))).toBe('VARIANT_PARENT');
    expect(await code(items.update(A, shirt.id, { parentId: m.id }))).toBe('VARIANT_NESTED');
    expect(await code(items.update(A, m.id, { parentId: m.id }))).toBe('VARIANT_PARENT');
    expect(await code(barcodes.add(A, shirt.id, { barcode: ean() }))).toBe('VARIANT_REQUIRED');

    // Код у родителя мог прийти из обмена — продажа по нему просит выбрать вариант.
    const parentCode = ean();
    await prisma.product.update({ where: { id: shirt.id }, data: { barcode: parentCode } });
    expect(await code(resolveBarcode(prisma, A, parentCode))).toBe('VARIANT_REQUIRED');
    const variantCode = ean();
    await barcodes.add(A, m.id, { barcode: variantCode });
    expect((await resolveBarcode(prisma, A, variantCode))!.productId).toBe(m.id);
    expect((await items.findOne(A, shirt.id)).variants.map((v) => v.id)).toEqual([m.id]);

    // Отвязать вариант — снова обычный товар.
    const detached = await items.update(A, m.id, { parentId: null });
    expect(detached).toMatchObject({ kind: 'PRODUCT', variantKey: null, parentId: null });
  });
});

describe('FP-025: версии и внешние сопоставления', () => {
  it('версия на каждое значимое изменение (кто и что); служебные изменения и повтор без версии; версии неизменяемы', async () => {
    const p = await product(A, { vatRate: 16 });
    await items.update(A, p.id, { name: `${p.name} (новое)`, vatRate: 12 });
    await items.update(A, p.id, { name: `${p.name} (новое)` }); // то же значение
    await prisma.product.update({ where: { id: p.id }, data: { syncStatus: 'DIRTY', msUpdated: new Date() } }); // служебное
    await items.archive(A, p.id);
    const v = await items.versions(A, p.id);
    expect(v.map((x) => [x.version, x.changed])).toEqual([[3, ['deleted']], [2, ['name', 'vatRate']], [1, []]]);
    expect(v[1]).toMatchObject({ changedBy: A.userId, snapshot: expect.objectContaining({ name: `${p.name} (новое)`, vatRate: 12 }) });
    expect(v[2].snapshot).toMatchObject({ name: p.name, vatRate: 16 });
    await expect(prisma.productVersion.update({ where: { id: v[0].id }, data: { changed: [] } })).rejects.toThrow(/неизменяемы/);
    expect(await code(items.versions(B, p.id))).toBe(404);
  });

  it('пересоздание в МойСклад меняет внешний id, внутренний остаётся; прежняя связь — в истории', async () => {
    const p = await product(A);
    const acc = `acc-${uid()}`;
    await prisma.product.update({ where: { id: p.id }, data: { msId: `ms-${uid()}`, msAccountId: acc } });
    const first = (await prisma.product.findUniqueOrThrow({ where: { id: p.id } })).msId!;
    const second = `ms-${uid()}`;
    await prisma.product.update({ where: { id: p.id }, data: { msId: second } });
    const guid = randomUUID();
    await prisma.product.update({ where: { id: p.id }, data: { onecGuid: guid } });
    const m = await items.mappings(A, p.id);
    expect(m.map((x) => [x.system, x.account, x.externalId, x.status])).toEqual([
      ['ONEC', 'default', guid, 'ACTIVE'],
      ['MOYSKLAD', acc, second, 'ACTIVE'],
      ['MOYSKLAD', acc, first, 'DETACHED'],
    ].sort((a, b) => (a[3] === b[3] ? 0 : a[3] < b[3] ? -1 : 1)) as any);
    expect(m.find((x) => x.externalId === first)!.detachedAt).not.toBeNull();
    // Внешние id из API не принимаются — меняет только обмен.
    await items.update(A, p.id, { msId: 'подмена', onecGuid: randomUUID(), syncStatus: 'SYNCED', deleted: true });
    expect(await prisma.product.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ msId: second, onecGuid: guid, deleted: false });
  });
});
