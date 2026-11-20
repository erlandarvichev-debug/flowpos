// Платформа (подписки, администратор платформы) и «Супервайзер» через HTTP под рабочей ролью (RLS действует).
// Два клиента: A (T1) и B (T2). Телефон представителя входит токеном, выданным по коду из 6 цифр.
import { randomUUID } from 'crypto';
import { call, login, makeUser, startApp, uid, HttpApp } from './http-app';
import { DEFAULT_TENANT, defaultTenant } from './accounting-helpers';

let h: HttpApp;
let t2: string;
const orgs: string[] = [];
const users: string[] = [];
type Who = { orgId: string; userId: string; token: string };
let A: Who, B: Who, SUP: Who;

// Точки в Алматы: P1 — проспект Абая, P2 — в ~1,5 км.
const P1 = { lat: 43.238, lng: 76.889 };
const P2 = { lat: 43.25, lng: 76.9 };
const today = new Date(Date.now() + 5 * 3600 * 1000).toISOString().slice(0, 10);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7), Buffer.from([0xff, 0xd9])]);

async function who(tenantId: string, name: string, role: string, orgId?: string): Promise<Who> {
  const org = orgId ?? (await h.prisma.organization.create({ data: { tenantId, name: `${name} ${uid()}` } })).id;
  if (!orgId) orgs.push(org);
  const u = await makeUser(h, tenantId, org, { role, name });
  users.push(u.id);
  return { orgId: org, userId: u.id, token: (await login(h, u.email)).token };
}

const web = (w: Who, method: string, path: string, body?: unknown) => call(h, method, path, { token: w.token, body, headers: { 'x-organization-id': w.orgId } });
const agent = (token: string | undefined, method: string, path: string, body?: unknown) =>
  call(h, method, `/field/agent${path}`, { body, headers: token ? { 'x-device-token': token } : {} });

async function photo(token: string, visitUuid: string, clientUuid: string, buf: Buffer) {
  const form = new FormData();
  form.append('file', new Blob([buf], { type: 'image/jpeg' }), 'p.jpg');
  form.append('clientUuid', clientUuid);
  form.append('lat', String(P1.lat));
  form.append('lng', String(P1.lng));
  const res = await fetch(`${h.base}/api/v1/field/agent/visits/${visitUuid}/photos`, { method: 'POST', headers: { 'x-device-token': token }, body: form });
  return { status: res.status, body: await res.json().catch(() => null) };
}

beforeAll(async () => {
  process.env.FIELD_DATA_DIR = require('path').join(require('os').tmpdir(), `flowpos-field-${uid()}`);
  process.env.FIELD_CLEANUP = '0';
  h = await startApp();
  await defaultTenant(h.prisma);
  t2 = (await h.prisma.tenant.create({ data: { name: `Супервайзер B ${uid()}` } })).id;
  A = await who(DEFAULT_TENANT, 'FieldA', 'owner');
  B = await who(t2, 'FieldB', 'owner');
  SUP = await who(DEFAULT_TENANT, 'FieldSup', 'supervisor', A.orgId);
}, 60_000);

afterAll(async () => {
  const p = h?.prisma;
  if (p) {
    const where = { organizationId: { in: orgs } };
    await p.fieldTrack.deleteMany({ where });
    await p.fieldOrder.deleteMany({ where });
    await p.fieldPhoto.deleteMany({ where });
    await p.fieldVisit.deleteMany({ where });
    await p.fieldTask.deleteMany({ where });
    await p.fieldRouteStop.deleteMany({ where });
    await p.fieldRoute.deleteMany({ where });
    await p.fieldPoint.deleteMany({ where });
    await p.fieldBindCode.deleteMany({ where });
    await p.fieldDevice.deleteMany({ where });
    await p.fieldRep.deleteMany({ where });
    await p.subscriptionEvent.deleteMany({ where });
    await p.orgSubscription.deleteMany({ where });
    await p.platformAdmin.deleteMany({ where: { userId: { in: users } } });
    await p.auditLog.deleteMany({ where: { OR: [{ organizationId: { in: orgs } }, { userId: { in: users } }] } });
    await p.authSession.deleteMany({ where: { userId: { in: users } } });
    await p.refreshToken.deleteMany({ where: { userId: { in: users } } });
    await p.orgMembership.deleteMany({ where: { userId: { in: users } } });
    await p.user.deleteMany({ where: { id: { in: users } } });
    await p.organization.deleteMany({ where: { id: { in: orgs } } });
    if (t2) await p.tenant.delete({ where: { id: t2 } });
  }
  await h?.app.close();
});

describe('подписки и администратор платформы', () => {
  it('без подписки: учёт и бухгалтерия включены, «Супервайзер» — нет, его адреса закрыты', async () => {
    const mine = await web(A, 'GET', '/subscriptions/mine');
    expect(mine.status).toBe(200);
    expect(mine.body.trade.enabled).toBe(true);
    expect(mine.body.accounting.enabled).toBe(true);
    expect(mine.body.supervisor.enabled).toBe(false);
    const reps = await web(A, 'GET', '/field/reps');
    expect(reps.status).toBe(403);
    expect(JSON.stringify(reps.body)).toContain('Супервайзер');
  });

  it('раздел «Платформа» — только администратору платформы; он видит организации всех клиентов', async () => {
    expect((await web(A, 'GET', '/platform/organizations')).status).toBe(403);
    expect((await web(A, 'GET', '/subscriptions/platform-admin')).body.isPlatformAdmin).toBe(false);
    await h.prisma.platformAdmin.create({ data: { userId: A.userId } });
    expect((await web(A, 'GET', '/subscriptions/platform-admin')).body.isPlatformAdmin).toBe(true);
    const list = await web(A, 'GET', '/platform/organizations');
    expect(list.status).toBe(200);
    const ids = list.body.map((o: any) => o.id);
    expect(ids).toEqual(expect.arrayContaining([A.orgId, B.orgId]));
  });

  it('подключение «Супервайзера» с местами и журнал', async () => {
    const bad = await web(A, 'PUT', `/platform/organizations/${A.orgId}/subscriptions/supervisor`, { status: 'paid' });
    expect(bad.status).toBe(400);
    const r = await web(A, 'PUT', `/platform/organizations/${A.orgId}/subscriptions/supervisor`, { status: 'trial', seats: 1, note: 'тест' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ enabled: true, status: 'trial', seats: 1 });
    // Подписка другого клиента записана с его tenant_id (иначе RLS спрятал бы её от самой организации).
    const rb = await web(A, 'PUT', `/platform/organizations/${B.orgId}/subscriptions/supervisor`, { status: 'active' });
    expect(rb.status).toBe(200);
    expect((await web(B, 'GET', '/subscriptions/mine')).body.supervisor.enabled).toBe(true);
    const ev = await web(A, 'GET', `/platform/organizations/${A.orgId}/events`);
    expect(ev.body[0]).toMatchObject({ solution: 'supervisor', after: { status: 'trial', seats: 1 } });
  });

  it('панель управления (ad.flowpos.kz): обзор, карточка, пользователи, журнал — только администратору платформы', async () => {
    for (const path of ['/platform/overview', `/platform/organizations/${B.orgId}`, '/platform/users', '/platform/journal', '/platform/admins']) {
      expect((await web(B, 'GET', path)).status).toBe(403);
      expect((await web(A, 'GET', path)).status).toBe(200);
    }
    const ov = (await web(A, 'GET', '/platform/overview')).body;
    expect(ov.organizations).toBeGreaterThanOrEqual(2);
    expect(ov.solutions.find((s: any) => s.code === 'supervisor').enabled).toBeGreaterThanOrEqual(2);
    // Карточка чужого клиента видна целиком (системный режим), с историей подписок.
    const card = (await web(A, 'GET', `/platform/organizations/${B.orgId}`)).body;
    expect(card.id).toBe(B.orgId);
    expect(card.members.length).toBeGreaterThanOrEqual(1);
    expect(card.events[0]).toMatchObject({ solution: 'supervisor' });
    expect((await web(A, 'GET', '/platform/organizations/not-a-uuid')).status).toBe(400);
    const users = (await web(A, 'GET', '/platform/users')).body;
    expect(users.find((u: any) => u.id === A.userId)?.isPlatformAdmin).toBe(true);
    const journal = (await web(A, 'GET', '/platform/journal')).body;
    expect(journal.some((r: any) => r.action === 'SUBSCRIPTION_SET' && r.organizationId === B.orgId)).toBe(true);
  });

  it('приостановка учёта у организации видна ей самой', async () => {
    await web(A, 'PUT', `/platform/organizations/${B.orgId}/subscriptions/accounting`, { status: 'suspended' });
    const mine = await web(B, 'GET', '/subscriptions/mine');
    expect(mine.body.accounting).toMatchObject({ enabled: false, reason: 'Подписка приостановлена' });
    expect(mine.body.trade.enabled).toBe(true);
  });
});

describe('«Супервайзер»: представители, телефон, маршрут, посещения', () => {
  let repId = '';
  let token = '';
  const points: Record<string, string> = {};

  it('супервайзер заводит представителя; мест не больше, чем в подписке', async () => {
    const r = await web(SUP, 'POST', '/field/reps', { name: 'Асхат', phone: '+77010000000' });
    expect(r.status).toBe(201);
    repId = r.body.id;
    const second = await web(SUP, 'POST', '/field/reps', { name: 'Второй' });
    expect(second.status).toBe(403);
    expect(JSON.stringify(second.body)).toContain('места заняты');
  });

  it('роль «супервайзер» не видит бухгалтерию', async () => {
    expect((await web(SUP, 'GET', '/accounting/documents')).status).toBe(403);
  });

  it('привязка телефона: неверный код — отказ, верный — токен, повтор кода — отказ', async () => {
    expect((await agent(undefined, 'POST', '/bind', { code: '000000' })).status).toBe(400);
    const c = await web(SUP, 'POST', `/field/reps/${repId}/bind-code`);
    expect(c.status).toBe(201);
    expect(c.body.code).toMatch(/^\d{6}$/);
    const b = await agent(undefined, 'POST', '/bind', { code: c.body.code, model: 'Тестовый телефон', appVersion: '0.5.0' });
    expect(b.status).toBe(201);
    token = b.body.token;
    expect(b.body.rep.name).toBe('Асхат');
    expect((await agent(undefined, 'POST', '/bind', { code: c.body.code })).status).toBe(400);
    expect((await agent(token, 'GET', '/me')).body.rep.id).toBe(repId);
    expect((await agent('fdt_not-a-real-token', 'GET', '/me')).status).toBe(401);
  });

  it('клиенты из МойСклад становятся точками; другой клиент платформы их не видит', async () => {
    const s = await agent(token, 'POST', '/points/sync', { points: [{ moyskladId: 'ms-1', name: 'Магазин 1', address: 'Абая 1' }, { moyskladId: 'ms-2', name: 'Магазин 2' }] });
    expect(s.status).toBe(201);
    Object.assign(points, s.body.points);
    expect(Object.keys(points)).toEqual(['ms-1', 'ms-2']);
    expect((await web(SUP, 'GET', '/field/points')).body).toHaveLength(2);
    expect((await web(B, 'GET', '/field/points')).body).toHaveLength(0);
    expect((await web(B, 'PUT', `/field/points/${points['ms-1']}`, { name: 'взлом' })).status).toBe(404);
  });

  it('место точки: супервайзер ставит на карте; представитель — только если места нет', async () => {
    expect((await web(SUP, 'PUT', `/field/points/${points['ms-1']}`, P1)).status).toBe(200);
    const again = await agent(token, 'POST', `/points/${points['ms-1']}/location`, { ...P2, accuracy: 10 });
    expect(again.status).toBe(400);
    expect((await agent(token, 'POST', `/points/${points['ms-2']}/location`, { ...P2, accuracy: 300 })).status).toBe(400);
    expect((await agent(token, 'POST', `/points/${points['ms-2']}/location`, { ...P2, accuracy: 20 })).status).toBe(201);
  });

  it('маршрут на сегодня и задание видны в телефоне', async () => {
    const r = await web(SUP, 'PUT', '/field/routes', { repId, date: today, pointIds: [points['ms-1'], points['ms-2']], note: 'с утра' });
    expect(r.status).toBe(200);
    expect(r.body.stops.map((s: any) => s.point.id)).toEqual([points['ms-1'], points['ms-2']]);
    const t = await web(SUP, 'POST', '/field/tasks', { repId, pointId: points['ms-1'], title: 'Фото выкладки' });
    expect(t.status).toBe(201);
    const day = await agent(token, 'GET', '/today');
    expect(day.body.stops).toHaveLength(2);
    expect(day.body.tasks.map((x: any) => x.title)).toEqual(['Фото выкладки']);
    // Чужая точка в маршруте не принимается.
    const foreign = await h.prisma.fieldPoint.create({ data: { tenantId: t2, organizationId: B.orgId, name: 'чужая' } });
    expect((await web(SUP, 'PUT', '/field/routes', { repId, date: today, pointIds: [foreign.id] })).status).toBe(400);
  });

  it('посещение: рядом — «на точке», далеко — «удалённо», повтор не создаёт дубль, задание закрывается', async () => {
    const now = new Date().toISOString();
    const task = (await agent(token, 'GET', '/today')).body.tasks[0];
    const v1 = randomUUID();
    const near = await agent(token, 'POST', '/visits', { clientUuid: v1, pointId: points['ms-1'], startedAt: now, lat: 43.2382, lng: 76.889, accuracy: 12, tasks: [{ id: task.id, result: 'сделал' }] });
    expect(near.status).toBe(201);
    expect(near.body.placement).toBe('on_site');
    const again = await agent(token, 'POST', '/visits', { clientUuid: v1, finishedAt: now, comment: 'всё ок' });
    expect(again.body.id).toBe(near.body.id);
    const far = await agent(token, 'POST', '/visits', { clientUuid: randomUUID(), moyskladId: 'ms-1', startedAt: now, lat: P2.lat, lng: P2.lng, accuracy: 10 });
    expect(far.body.placement).toBe('remote');
    expect(far.body.distanceM).toBeGreaterThan(1000);
    const noFix = await agent(token, 'POST', '/visits', { clientUuid: randomUUID(), pointId: points['ms-2'], startedAt: now });
    expect(noFix.body.placement).toBe('unknown');
    const tasks = await web(SUP, 'GET', '/field/tasks?status=done');
    expect(tasks.body[0]).toMatchObject({ status: 'done', result: 'сделал', visitId: near.body.id });
    const visits = await web(SUP, 'GET', `/field/visits?date=${today}`);
    expect(visits.body).toHaveLength(3);
    expect(visits.body.find((v: any) => v.id === near.body.id).comment).toBe('всё ок');
    // Время из будущего не принимается.
    expect((await agent(token, 'POST', '/visits', { clientUuid: randomUUID(), pointId: points['ms-1'], startedAt: new Date(Date.now() + 3600e3).toISOString() })).status).toBe(400);
    (globalThis as any).fieldVisit = v1;
  });

  it('фото: принимается JPEG, повтор — без дубля, не картинка — отказ; файл видит только своя организация', async () => {
    const v1 = (globalThis as any).fieldVisit as string;
    const pid = randomUUID();
    const p = await photo(token, v1, pid, JPEG);
    expect(p.status).toBe(201);
    expect((await photo(token, v1, pid, JPEG)).body.duplicate).toBe(true);
    expect((await photo(token, v1, randomUUID(), Buffer.from('<html>не фото</html>'))).status).toBe(400);
    const own = await fetch(`${h.base}/api/v1/field/photos/${p.body.id}`, { headers: { authorization: `Bearer ${SUP.token}`, 'x-organization-id': A.orgId } });
    expect(own.status).toBe(200);
    expect(own.headers.get('content-type')).toBe('image/jpeg');
    expect(Buffer.from(await own.arrayBuffer()).equals(JPEG)).toBe(true);
    const foreign = await fetch(`${h.base}/api/v1/field/photos/${p.body.id}`, { headers: { authorization: `Bearer ${B.token}`, 'x-organization-id': B.orgId } });
    expect(foreign.status).toBe(404);
  });

  it('заказ из агента, день на карте и план/факт', async () => {
    const o = await agent(token, 'POST', '/orders', { clientUuid: randomUUID(), moyskladId: 'ord-1', number: '00042', sum: 15000.5, at: new Date().toISOString(), pointMoyskladId: 'ms-1', lat: 43.2381, lng: 76.8891, accuracy: 8 });
    expect(o.status).toBe(201);
    expect(o.body.placement).toBe('on_site');
    const day = await web(SUP, 'GET', `/field/day?repId=${repId}&date=${today}`);
    expect(day.body.visits).toHaveLength(3);
    expect(day.body.orders).toHaveLength(1);
    expect(day.body.track.length).toBeGreaterThanOrEqual(3);
    const pf = await web(SUP, 'GET', `/field/plan-fact?from=${today}&to=${today}`);
    const row = pf.body.find((x: any) => x.rep.id === repId);
    expect(row).toMatchObject({ planned: 2, visitedPlanned: 2, missed: 0, onSite: 1, remote: 1, unknown: 1, orders: 1, ordersSum: 15000.5 });
  });

  it('отвязанный телефон и приостановленная подписка закрывают доступ сразу', async () => {
    const reps = await web(SUP, 'GET', '/field/reps');
    const deviceId = reps.body.reps[0].devices[0].id;
    expect(reps.body.reps[0].devices[0].model).toBe('Тестовый телефон');
    await web(A, 'PUT', `/platform/organizations/${A.orgId}/subscriptions/supervisor`, { status: 'suspended' });
    expect((await agent(token, 'GET', '/today')).status).toBe(403);
    expect((await web(SUP, 'GET', '/field/reps')).status).toBe(403);
    await web(A, 'PUT', `/platform/organizations/${A.orgId}/subscriptions/supervisor`, { status: 'active', seats: 1 });
    expect((await agent(token, 'GET', '/today')).status).toBe(200);
    expect((await web(SUP, 'DELETE', `/field/devices/${deviceId}`)).status).toBe(200);
    expect((await agent(token, 'GET', '/today')).status).toBe(401);
  });
});
