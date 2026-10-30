// FP-008: права (grants) — роль в организации решает, что можно; роль берётся из членства в выбранной
// организации (X-Organization-Id), назначить можно только роль не шире своей. Через HTTP на настоящем приложении.
import { DEFAULT_TENANT, defaultTenant } from './accounting-helpers';
import { HttpApp, call, login, makeUser, startApp, uid } from './http-app';

let h: HttpApp;
let A1: string, A2: string;
const tokens: Record<string, string> = {};
const ids: Record<string, string> = {};

async function member(name: string, role: string, org = A1) {
  const u = await makeUser(h, DEFAULT_TENANT, org, { name, role });
  ids[name] = u.id;
  tokens[name] = (await login(h, u.email)).token;
  return u;
}
const as = (who: string, method: string, path: string, body?: unknown, org?: string) =>
  call(h, method, path, { token: tokens[who], body, headers: org ? { 'x-organization-id': org } : {} });

beforeAll(async () => {
  h = await startApp();
  await defaultTenant(h.prisma);
  const chart = await h.prisma.accChart.findFirstOrThrow({ where: { code: 'KZ-TYPICAL' } });
  for (const name of ['A1', 'A2']) {
    const o = await h.prisma.organization.create({ data: { tenantId: DEFAULT_TENANT, name: `${name} ${uid()}` } });
    await h.prisma.accPolicy.create({ data: { organizationId: o.id, validFrom: new Date('2020-01-01'), chartId: chart.id } });
    if (name === 'A1') A1 = o.id; else A2 = o.id;
  }
  for (const [name, role] of [['owner', 'owner'], ['admin', 'admin'], ['cashier', 'cashier'], ['hr', 'hr'], ['storekeeper', 'storekeeper'], ['accountant', 'accountant']] as const) {
    await member(name, role);
  }
}, 60_000);
afterAll(async () => h?.app.close());

describe('FP-008: права по ролям в старых модулях', () => {
  it.each([
    ['cashier', 'GET', '/catalog/items', 200],
    ['cashier', 'POST', '/catalog/items', 403],
    ['cashier', 'GET', '/pos/terminals', 200],
    ['cashier', 'POST', '/pos/terminals', 403],
    ['cashier', 'GET', '/users', 403],
    ['cashier', 'GET', '/sync/instances', 403],
    ['cashier', 'GET', '/hr/employees', 403],
    ['cashier', 'GET', '/analytics/dashboard', 403],
    ['hr', 'GET', '/hr/employees', 200],
    ['hr', 'GET', '/hr/payrolls', 403],
    ['hr', 'GET', '/trade/sales-orders', 403],
    ['storekeeper', 'GET', '/trade/goods-receipts', 200],
    ['storekeeper', 'POST', '/trade/pos-sale', 403],
    ['storekeeper', 'POST', '/sync/instances', 403],
    ['accountant', 'GET', '/sync/instances', 200],
    ['accountant', 'POST', '/sync/instances', 403],
    ['accountant', 'GET', '/hr/payrolls', 200],
    ['accountant', 'GET', '/users', 403],
    ['admin', 'GET', '/users', 200],
  ])('%s %s %s → %i', async (who, method, path, status) => {
    const body = method === 'POST' ? {} : undefined;
    expect((await as(who, method, path, body)).status).toBe(status);
  });

  it('глобальные роли не создаются никем, даже владельцем', async () => {
    expect((await as('owner', 'POST', '/roles', { name: `r-${uid()}`, displayName: 'x' })).status).toBe(403);
    expect((await as('owner', 'GET', '/roles')).status).toBe(200);
  });
});

describe('FP-008: нельзя выдать роль шире своей', () => {
  it('администратор не создаёт владельца и не правит/не отключает владельца; создаёт роли не шире своей', async () => {
    const mk = (role: string) => as('admin', 'POST', '/users', { email: `n-${uid()}@example.com`, password: 'пароль-123', firstName: 'Н', lastName: 'Н', role });
    expect([(await mk('owner')).status, (await mk('owner')).body.code]).toEqual([403, 'ROLE_ESCALATION']);
    const cashier = await mk('cashier');
    expect(cashier.status).toBe(201);
    expect((await h.prisma.orgMembership.findFirstOrThrow({ where: { userId: cashier.body.id } })).role).toBe('cashier');
    expect((await as('admin', 'PUT', `/users/${ids.owner}`, { firstName: 'захват' })).status).toBe(403);
    expect((await as('admin', 'DELETE', `/users/${ids.owner}`)).status).toBe(403);
    expect((await as('admin', 'PUT', `/users/${cashier.body.id}`, { role: 'owner' })).status).toBe(403);
    expect((await as('admin', 'PUT', `/users/${cashier.body.id}`, { role: 'storekeeper' })).status).toBe(200);
    expect((await h.prisma.orgMembership.findFirstOrThrow({ where: { userId: cashier.body.id } })).role).toBe('storekeeper');
  });

  it('создание пользователя без роли — 400; собственную роль не поменять', async () => {
    expect((await as('admin', 'POST', '/users', { email: `n-${uid()}@example.com`, password: 'пароль-123', firstName: 'Н', lastName: 'Н' })).body.code).toBe('ROLE_REQUIRED');
    expect((await as('admin', 'PUT', `/users/${ids.admin}`, { role: 'cashier' })).body.code).toBe('SELF_ROLE');
  });

  it('участники в бухгалтерии: администратор не назначает владельца; пользователь другого клиента — «не найден», а не 500', async () => {
    const r = await as('admin', 'POST', '/accounting/members', { email: (await h.prisma.user.findUniqueOrThrow({ where: { id: ids.cashier } })).email, role: 'owner' });
    expect([r.status, r.body.code]).toEqual([403, 'ROLE_ESCALATION']);
    const t2 = await h.prisma.tenant.create({ data: { name: `Чужой ${uid()}` } });
    try {
      const o = await h.prisma.organization.create({ data: { tenantId: t2.id, name: 'Чужая' } });
      const stranger = await h.prisma.user.create({ data: { tenantId: t2.id, organizationId: o.id, email: `s-${uid()}@example.com`, passwordHash: 'x', firstName: 'Ч', lastName: 'Ч' } });
      const res = await as('owner', 'POST', '/accounting/members', { email: stranger.email, role: 'cashier' });
      expect([res.status, res.body.code]).toEqual([422, 'USER_NOT_FOUND']);
    } finally {
      await h.prisma.user.deleteMany({ where: { tenantId: t2.id } });
      await h.prisma.organization.deleteMany({ where: { tenantId: t2.id } });
      await h.prisma.tenant.delete({ where: { id: t2.id } });
    }
  });
});

describe('FP-008: организация и права — из членства в выбранной организации', () => {
  it('кассир в A1 и руководитель в A2: права меняются с организацией; без членства — 403', async () => {
    await h.prisma.orgMembership.create({ data: { userId: ids.cashier, organizationId: A2, role: 'manager' } });
    expect((await as('cashier', 'GET', '/analytics/dashboard', undefined, A1)).status).toBe(403);
    expect((await as('cashier', 'GET', '/analytics/dashboard', undefined, A2)).status).toBe(200);
    expect((await as('hr', 'GET', '/hr/employees', undefined, A2)).status).toBe(403); // нет членства в A2

    // Отключённое членство — доступа нет, даже в своей организации.
    await h.prisma.orgMembership.updateMany({ where: { userId: ids.hr, organizationId: A1 }, data: { isActive: false } });
    expect((await as('hr', 'GET', '/hr/employees')).status).toBe(403);
  });

  it('пользователь без членства в своей организации — 403 на старых модулях (нет «прав по умолчанию»)', async () => {
    const u = await makeUser(h, DEFAULT_TENANT, A1, { name: 'Безроли' });
    const t = (await login(h, u.email)).token;
    expect((await call(h, 'GET', '/catalog/items', { token: t })).status).toBe(403);
  });
});
