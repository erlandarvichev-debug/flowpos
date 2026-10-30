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
import { OutboxService } from '../src/common/outbox/outbox.service';
import { SalesService } from '../src/modules/trade/sales.service';
import { PurchasesService } from '../src/modules/trade/purchases.service';
import { StockOpsService } from '../src/modules/trade/stock-ops.service';
import { PosService } from '../src/modules/pos/pos.service';
import { HrService } from '../src/modules/hr/hr.service';
import { PostingService } from '../src/modules/accounting/core/posting.service';
import { ctxFor } from './accounting-helpers';
import { DEFAULT_TENANT, defaultTenant } from './accounting-helpers';

const prisma = new PrismaService();
const items = new ItemsService(prisma);
const cps = new CounterpartiesService(prisma);
const stores = new WarehousesService(prisma);
const users = new UsersService(prisma);
const analytics = new AnalyticsService(prisma);
const outbox = new OutboxService(prisma);
const sales = new SalesService(prisma, outbox);
const purchases = new PurchasesService(prisma, outbox);
const stockOps = new StockOpsService(prisma);
const pos = new PosService(prisma);
const hr = new HrService(prisma);
const posting = new PostingService(prisma);
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
  try { await p; return 'OK'; } catch (e: any) { return e instanceof NotFoundException ? 404 : e instanceof ForbiddenException ? 403 : e?.response?.code ?? e?.status ?? e?.message; }
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
  const docs = (await prisma.document.findMany({ where: { tenantId: t2 }, select: { id: true } })).map((d) => d.id);
  await prisma.outbox.deleteMany({ where: { localId: { in: docs } } });
  await prisma.document.deleteMany({ where: { tenantId: t2 } });
  await prisma.pOSCashOp.deleteMany({ where: { shift: { terminal: { tenantId: t2 } } } });
  await prisma.pOSShift.deleteMany({ where: { terminal: { tenantId: t2 } } });
  await prisma.pOSTerminal.deleteMany({ where: { tenantId: t2 } });
  await prisma.stock.deleteMany({ where: { tenantId: t2 } });
  await prisma.productBarcode.deleteMany({ where: { tenantId: t2 } });
  await prisma.product.deleteMany({ where: { tenantId: t2 } });
  await prisma.counterparty.deleteMany({ where: { tenantId: t2 } });
  await prisma.uom.deleteMany({ where: { tenantId: t2 } });
  await prisma.timeSheetRow.deleteMany({ where: { organizationId: { in: orgs } } });
  await prisma.timeSheet.deleteMany({ where: { organizationId: { in: orgs } } });
  await prisma.timeEvent.deleteMany({ where: { employee: { organizationId: { in: orgs } } } });
  await prisma.payroll.deleteMany({ where: { employee: { organizationId: { in: orgs } } } });
  await prisma.shiftPlan.deleteMany({ where: { organizationId: { in: orgs } } });
  await prisma.employee.deleteMany({ where: { organizationId: { in: orgs } } });
  await prisma.position.deleteMany({ where: { organizationId: { in: orgs } } });
  await prisma.workSchedule.deleteMany({ where: { organizationId: { in: orgs } } });
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

describe('FP-007: торговля и касса', () => {
  async function setup() {
    const storeA = await stores.create(A, { name: `Склад A ${uid()}` });
    const storeA2 = await stores.create(A2, { name: `Склад A2 ${uid()}` });
    const storeB = await stores.create(B, { name: `Склад B ${uid()}` });
    const productA = await items.create(A, { name: `Товар A ${uid()}`, uomId: uomA });
    const productB = await items.create(B, { name: `Товар B ${uid()}`, uomId: uomB });
    const cpA = await cps.create(A, { name: `Покупатель A ${uid()}` });
    const cpB = await cps.create(B, { name: `Покупатель B ${uid()}` });
    return { storeA, storeA2, storeB, productA, productB, cpA, cpB };
  }
  const line = (productId: string) => [{ productId, qty: 1, price: 100 }];

  it('документ создаётся в своей организации; клиент и организация из тела игнорируются; чужие ссылки — REF_FOREIGN', async () => {
    const w = await setup();
    const order = await sales.createOrder(A, { date: '2026-10-30', counterpartyId: w.cpA.id, storeId: w.storeA.id, items: line(w.productA.id), tenantId: t2, organizationId: B.organizationId, number: 'ПОДМЕНА', total: 1 });
    expect([order.tenantId, order.organizationId, order.number === 'ПОДМЕНА', Number(order.total)]).toEqual([DEFAULT_TENANT, A.organizationId, false, 100]);

    expect(await code(sales.createOrder(A, { date: '2026-10-30', counterpartyId: w.cpB.id, items: line(w.productA.id) }))).toBe('REF_FOREIGN');
    expect(await code(sales.createShipment(A, { date: '2026-10-30', storeId: w.storeA2.id, items: line(w.productA.id) }))).toBe('REF_FOREIGN');
    expect(await code(purchases.createReceipt(A, { date: '2026-10-30', storeId: w.storeA.id, items: line(w.productB.id) }))).toBe('REF_FOREIGN');
    expect(await code(stockOps.createTransfer(A, { storeId: w.storeA.id, storeToId: w.storeB.id, items: line(w.productA.id) }))).toBe('REF_FOREIGN');
    expect(await code(sales.createPosSale(A, { storeId: w.storeA.id, items: [{ barcode: `нет-${uid()}`, qty: 1, price: 1 }] }, `k-${uid()}`))).toBe('REF_FOREIGN');
  });

  it('документы другой организации не видны и не меняются', async () => {
    const w = await setup();
    const po = await purchases.createOrder(A, { date: '2026-10-30', counterpartyId: w.cpA.id, items: line(w.productA.id) });
    expect(await code(purchases.findOrder(A2, po.id))).toBe(404);
    expect(await code(purchases.findOrder(B, po.id))).toBe(404);
    expect(await code(purchases.updateOrder(B, po.id, { comment: 'захват' }))).toBe(404);
    expect((await purchases.findOrders(B, { limit: 200 })).data.map((d) => d.id)).not.toContain(po.id);
    expect((await purchases.findOrders(A, { limit: 200 })).data.map((d) => d.id)).toContain(po.id);
    // updateOrder не переносит документ в другую организацию
    await purchases.updateOrder(A, po.id, { comment: 'ok', organizationId: B.organizationId, tenantId: t2 });
    expect((await prisma.document.findUniqueOrThrow({ where: { id: po.id } })).organizationId).toBe(A.organizationId);
  });

  it('касса: чужая касса и смена недоступны; продажи смены — только свои чеки с момента открытия', async () => {
    const w = await setup();
    const tA = await pos.createTerminal(A, { name: 'Касса A', code: `KA-${uid()}`, storeId: w.storeA.id, apiKey: 'подмена' });
    expect(tA.apiKey).not.toBe('подмена');
    expect(await code(pos.createTerminal(A, { name: 'Касса', code: `K-${uid()}`, storeId: w.storeA2.id }))).toBe('REF_FOREIGN');
    expect(await code(pos.openShift(B, tA.id, {}))).toBe(404);

    const before = new Date(Date.now() - 60_000);
    await prisma.document.create({ data: { docType: 'RETAIL_DEMAND', date: before, createdAt: before, status: 'POSTED', total: 999, organizationId: A.organizationId, storeId: w.storeA.id } });
    const shift = await pos.openShift(A, tA.id, {});
    await pos.createReceipt(A, { storeId: w.storeA.id, status: 'POSTED', items: line(w.productA.id) });
    await prisma.document.create({ data: { docType: 'RETAIL_DEMAND', date: new Date(), status: 'POSTED', total: 5000, organizationId: B.organizationId, storeId: w.storeB.id } });
    expect(await code(pos.closeShift(B, shift.id))).toBe(404);
    expect(await code(pos.cashIn(A2, shift.id, 10))).toBe(404);
    const closed = await pos.closeShift(A, shift.id);
    expect(Number(closed.totalSales)).toBe(100);
  });
});

describe('FP-007: кадры старого модуля', () => {
  it('сотрудники, отметки и начисления — только своей организации', async () => {
    const eA = await hr.createEmployee(A, { firstName: 'Айгерим', lastName: `A-${uid()}`, organizationId: undefined, tenantId: t2 });
    const eB = await hr.createEmployee(B, { firstName: 'Бауыржан', lastName: `B-${uid()}` });
    expect([eA.organizationId, eB.organizationId]).toEqual([A.organizationId, B.organizationId]);
    expect(await code(hr.createEmployee(A, { firstName: 'х', lastName: 'х', organizationId: B.organizationId }))).toBe(403);

    expect((await hr.findEmployees(A, { limit: 500 })).employees.map((e) => e.id)).not.toContain(eB.id);
    expect((await hr.findEmployees(A2, { limit: 500 })).employees.map((e) => e.id)).not.toContain(eA.id);
    expect(await code(hr.findEmployee(B, eA.id))).toBe(404);
    expect(await code(hr.updateEmployee(B, eA.id, { lastName: 'захват' }))).toBe(404);
    expect(await code(hr.checkIn(B, eA.id))).toBe(404);
    expect(await code(hr.getTimeRecords(A2, eA.id))).toBe(404);
    expect(await code(hr.createPayroll(B, { employeeId: eA.id, month: 10, year: 2026, baseSalary: 1, netAmount: 1 }))).toBe(404);
    // Привязать сотрудника к пользователю другой организации нельзя
    expect(await code(hr.updateEmployee(A, eA.id, { userId: B.userId }))).toBe('REF_FOREIGN');
  });

  it('табель — свой у каждой организации за тот же месяц; расчёт берёт только своих сотрудников', async () => {
    const eA = await hr.createEmployee(A, { firstName: 'Т', lastName: `A-${uid()}` });
    const eB = await hr.createEmployee(B, { firstName: 'Т', lastName: `B-${uid()}` });
    await hr.checkIn(A, eA.id);
    await hr.checkIn(B, eB.id);
    const now = new Date();
    const tsA = await hr.calculateTimesheet(A, now.getMonth() + 1, now.getFullYear());
    const tsB = await hr.calculateTimesheet(B, now.getMonth() + 1, now.getFullYear());
    expect(tsA.id).not.toBe(tsB.id);
    expect(tsA.rows.map((r) => r.employeeId)).toContain(eA.id);
    expect(tsA.rows.map((r) => r.employeeId)).not.toContain(eB.id);
    expect(tsB.rows.map((r) => r.employeeId)).toContain(eB.id);
    expect(tsB.rows.map((r) => r.employeeId)).not.toContain(eA.id);
    const orgsOfB = await prisma.employee.findMany({ where: { id: { in: tsB.rows.map((r) => r.employeeId) } }, select: { organizationId: true } });
    expect([...new Set(orgsOfB.map((e) => e.organizationId))]).toEqual([B.organizationId]);
  });

  it('графики работы и смены — своей организации; склад другой организации в смене — 400', async () => {
    const wsA = await hr.createShiftTemplate(A, { name: `График ${uid()}`, startTime: '09:00', endTime: '18:00', duration: 8 });
    expect((await hr.findShiftTemplates(A2)).map((w) => w.id)).not.toContain(wsA.id);
    const storeA = await stores.create(A, { name: `Склад ${uid()}` });
    const storeA2 = await stores.create(A2, { name: `Склад ${uid()}` });
    await hr.assignShift(A, { storeId: storeA.id, date: new Date(), shift: 'день', workScheduleId: wsA.id });
    expect(await code(hr.assignShift(A, { storeId: storeA2.id, date: new Date(), shift: 'день' }))).toBe(400);
    expect(await code(hr.assignShift(A2, { storeId: storeA2.id, date: new Date(), shift: 'день', workScheduleId: wsA.id }))).toBe(400);
  });

  it('аналитика «сотрудник» в проводке — только своей организации', async () => {
    const eA = await hr.createEmployee(A, { firstName: 'П', lastName: `A-${uid()}` });
    const eA2 = await hr.createEmployee(A2, { firstName: 'П', lastName: `A2-${uid()}` });
    const chart = await prisma.accChart.findFirstOrThrow({ where: { code: 'KZ-TYPICAL' } });
    const acc = await prisma.accAccount.findFirstOrThrow({ where: { organizationId: null, isGroup: false, dims: { has: 'EMPLOYEE' }, requiredDims: { isEmpty: true } } });
    const write = (employeeId: string) => prisma.$transaction(async (tx) => {
      await tx.accPolicy.upsert({ where: { id: `p-${A.organizationId}` }, create: { id: `p-${A.organizationId}`, organizationId: A.organizationId, validFrom: new Date('2020-01-01'), chartId: chart.id }, update: {} });
      return posting.writeEntry(tx, ctxFor(A.organizationId, A.userId, 'chief_accountant'), {
        sourceType: 'TEST', sourceId: uid(), sourceVersion: 1, ruleCode: 'T', ruleVersion: '1', date: new Date('2026-10-15'),
        postings: [{ account: acc.code, side: 'D', amount: '10', dims: { EMPLOYEE: employeeId } }, { account: '5030', side: 'C', amount: '10' }],
      });
    });
    expect(await code(write(eA2.id))).toBe('REF_FOREIGN');
    expect(await code(write(eA.id))).toBe('OK');
  });
});

