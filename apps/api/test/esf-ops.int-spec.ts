// FP-022 через HTTP под рабочей ролью (RLS): код трассировки запроса → ответ и журнал; состояние обмена ЭСФ
// своей организации; оповещения другого клиента не видны; метрики Prometheus — только по токену и без имён/БИН.
import { INestApplication } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../src/prisma/prisma.service';
import { PASSWORD, call, login, makeUser, startApp, uid, HttpApp } from './http-app';
import { DEFAULT_TENANT, defaultTenant } from './accounting-helpers';

let h: HttpApp;
let app: INestApplication;
let prisma: PrismaService;
let t2: string;
type Who = { orgId: string; token: string };
let A: Who, B: Who;

async function orgWithOwner(tenantId: string, name: string): Promise<Who> {
  const org = await prisma.organization.create({ data: { tenantId, name: `${name} ${uid()}`, inn: '990011223344' } });
  const chart = await prisma.accChart.findFirstOrThrow({ where: { code: 'KZ-TYPICAL' } });
  await prisma.accPolicy.create({ data: { organizationId: org.id, validFrom: new Date('2020-01-01'), chartId: chart.id } });
  const email = `${name.toLowerCase()}-${uid()}@example.com`;
  const user = await prisma.user.create({ data: { tenantId, organizationId: org.id, email, passwordHash: await bcrypt.hash(PASSWORD, 4), firstName: name, lastName: 'Ops' } });
  await prisma.orgMembership.create({ data: { userId: user.id, organizationId: org.id, role: 'owner' } });
  await prisma.esfSettings.create({ data: { organizationId: org.id } });
  const res = await call(h, 'POST', '/auth/login', { body: { email, password: PASSWORD } });
  expect(res.status).toBe(201);
  return { orgId: org.id, token: res.body.accessToken };
}

beforeAll(async () => {
  h = await startApp();
  app = h.app;
  prisma = h.prisma;
  await defaultTenant(prisma);
  t2 = (await prisma.tenant.create({ data: { name: `Клиент ops ${uid()}` } })).id;
  A = await orgWithOwner(DEFAULT_TENANT, 'OpsA');
  B = await orgWithOwner(t2, 'OpsB');
}, 60_000);

afterAll(async () => {
  if (prisma && t2) {
    const orgs = (await prisma.organization.findMany({ where: { tenantId: t2 }, select: { id: true } })).map((o) => o.id);
    await prisma.opsAlert.deleteMany({ where: { organizationId: { in: orgs } } });
    await prisma.esfInboundQuarantine.deleteMany({ where: { organizationId: { in: orgs } } });
    await prisma.esfSettings.deleteMany({ where: { organizationId: { in: orgs } } });
    await prisma.auditLog.deleteMany({ where: { organizationId: { in: orgs } } });
    await prisma.authSession.deleteMany({ where: { user: { tenantId: t2 } } });
    await prisma.refreshToken.deleteMany({ where: { user: { tenantId: t2 } } });
    await prisma.orgMembership.deleteMany({ where: { tenantId: t2 } });
    await prisma.user.deleteMany({ where: { tenantId: t2 } });
    await prisma.accPolicy.deleteMany({ where: { organizationId: { in: orgs } } });
    await prisma.organization.deleteMany({ where: { id: { in: orgs } } });
    await prisma.tenant.delete({ where: { id: t2 } });
  }
  delete process.env.OPS_METRICS_TOKEN;
  await app?.close();
});

describe('FP-022 через HTTP', () => {
  it('код трассировки: свой X-Request-Id возвращается и пишется в журнал действия; без него — новый', async () => {
    const inv = await prisma.esfInvoice.create({ data: { organizationId: A.orgId, direction: 'INBOUND', invoiceType: 'ADDITIONAL_INVOICE', num: `T${uid()}`, date: new Date(), turnoverDate: new Date(), status: 'WAITING_CUSTOMER_CONFIRMATION', esfStatus: 'WAITING_CUSTOMER_CONFIRMATION', body: '<x/>', bodyHash: 'x' } });
    const trace = `ui-${uid()}-${uid()}`;
    const res = await fetch(`${h.base}/api/v1/accounting/esf/decisions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${A.token}`, 'x-request-id': trace },
      body: JSON.stringify({ kind: 'APPROVE', ids: [inv.id], basis: 'Сверено с поставкой' }),
    });
    expect(res.status).toBe(201);
    expect(res.headers.get('x-request-id')).toBe(trace);
    const a = await prisma.auditLog.findFirst({ where: { organizationId: A.orgId, action: 'ESF_DECISION_PROPOSED' } });
    expect(a!.traceId).toBe(trace);

    const bad = await fetch(`${h.base}/api/v1/accounting/esf/health`, { headers: { authorization: `Bearer ${A.token}`, 'x-request-id': 'bad id <script>alert(1)</script>' } });
    expect(bad.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/); // небезопасный — заменён новым
  });

  it('состояние обмена — своей организации; оповещение другого клиента не видно (RLS)', async () => {
    await prisma.opsAlert.create({ data: { organizationId: B.orgId, key: 'ESF_QUARANTINE', openKey: 'ESF_QUARANTINE', severity: 'WARNING', owner: 'x', runbook: 'r', message: 'чужое' } });
    const mine = await call(h, 'GET', '/accounting/esf/health', { token: A.token });
    expect(mine.status).toBe(200);
    expect(mine.body.metrics).toMatchObject({ organizationId: A.orgId, sessionOpen: false, unknownCount: 0 });
    expect(mine.body.alerts).toEqual([]);
    // Подмена организации заголовком — 403, а не чужие данные.
    const forged = await call(h, 'GET', '/accounting/esf/health', { token: A.token, headers: { 'x-organization-id': B.orgId } });
    expect(forged.status).toBe(403);
    const theirs = await call(h, 'GET', '/accounting/esf/health', { token: B.token });
    expect(theirs.body.alerts.map((a: any) => a.message)).toEqual(['чужое']);
  });

  it('метрики Prometheus: нет токена в окружении — 404; без/с неверным токеном — 401; с токеном — без имён и БИН', async () => {
    delete process.env.OPS_METRICS_TOKEN;
    expect((await call(h, 'GET', '/ops/metrics')).status).toBe(404);
    for (const weak of ['<сгенерировать>', 'short-token']) {
      process.env.OPS_METRICS_TOKEN = weak;
      expect((await call(h, "GET", "/ops/metrics", { headers: { authorization: "Bearer short-token" } })).status).toBe(404);
    }
    process.env.OPS_METRICS_TOKEN = `tok-${uid()}-${uid()}-${uid()}-${uid()}`;
    expect((await call(h, 'GET', '/ops/metrics')).status).toBe(401);
    expect((await call(h, 'GET', '/ops/metrics', { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
    // Токен пользователя — не токен метрик.
    expect((await call(h, 'GET', '/ops/metrics', { token: A.token })).status).toBe(401);
    const ok = await call(h, 'GET', '/ops/metrics', { headers: { authorization: `Bearer ${process.env.OPS_METRICS_TOKEN}` } });
    expect(ok.status).toBe(200);
    // Все организации (системный режим), в т.ч. другого клиента.
    expect(ok.text).toContain(`flowpos_esf_session_open{organization_id="${A.orgId}",environment="TEST"} 0`);
    expect(ok.text).toContain(`organization_id="${B.orgId}"`);
    expect(ok.text).toMatch(/flowpos_ops_alerts_open\{severity="WARNING"\} \d+/);
    expect(ok.text).not.toMatch(/990011223344|OpsA|OpsB/);
  });

  it('FP-024 карантин по HTTP: чужой клиент не видит и не обрабатывает; аудитор видит, но не обрабатывает', async () => {
    const body = '<broken';
    const mk = (orgId: string) => prisma.esfInboundQuarantine.create({ data: { organizationId: orgId, environment: 'TEST', esfId: BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000)), body, bodyHash: require('crypto').createHash('sha256').update(body).digest('hex'), bodyBytes: 7, errorCode: 'ESF_IN_LEGACY' } });
    const qa = await mk(A.orgId);
    const qb = await mk(B.orgId);
    const list = await call(h, 'GET', '/accounting/esf/quarantine', { token: A.token });
    expect(list.status).toBe(200);
    expect(list.body.items.map((i: any) => i.id)).toEqual([qa.id]);
    expect(list.body.items[0].esfId).toBe(qa.esfId.toString());
    expect((await call(h, 'GET', `/accounting/esf/quarantine/${qb.id}`, { token: A.token })).status).toBe(404);
    expect((await call(h, 'POST', `/accounting/esf/quarantine/${qb.id}/replay`, { token: A.token, body: { reason: 'Попытка чужой записи' } })).status).toBe(404);
    const card = await call(h, 'GET', `/accounting/esf/quarantine/${qa.id}`, { token: A.token });
    expect(card.body).toMatchObject({ body, bodyIntact: true, errorCode: 'ESF_IN_LEGACY', replayable: true });

    const aud = await makeUser(h, DEFAULT_TENANT, A.orgId, { role: 'auditor', name: 'Aud' });
    const audToken = (await login(h, aud.email)).token;
    expect((await call(h, 'GET', `/accounting/esf/quarantine/${qa.id}`, { token: audToken })).status).toBe(200);
    expect((await call(h, 'POST', `/accounting/esf/quarantine/${qa.id}/resolve`, { token: audToken, body: { action: 'DISMISS', reason: 'Аудитор закрывает запись' } })).status).toBe(403);
    const trace = `replay-${uid()}`;
    const replay = await call(h, 'POST', `/accounting/esf/quarantine/${qa.id}/replay`, { token: A.token, body: { reason: 'Повтор после исправления' }, headers: { 'x-request-id': trace } });
    expect(replay.status).toBe(201);
    expect(replay.body).toMatchObject({ outcome: 'STILL_QUARANTINED', code: 'ESF_IN_XML_MALFORMED' });
    const a = await prisma.auditLog.findFirstOrThrow({ where: { organizationId: A.orgId, action: 'ESF_QUARANTINE_REPLAY_FAILED', entityId: qa.id } });
    expect(a.traceId).toBe(trace);
  });
});
