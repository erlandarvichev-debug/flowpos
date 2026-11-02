// FP-028 через HTTP под рабочей ролью (RLS): версии и граф документов — только своей организации; повторное
// проведение — 409; повтор того же запроса с Idempotency-Key — прежний ответ, а не конфликт.
import { PrismaService } from '../src/prisma/prisma.service';
import { call, login, makeUser, startApp, uid, HttpApp } from './http-app';
import { DEFAULT_TENANT, defaultTenant, makeTrade, ctxFor } from './accounting-helpers';
import { runAsTenant } from '../src/common/db-context';

let h: HttpApp;
let prisma: PrismaService;
let t2: string;
type Who = { orgId: string; token: string; userId: string };
let A: Who, B: Who;

async function who(tenantId: string, name: string): Promise<Who> {
  const org = await prisma.organization.create({ data: { tenantId, name: `${name} ${uid()}` } });
  const chart = await prisma.accChart.findFirstOrThrow({ where: { code: 'KZ-TYPICAL' } });
  await prisma.accPolicy.create({ data: { organizationId: org.id, validFrom: new Date('2020-01-01'), chartId: chart.id } });
  const u = await makeUser(h, tenantId, org.id, { role: 'owner', name });
  return { orgId: org.id, token: (await login(h, u.email)).token, userId: u.id };
}

beforeAll(async () => {
  h = await startApp();
  prisma = h.prisma;
  await defaultTenant(prisma);
  t2 = (await prisma.tenant.create({ data: { name: `Документы HTTP ${uid()}` } })).id;
  A = await who(DEFAULT_TENANT, 'DocHttpA');
  B = await who(t2, 'DocHttpB');
}, 60_000);

afterAll(async () => {
  if (prisma && t2) {
    const orgs = (await prisma.organization.findMany({ where: { tenantId: t2 }, select: { id: true } })).map((o) => o.id);
    await prisma.accPolicy.deleteMany({ where: { organizationId: { in: orgs } } });
    await prisma.authSession.deleteMany({ where: { user: { tenantId: t2 } } });
    await prisma.refreshToken.deleteMany({ where: { user: { tenantId: t2 } } });
    await prisma.orgMembership.deleteMany({ where: { tenantId: t2 } });
    await prisma.user.deleteMany({ where: { tenantId: t2 } });
    await prisma.organization.deleteMany({ where: { id: { in: orgs } } });
    await prisma.tenant.delete({ where: { id: t2 } });
  }
  await h?.app.close();
});

describe('FP-028 документы через HTTP', () => {
  it('повторное проведение — 409, повтор с тем же ключом — прежний ответ; версии и граф чужого клиента — 404; RLS', async () => {
    const t = await runAsTenant(DEFAULT_TENANT, () => makeTrade(prisma, ctxFor(A.orgId, A.userId, 'owner'), { vatPayer: false }));
    const created = await call(h, 'POST', '/accounting/trade-documents', { token: A.token, body: { docType: 'SUPPLY', date: '2026-10-01', counterpartyId: t.supplier.id, storeId: t.s1.id, lines: [{ productId: t.goods.id, qty: '2', price: '10' }] } });
    expect(created.status).toBe(201);
    const id = created.body.id;
    const key = { 'idempotency-key': `post-${uid()}` };
    const p1 = await call(h, 'POST', `/accounting/trade-documents/${id}/post`, { token: A.token, headers: key, body: { expectedVersion: 1 } });
    expect(p1.status).toBe(201);
    const replay = await call(h, 'POST', `/accounting/trade-documents/${id}/post`, { token: A.token, headers: key, body: { expectedVersion: 1 } });
    expect([replay.status, replay.body.postedVersion]).toEqual([201, 1]); // тот же запрос — тот же ответ
    const dup = await call(h, 'POST', `/accounting/trade-documents/${id}/post`, { token: A.token, body: { expectedVersion: 1 } });
    expect([dup.status, dup.body.code]).toEqual([409, 'DOC_ALREADY_POSTED']);
    const upd = await call(h, 'PUT', `/accounting/trade-documents/${id}`, { token: A.token, body: { comment: 'без версии' } });
    expect([upd.status, upd.body.code]).toEqual([428, 'VERSION_REQUIRED']);

    const versions = await call(h, 'GET', `/accounting/trade-documents/${id}/versions`, { token: A.token });
    expect(versions.body.map((v: any) => v.action)).toEqual(['CREATE', 'POST']);
    expect((await call(h, 'GET', `/accounting/trade-documents/${id}/versions`, { token: B.token })).status).toBe(404);
    expect((await call(h, 'GET', `/accounting/document-graph/TRADE/${id}`, { token: A.token })).body).toMatchObject({ root: `TRADE:${id}`, nodes: [{ key: `TRADE:${id}`, postedVersion: 1 }] });
    expect((await call(h, 'GET', `/accounting/document-graph/TRADE/${id}`, { token: B.token })).status).toBe(404);

    const runtime = h.app.get(PrismaService); // flowpos_app — без обхода RLS
    expect(await runAsTenant(t2, () => runtime.documentVersion.count({ where: { documentId: id } }))).toBe(0);
    expect(await runAsTenant(DEFAULT_TENANT, () => runtime.documentVersion.count({ where: { documentId: id } }))).toBe(2);
  });
});
