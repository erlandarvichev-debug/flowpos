// FP-007 фаза 4 — приёмка «Два клиента и две организации не видят/не связывают чужие объекты» через HTTP:
// настоящий AppModule (JWT, OrgGuard, контроллеры, пайпы), вход по паролю, запросы как у фронта.
// Клиент T1 (по умолчанию): организации A1, A2. Клиент T2: организации B1, B2. Второй клиент удаляется в afterAll.
import { randomUUID } from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { DEFAULT_TENANT, defaultTenant } from './accounting-helpers';

const uid = () => randomUUID().slice(0, 8);
const PASSWORD = 'пароль-e2e-123';

let app: INestApplication;
let prisma: PrismaService;
let base: string;
let t2: string;

type Who = { tenantId: string; orgId: string; userId: string; email: string; token: string };
let A1: Who, A2: Who, B1: Who, B2: Who;

async function http(who: Who | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(who ? { authorization: `Bearer ${who.token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = text;
  try { json = JSON.parse(text); } catch { /* текст */ }
  return { status: res.status, body: json, text };
}

async function login(email: string, password = PASSWORD) {
  return http(null, 'POST', '/auth/login', { email, password });
}

/** Организация с владельцем (членство для бухгалтерии) и учётной политикой; вход — по паролю через API. */
async function orgWithOwner(tenantId: string, name: string): Promise<Who> {
  const org = await prisma.organization.create({ data: { tenantId, name: `${name} ${uid()}` } });
  const chart = await prisma.accChart.findFirstOrThrow({ where: { code: 'KZ-TYPICAL' } });
  await prisma.accPolicy.create({ data: { organizationId: org.id, validFrom: new Date('2020-01-01'), chartId: chart.id } });
  const email = `${name.toLowerCase()}-${uid()}@example.com`;
  const user = await prisma.user.create({
    data: { tenantId, organizationId: org.id, email, passwordHash: await bcrypt.hash(PASSWORD, 4), firstName: name, lastName: 'E2E' },
  });
  await prisma.orgMembership.create({ data: { userId: user.id, organizationId: org.id, role: 'owner' } });
  const res = await login(email);
  expect(res.status).toBe(201);
  return { tenantId, orgId: org.id, userId: user.id, email, token: res.body.accessToken };
}

const ids = (list: any[]) => list.map((x) => x.id);

beforeAll(async () => {
  // Как main.ts: NestFactory из @nestjs/core приложения (в корне монорепы лежит другая мажорная версия Nest).
  app = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }));
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
  prisma = app.get(PrismaService);
  await defaultTenant(prisma);
  t2 = (await prisma.tenant.create({ data: { name: `Клиент 2 ${uid()}` } })).id;
  A1 = await orgWithOwner(DEFAULT_TENANT, 'A1');
  A2 = await orgWithOwner(DEFAULT_TENANT, 'A2');
  B1 = await orgWithOwner(t2, 'B1');
  B2 = await orgWithOwner(t2, 'B2');
}, 60_000);

afterAll(async () => {
  if (prisma && t2) {
    const orgs = ids(await prisma.organization.findMany({ where: { tenantId: t2 }, select: { id: true } }));
    const docs = ids(await prisma.document.findMany({ where: { tenantId: t2 }, select: { id: true } }));
    const accDocs = ids(await prisma.accDocument.findMany({ where: { organizationId: { in: orgs } }, select: { id: true } }));
    await prisma.outbox.deleteMany({ where: { localId: { in: [...docs, ...accDocs] } } });
    await prisma.document.deleteMany({ where: { tenantId: t2 } });
    await prisma.employee.deleteMany({ where: { organizationId: { in: orgs } } });
    await prisma.onecConnection.deleteMany({ where: { organizationId: { in: orgs } } });
    await prisma.product.deleteMany({ where: { tenantId: t2 } });
    await prisma.counterparty.deleteMany({ where: { tenantId: t2 } });
    await prisma.uom.deleteMany({ where: { tenantId: t2 } });
    await prisma.store.deleteMany({ where: { tenantId: t2 } });
    await prisma.auditLog.deleteMany({ where: { organizationId: { in: orgs } } });
    await prisma.refreshToken.deleteMany({ where: { user: { tenantId: t2 } } });
    await prisma.orgMembership.deleteMany({ where: { tenantId: t2 } });
    await prisma.user.deleteMany({ where: { tenantId: t2 } });
    await prisma.accPolicy.deleteMany({ where: { organizationId: { in: orgs } } });
    await prisma.organization.deleteMany({ where: { id: { in: orgs } } });
    await prisma.tenant.delete({ where: { id: t2 } });
  }
  await app?.close();
});

describe('FP-007 приёмка через HTTP: два клиента × две организации', () => {
  it('справочник клиента виден его организациям и не виден другому клиенту; личный — только своей организации', async () => {
    const uom = await prisma.uom.create({ data: { tenantId: DEFAULT_TENANT, name: 'шт', shortName: 'шт' } });
    const shared = (await http(A1, 'POST', '/catalog/items', { name: `Общий ${uid()}`, uomId: uom.id })).body;
    const own = (await http(A1, 'POST', '/catalog/counterparties', { name: `Личный A1 ${uid()}`, organizationId: A1.orgId })).body;
    expect([shared.tenantId, own.organizationId]).toEqual([DEFAULT_TENANT, A1.orgId]);

    expect(ids((await http(A2, 'GET', '/catalog/items?limit=500')).body.items)).toContain(shared.id);
    expect(ids((await http(B1, 'GET', '/catalog/items?limit=500')).body.items)).not.toContain(shared.id);
    expect((await http(B1, 'GET', `/catalog/items/${shared.id}`)).status).toBe(404);
    expect((await http(B2, 'PUT', `/catalog/items/${shared.id}`, { name: 'захват' })).status).toBe(404);
    expect((await http(A2, 'GET', `/catalog/counterparties/${own.id}`)).status).toBe(404);
    expect((await http(B1, 'POST', '/catalog/counterparties', { name: 'в чужую', organizationId: A1.orgId })).status).toBe(403);
  });

  it('документ не ссылается на справочник другого клиента и склад другой организации', async () => {
    const uomB = await prisma.uom.create({ data: { tenantId: t2, name: 'шт', shortName: 'шт' } });
    const productB1 = (await http(B1, 'POST', '/catalog/items', { name: `Товар B ${uid()}`, uomId: uomB.id })).body;
    const storeA1 = (await http(A1, 'POST', '/catalog/warehouses', { name: `Склад A1 ${uid()}` })).body;
    const storeA2 = (await http(A2, 'POST', '/catalog/warehouses', { name: `Склад A2 ${uid()}` })).body;

    const foreignProduct = await http(A1, 'POST', '/trade/sales-orders', { date: '2026-10-30', storeId: storeA1.id, items: [{ productId: productB1.id, qty: 1, price: 1 }] });
    expect([foreignProduct.status, foreignProduct.body.code]).toEqual([400, 'REF_FOREIGN']);
    const foreignStore = await http(A1, 'POST', '/trade/sales-orders', { date: '2026-10-30', storeId: storeA2.id, items: [] });
    expect([foreignStore.status, foreignStore.body.code]).toEqual([400, 'REF_FOREIGN']);
    expect(ids(await http(A2, 'GET', '/catalog/warehouses').then((r) => r.body))).not.toContain(storeA1.id);
  });

  it('пользователь другого клиента не читается и не меняется; пароль жертвы прежний', async () => {
    expect((await http(B1, 'GET', `/users/${A1.userId}`)).status).toBe(404);
    expect((await http(B1, 'PUT', `/users/${A1.userId}`, { password: 'чужой-пароль-1' })).status).toBe(404);
    expect((await http(A2, 'DELETE', `/users/${A1.userId}`)).status).toBe(404);
    expect(ids((await http(B1, 'GET', '/users')).body)).toEqual([B1.userId]);
    expect((await login(A1.email)).status).toBe(201);
    expect((await login(A1.email, 'чужой-пароль-1')).status).toBe(401);
  });

  it('кадры и обмен с 1С — только своей организации, пароль подключения не отдаётся', async () => {
    const emp = (await http(A1, 'POST', '/hr/employees', { firstName: 'Сотрудник', lastName: `A1-${uid()}` })).body;
    expect(emp.organizationId).toBe(A1.orgId);
    expect(ids((await http(A2, 'GET', '/hr/employees?limit=500')).body.employees)).not.toContain(emp.id);
    expect(ids((await http(B1, 'GET', '/hr/employees?limit=500')).body.employees)).not.toContain(emp.id);
    expect((await http(B1, 'GET', `/hr/employees/${emp.id}`)).status).toBe(404);

    const conn = await prisma.onecConnection.create({ data: { organizationId: A1.orgId, name: 'A1', baseCode: `b-${uid()}`, baseUrl: 'http://1c.invalid', username: 'u', passwordEnc: 'секрет-1с' } });
    const mine = await http(A1, 'GET', '/sync/instances');
    expect(ids(mine.body)).toContain(conn.id);
    expect(mine.text).not.toContain('секрет-1с');
    expect(ids((await http(B1, 'GET', '/sync/instances')).body)).not.toContain(conn.id);
    expect((await http(B1, 'POST', `/sync/instances/${conn.id}/sync`)).status).toBe(404);
  });

  it('бухгалтерия: чужая организация в заголовке — 403; организация своего клиента — только по членству', async () => {
    const own = await http(A1, 'GET', '/accounting/documents');
    expect(own.status).toBe(200);
    expect((await http(B1, 'GET', '/accounting/documents', undefined, { 'x-organization-id': A1.orgId })).status).toBe(403);
    expect((await http(A1, 'GET', '/accounting/documents', undefined, { 'x-organization-id': A2.orgId })).status).toBe(403);
    // Членство в организации другого клиента запрещено самой БД.
    await expect(prisma.orgMembership.create({ data: { userId: A1.userId, organizationId: B1.orgId, role: 'owner' } })).rejects.toThrow(/Foreign key/);
    // В организации своего клиента — можно; документ A1 там не виден.
    await prisma.orgMembership.create({ data: { userId: A1.userId, organizationId: A2.orgId, role: 'accountant' } });
    const doc = await http(A1, 'POST', '/accounting/documents', { docType: 'OPENING_BALANCE', date: '2026-01-01', body: { lines: [] } }, { 'idempotency-key': uid() });
    expect(doc.status).toBe(201);
    const inA2 = await http(A1, 'GET', '/accounting/documents', undefined, { 'x-organization-id': A2.orgId });
    expect(inA2.status).toBe(200);
    expect(ids(inA2.body.items)).not.toContain(doc.body.id);
    expect((await http(A1, 'GET', `/accounting/documents/${doc.body.id}`, undefined, { 'x-organization-id': A2.orgId })).status).toBe(404);
  });

  it('токен с подменённым клиентом/организацией не расширяет доступ; отключённый пользователь — 401', async () => {
    const forged = app.get(JwtService).sign({ sub: B2.userId, email: B2.email, tenantId: DEFAULT_TENANT, organizationId: A1.orgId, roles: ['admin'] });
    const asForged = { ...B2, token: forged };
    const users = await http(asForged, 'GET', '/users');
    expect(ids(users.body)).toEqual([B2.userId]);
    expect((await http(asForged, 'GET', '/accounting/documents', undefined, { 'x-organization-id': A1.orgId })).status).toBe(403);

    await prisma.user.update({ where: { id: B2.userId }, data: { isActive: false } });
    expect((await http(B2, 'GET', '/catalog/items')).status).toBe(401);
  });

  it('без токена — 401', async () => {
    expect((await http(null, 'GET', '/catalog/items')).status).toBe(401);
    expect((await http(null, 'GET', '/accounting/documents')).status).toBe(401);
  });
});
