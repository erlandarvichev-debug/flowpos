// FP-007 фаза 3: старые модули (каталог, склады, пользователи, аналитика) видят и меняют только данные
// своего клиента и организации; клиент, организация и id из тела запроса не принимаются.
// Сервисы работают через общий клиент БД — второй клиент здесь настоящий и удаляется в afterAll.
import { randomUUID } from 'crypto';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../src/prisma/prisma.service';
import { Scope } from '../src/common/scope';
import { ItemsService } from '../src/modules/catalog/items.service';
import { CounterpartiesService } from '../src/modules/catalog/counterparties.service';
import { WarehousesService } from '../src/modules/catalog/warehouses.service';
import { UsersService } from '../src/modules/users/users.service';
import { AnalyticsService } from '../src/modules/analytics/analytics.service';
import { DEFAULT_TENANT, defaultTenant } from './accounting-helpers';

const prisma = new PrismaService();
const items = new ItemsService(prisma);
const cps = new CounterpartiesService(prisma);
const stores = new WarehousesService(prisma);
const users = new UsersService(prisma);
const analytics = new AnalyticsService(prisma);
const uid = () => randomUUID().slice(0, 8);

let t2: string;
let A: Scope, A2: Scope, B: Scope;
let uomA: string, uomB: string;

async function scopeIn(tenantId: string, name: string): Promise<Scope> {
  const org = await prisma.organization.create({ data: { tenantId, name: `${name} ${uid()}` } });
  const user = await prisma.user.create({ data: { tenantId, organizationId: org.id, email: `${name}-${uid()}@scope.local`, passwordHash: 'x', firstName: name, lastName: 'Тест' } });
  return { tenantId, organizationId: org.id, userId: user.id };
}

async function code(p: Promise<unknown>) {
  try { await p; return 'OK'; } catch (e: any) { return e instanceof NotFoundException ? 404 : e instanceof ForbiddenException ? 403 : e?.status ?? e?.message; }
}

beforeAll(async () => {
  await prisma.$connect();
  await defaultTenant(prisma);
  t2 = (await prisma.tenant.create({ data: { name: `Клиент 2 ${uid()}` } })).id;
  A = await scopeIn(DEFAULT_TENANT, 'A');
  A2 = await scopeIn(DEFAULT_TENANT, 'A2');
  B = await scopeIn(t2, 'B');
  uomA = (await prisma.uom.create({ data: { tenantId: DEFAULT_TENANT, name: 'шт', shortName: 'шт' } })).id;
  uomB = (await prisma.uom.create({ data: { tenantId: t2, name: 'шт', shortName: 'шт' } })).id;
});

afterAll(async () => {
  // Второй клиент и всё его — удалить, чтобы тестовая БД снова была с одним клиентом.
  const orgs = (await prisma.organization.findMany({ where: { tenantId: t2 }, select: { id: true } })).map((o) => o.id);
  await prisma.document.deleteMany({ where: { tenantId: t2 } });
  await prisma.stock.deleteMany({ where: { tenantId: t2 } });
  await prisma.productBarcode.deleteMany({ where: { tenantId: t2 } });
  await prisma.product.deleteMany({ where: { tenantId: t2 } });
  await prisma.counterparty.deleteMany({ where: { tenantId: t2 } });
  await prisma.uom.deleteMany({ where: { tenantId: t2 } });
  await prisma.store.deleteMany({ where: { tenantId: t2 } });
  await prisma.user.deleteMany({ where: { tenantId: t2 } });
  await prisma.organization.deleteMany({ where: { id: { in: orgs } } });
  await prisma.tenant.delete({ where: { id: t2 } });
  await prisma.$disconnect();
});

describe('FP-007: каталог', () => {
  it('товар: общий — виден всем организациям клиента; личный — только своей; другого клиента — никому', async () => {
    const shared = await items.create(A, { name: `Общий ${uid()}`, uomId: uomA });
    const own = await items.create(A, { name: `Личный A ${uid()}`, uomId: uomA, organizationId: A.organizationId });
    const foreign = await items.create(B, { name: `Товар B ${uid()}`, uomId: uomB });
    expect([shared.tenantId, shared.organizationId, own.organizationId, foreign.tenantId]).toEqual([DEFAULT_TENANT, null, A.organizationId, t2]);

    const idsFor = async (s: Scope) => (await items.findAll(s, { limit: 500 })).items.map((i) => i.id);
    expect(await idsFor(A)).toEqual(expect.arrayContaining([shared.id, own.id]));
    expect(await idsFor(A2)).toContain(shared.id);
    expect(await idsFor(A2)).not.toContain(own.id);
    expect(await idsFor(B)).not.toContain(shared.id);
    expect(await idsFor(A)).not.toContain(foreign.id);

    expect(await code(items.findOne(A2, own.id))).toBe(404);
    expect(await code(items.findOne(B, shared.id))).toBe(404);
    expect(await code(items.update(B, shared.id, { name: 'захват' }))).toBe(404);
    expect(await code(items.archive(B, shared.id))).toBe(404);
    expect((await items.findUnits(B)).map((u) => u.id)).not.toContain(uomA);
  });

  it('товар: клиент, организация и id из тела запроса не принимаются; единица другого клиента — 400', async () => {
    const forcedId = randomUUID();
    const p = await items.create(A, { id: forcedId, tenantId: t2, name: `Подмена ${uid()}`, uomId: uomA });
    expect([p.id === forcedId, p.tenantId]).toEqual([false, DEFAULT_TENANT]);
    expect(await code(items.create(A, { name: 'в чужую организацию', uomId: uomA, organizationId: B.organizationId }))).toBe(403);
    expect(await code(items.update(A, p.id, { tenantId: t2 }))).toBe('OK');
    expect((await prisma.product.findUniqueOrThrow({ where: { id: p.id } })).tenantId).toBe(DEFAULT_TENANT);
    expect(await code(items.create(A, { name: 'чужая единица', uomId: uomB }))).toBe(400);
  });

  it('контрагенты — по тем же правилам', async () => {
    const shared = await cps.create(A, { name: `Покупатель ${uid()}` });
    const own = await cps.create(A2, { name: `Свой A2 ${uid()}`, organizationId: A2.organizationId });
    expect((await cps.findAll(A, { limit: 500 })).counterparties.map((c) => c.id)).toContain(shared.id);
    expect(await code(cps.findOne(A, own.id))).toBe(404);
    expect(await code(cps.findOne(B, shared.id))).toBe(404);
    expect(await code(cps.update(B, shared.id, { name: 'захват' }))).toBe(404);
    expect(await code(cps.create(B, { name: 'чужая организация', organizationId: A.organizationId }))).toBe(403);
  });

  it('склады и остатки — только своей организации', async () => {
    const sA = await stores.create(A, { name: `Склад A ${uid()}`, organizationId: undefined, tenantId: t2 });
    expect([sA.organizationId, sA.tenantId]).toEqual([A.organizationId, DEFAULT_TENANT]);
    expect((await stores.findAll(A2)).map((x) => x.id)).not.toContain(sA.id);
    expect(await code(stores.findOne(A2, sA.id))).toBe(404);
    expect(await code(stores.getStocks(B, sA.id, {}))).toBe(404);
    expect(await code(stores.update(A2, sA.id, { name: 'захват' }))).toBe(404);

    const p = await items.create(A, { name: `Товар со склада ${uid()}`, uomId: uomA });
    const sA2 = await stores.create(A2, { name: `Склад A2 ${uid()}` });
    await prisma.stock.createMany({ data: [{ productId: p.id, storeId: sA.id, qty: 3 }, { productId: p.id, storeId: sA2.id, qty: 4 }] });
    expect((await items.getStock(A, p.id)).map((x) => x.storeId)).toEqual([sA.id]);
  });
});

describe('FP-007: пользователи', () => {
  it('пользователь другой организации или клиента не читается и не меняется; поля области и хэш не задаются', async () => {
    const victim = await prisma.user.findFirstOrThrow({ where: { id: B.userId } });
    expect(await code(users.findOne(A, B.userId))).toBe(404);
    expect(await code(users.update(A, B.userId, { password: 'новый-пароль' }))).toBe(404);
    expect(await code(users.deactivate(A, B.userId))).toBe(404);
    expect(await code(users.findOne(A2, A.userId))).toBe(404);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: B.userId } })).passwordHash).toBe(victim.passwordHash);

    const u = await users.create(A, { email: `new-${uid()}@scope.local`, password: 'пароль-123', firstName: 'Н', lastName: 'Н', tenantId: t2, organizationId: undefined, passwordHash: 'подмена', id: 'x' });
    const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect([row.tenantId, row.organizationId, row.passwordHash === 'подмена', row.id === 'x']).toEqual([DEFAULT_TENANT, A.organizationId, false, false]);
    expect((await users.findAll(A)).map((x) => x.id)).toContain(u.id);
    expect((await users.findAll(A2)).map((x) => x.id)).not.toContain(u.id);
    await users.update(A, u.id, { organizationId: A2.organizationId, tenantId: t2 } as any).catch(() => undefined);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect([after.tenantId, after.organizationId]).toEqual([DEFAULT_TENANT, A.organizationId]);
  });
});

describe('FP-007: аналитика', () => {
  it('сводка считает документы, остатки и смены только своей организации', async () => {
    const day = new Date();
    const storeB = await stores.create(B, { name: `Склад B ${uid()}` });
    const productB = await items.create(B, { name: `Товар B ${uid()}`, uomId: uomB });
    await prisma.document.create({ data: { docType: 'DEMAND', date: day, status: 'POSTED', total: 1_000_000, organizationId: B.organizationId, storeId: storeB.id } });
    await prisma.stock.create({ data: { productId: productB.id, storeId: storeB.id, qty: 1 } });
    const period = { from: new Date(day.getTime() - 86_400_000).toISOString(), to: new Date(day.getTime() + 86_400_000).toISOString() };

    const a = await analytics.getDashboard(A, period);
    const b = await analytics.getDashboard(B, period);
    expect(b.kpi.totalSalesAmount).toBe(1_000_000);
    expect(b.kpi.lowStockCount).toBe(1);
    expect(a.kpi.totalSalesAmount).toBe(0);
    expect((await analytics.getStockReport(A)).map((x) => x.storeId)).not.toContain(storeB.id);
  });
});
