// Регистрация компании на сайте и ИИ-помощник компании (коннектор MCP) через HTTP под рабочей ролью (RLS действует).
import { call, login, makeUser, startApp, uid, HttpApp } from './http-app';
import { DEFAULT_TENANT, defaultTenant } from './accounting-helpers';

let h: HttpApp;
const orgs: string[] = [];
const users: string[] = [];
const tenants: string[] = [];
type Who = { orgId: string; userId: string; token: string };
let A: Who, CASHIER: Who;

const web = (w: Who, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) =>
  call(h, method, path, { token: w.token, body, headers: { 'x-organization-id': w.orgId, ...extra } });

beforeAll(async () => {
  h = await startApp();
  await defaultTenant(h.prisma);
  const org = (await h.prisma.organization.create({ data: { tenantId: DEFAULT_TENANT, name: `AiA ${uid()}` } })).id;
  orgs.push(org);
  const u = await makeUser(h, DEFAULT_TENANT, org, { role: 'owner', name: 'AiOwner' });
  const c = await makeUser(h, DEFAULT_TENANT, org, { role: 'cashier', name: 'AiCashier' });
  users.push(u.id, c.id);
  A = { orgId: org, userId: u.id, token: (await login(h, u.email)).token };
  CASHIER = { orgId: org, userId: c.id, token: (await login(h, c.email)).token };
}, 60_000);

afterAll(async () => {
  const p = h?.prisma;
  if (p) {
    const where = { organizationId: { in: orgs } };
    await p.aiConnection.deleteMany({ where });
    await p.aiConnector.deleteMany({ where });
    await p.accPolicy.deleteMany({ where });
    await p.auditLog.deleteMany({ where: { OR: [{ organizationId: { in: orgs } }, { userId: { in: users } }] } });
    await p.authSession.deleteMany({ where: { userId: { in: users } } });
    await p.refreshToken.deleteMany({ where: { userId: { in: users } } });
    await p.userRole.deleteMany({ where: { userId: { in: users } } });
    await p.orgMembership.deleteMany({ where: { userId: { in: users } } });
    await p.user.deleteMany({ where: { id: { in: users } } });
    await p.organization.deleteMany({ where: { id: { in: orgs } } });
    await p.tenant.deleteMany({ where: { id: { in: tenants } } });
  }
  await h?.app.close();
});

describe('регистрация компании', () => {
  let B: Who;
  const bin = `77${Date.now().toString().slice(-10)}`;
  const email = `signup-${uid()}@example.com`;

  it('неверная анкета — понятный отказ', async () => {
    expect((await call(h, 'POST', '/auth/register', { body: { company: 'ТОО', bin: '123', firstName: 'А', lastName: 'Б', email, password: 'Passw0rd1' } })).status).toBe(400);
    const weak = await call(h, 'POST', '/auth/register', { body: { company: 'ТОО Тест', bin, firstName: 'А', lastName: 'Б', email, password: 'password' } });
    expect(weak.status).toBe(400);
    expect(weak.body.message).toMatch(/буквы и цифры/);
  });

  it('новая компания: свой клиент, владелец, учётная политика — и сразу вход', async () => {
    const r = await call(h, 'POST', '/auth/register', { body: { company: `ТОО Регистрация ${uid()}`, bin, firstName: 'Айгерим', lastName: 'Тестова', email, password: 'Passw0rd-1' } });
    expect(r.status).toBe(201);
    expect(r.body.accessToken).toBeTruthy();
    const org = await h.prisma.organization.findUniqueOrThrow({ where: { id: r.body.user.organizationId } });
    orgs.push(org.id);
    tenants.push(org.tenantId);
    users.push(r.body.user.id);
    expect(org.tenantId).not.toBe(DEFAULT_TENANT);
    expect(await h.prisma.orgMembership.findFirst({ where: { organizationId: org.id, role: 'owner' } })).toBeTruthy();
    expect(await h.prisma.accPolicy.count({ where: { organizationId: org.id } })).toBe(1);
    B = { orgId: org.id, userId: r.body.user.id, token: r.body.accessToken };
    const ctx = await web(B, 'GET', '/accounting/context');
    expect(ctx.status).toBe(200);
    expect(ctx.body.role).toBe('owner');
    // Учёт и бухгалтерия включены, «Супервайзер» — нет
    const subs = (await web(B, 'GET', '/subscriptions/mine')).body;
    expect(subs.trade.enabled && subs.accounting.enabled && !subs.supervisor.enabled).toBe(true);
  });

  it('тот же e-mail или БИН второй раз — отказ; ловушка для ботов ничего не создаёт', async () => {
    expect((await call(h, 'POST', '/auth/register', { body: { company: 'Дубль', bin: `78${Date.now().toString().slice(-10)}`, firstName: 'А', lastName: 'Б', email, password: 'Passw0rd-1' } })).status).toBe(409);
    expect((await call(h, 'POST', '/auth/register', { body: { company: 'Дубль', bin, firstName: 'А', lastName: 'Б', email: `d-${uid()}@example.com`, password: 'Passw0rd-1' } })).status).toBe(409);
    const botEmail = `bot-${uid()}@example.com`;
    await call(h, 'POST', '/auth/register', { body: { company: 'Бот', bin: '111111111111', firstName: 'А', lastName: 'Б', email: botEmail, password: 'Passw0rd-1', website: 'spam' } });
    expect(await h.prisma.user.findUnique({ where: { email: botEmail } })).toBeNull();
  });

  it('ИИ-помощник: свой адрес у каждой компании, чужие подключения не видны', async () => {
    const ca = (await web(A, 'GET', '/ai/connector')).body;
    const cb = (await web(B, 'GET', '/ai/connector')).body;
    expect(ca.code).toMatch(/^[a-z2-9]{12}$/);
    expect(cb.code).not.toBe(ca.code);
    expect((await call(h, 'GET', `/ai/connector-by-code/${ca.code}`)).body.organizationId).toBe(A.orgId);
    expect((await call(h, 'GET', '/ai/connector-by-code/zzzzzzzzzzzz')).status).toBe(404);

    const connId = `grant-${uid()}`.replace(/[^A-Za-z0-9_-]/g, '');
    expect((await web(A, 'POST', '/ai/connections', { id: connId, clientName: 'Claude' })).status).toBe(201);
    // Подключение компании A с заголовком X-AI-Connection работает только в A
    expect((await web(A, 'GET', '/accounting/context', undefined, { 'x-ai-connection': connId })).status).toBe(200);
    expect((await call(h, 'GET', '/accounting/context', { token: A.token, headers: { 'x-organization-id': B.orgId, 'x-ai-connection': connId } })).status).toBe(403);
    // Компания B не видит подключений A и не может их отключить
    expect((await web(B, 'GET', '/ai/connections')).body).toEqual([]);
    expect((await web(B, 'DELETE', `/ai/connections/${connId}`)).status).toBe(404);
    // Кассир не меняет настройки помощника и не отключает чужое подключение
    expect((await web(CASHIER, 'PUT', '/ai/connector', { enabled: false })).status).toBe(403);
    expect((await web(CASHIER, 'DELETE', `/ai/connections/${connId}`)).status).toBe(403);
  });

  it('выключение помощника и отзыв подключения закрывают доступ сразу; смена адреса отключает всех', async () => {
    const connId = (await web(A, 'GET', '/ai/connections')).body[0].id;
    await web(A, 'PUT', '/ai/connector', { enabled: false });
    expect((await web(A, 'GET', '/accounting/context', undefined, { 'x-ai-connection': connId })).status).toBe(403);
    await web(A, 'PUT', '/ai/connector', { enabled: true });
    expect((await web(A, 'GET', '/accounting/context', undefined, { 'x-ai-connection': connId })).status).toBe(200);
    const before = (await web(A, 'GET', '/ai/connector')).body.code;
    const after = (await web(A, 'POST', '/ai/connector/rotate')).body.code;
    expect(after).not.toBe(before);
    expect((await call(h, 'GET', `/ai/connector-by-code/${before}`)).status).toBe(404);
    const r = await web(A, 'GET', '/accounting/context', undefined, { 'x-ai-connection': connId });
    expect(r.status).toBe(403);
    expect(r.body.message).toMatch(/отключено/);
  });
});
