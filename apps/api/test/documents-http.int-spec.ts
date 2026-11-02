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
let trade: any;
/** Торговая обвязка организации A (склад, товары, контрагенты) — одна на файл. */
const tradeA = async () => (trade ??= await runAsTenant(DEFAULT_TENANT, () => makeTrade(prisma, ctxFor(A.orgId, A.userId, 'owner'), { vatPayer: false })));

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
    const t = await tradeA();
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

  it('FP-029: бухгалтер запрашивает согласование, но не согласует (403); главбух согласует; чужой клиент — 404', async () => {
    const t = await tradeA();
    const acc = await makeUser(h, DEFAULT_TENANT, A.orgId, { role: 'accountant', name: 'DocAcc' });
    const chief = await makeUser(h, DEFAULT_TENANT, A.orgId, { role: 'chief_accountant', name: 'DocChief' });
    const accTok = (await login(h, acc.email)).token, chiefTok = (await login(h, chief.email)).token;
    expect((await call(h, 'POST', '/accounting/approval-policies', { token: accTok, body: { docKind: 'TRADE', minAmount: '0' } })).status).toBe(403);
    expect((await call(h, 'POST', '/accounting/approval-policies', { token: A.token, body: { docKind: 'TRADE', minAmount: '0', ttlHours: 4 } })).status).toBe(201);
    const d = await call(h, 'POST', '/accounting/trade-documents', { token: accTok, body: { docType: 'SUPPLY', date: '2026-10-01', counterpartyId: t.supplier.id, storeId: t.s1.id, lines: [{ productId: t.goods.id, qty: '1', price: '10' }] } });
    const sim = await call(h, 'POST', `/accounting/trade-documents/${d.body.id}/simulate`, { token: accTok });
    expect(sim.body.approval).toMatchObject({ required: true, satisfied: false });
    const req = await call(h, 'POST', '/accounting/approvals', { token: accTok, body: { docKind: 'TRADE', docId: d.body.id, expectedVersion: 1 } });
    expect(req.status).toBe(201);
    expect((await call(h, 'POST', `/accounting/approvals/${req.body.id}/decide`, { token: accTok, body: { decision: 'APPROVE' } })).status).toBe(403);
    // Другой бухгалтер (не автор запроса) — тоже нет: нет права согласования, а не только «четыре глаза».
    const acc2 = await makeUser(h, DEFAULT_TENANT, A.orgId, { role: 'accountant', name: 'DocAcc2' });
    const acc2Decide = await call(h, 'POST', `/accounting/approvals/${req.body.id}/decide`, { token: (await login(h, acc2.email)).token, body: { decision: 'APPROVE' } });
    expect(acc2Decide.status).toBe(403);
    expect((await call(h, 'POST', `/accounting/approvals/${req.body.id}/decide`, { token: B.token, body: { decision: 'APPROVE' } })).status).toBe(404);
    expect((await call(h, 'POST', `/accounting/approvals/${req.body.id}/decide`, { token: chiefTok, body: { decision: 'APPROVE' } })).body.status).toBe('APPROVED');
    expect((await call(h, 'POST', `/accounting/trade-documents/${d.body.id}/post`, { token: accTok, body: { expectedVersion: 1 } })).body.status).toBe('POSTED');
    expect((await call(h, 'GET', '/accounting/approvals', { token: B.token })).body.find((x: any) => x.id === req.body.id)).toBeUndefined();
    const runtime = h.app.get(PrismaService);
    expect(await runAsTenant(t2, () => runtime.approval.count({ where: { id: req.body.id } }))).toBe(0);
    await prisma.approvalPolicy.deleteMany({ where: { organizationId: A.orgId } });
  });

  it('FP-030: журнал движений — кладовщик видит количества без стоимости, бухгалтер — со стоимостью; чужой клиент и RLS — нет', async () => {
    const t = await tradeA();
    const d = await call(h, 'POST', '/accounting/trade-documents', { token: A.token, body: { docType: 'SUPPLY', date: '2026-10-01', counterpartyId: t.supplier.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods2.id, qty: '3', price: '10', expectedQty: '4', discrepancyReason: 'SHORTAGE' }] } });
    expect(d.status).toBe(201);
    const keeper = await makeUser(h, DEFAULT_TENANT, A.orgId, { role: 'storekeeper', name: 'DocKeeper' });
    const keeperTok = (await login(h, keeper.email)).token;
    const asOwner = await call(h, 'GET', `/accounting/stock-movements?sourceId=${d.body.id}`, { token: A.token });
    expect(asOwner.body.items.map((m: any) => [m.kind, m.qty, m.value, m.valueBasis])).toEqual([['RECEIPT', '3', '30.00', 'ACCOUNTING']]);
    const asKeeper = await call(h, 'GET', `/accounting/stock-movements?sourceId=${d.body.id}`, { token: keeperTok });
    expect(asKeeper.status).toBe(200);
    expect(asKeeper.body.items[0]).toMatchObject({ kind: 'RECEIPT', qty: '3', source: { id: d.body.id } });
    expect('value' in asKeeper.body.items[0]).toBe(false);
    const disc = await call(h, 'GET', '/accounting/receipt-discrepancies?from=2026-10-01&to=2026-10-01', { token: keeperTok });
    expect(disc.body.items.find((x: any) => x.id === d.body.id)).toMatchObject({ lines: [{ shortage: '1' }] });
    expect(disc.body.items.find((x: any) => x.id === d.body.id).claimAmount).toBeUndefined();
    expect((await call(h, 'GET', '/accounting/receipt-discrepancies?from=2026-10-01&to=2026-10-01', { token: A.token })).body.items.find((x: any) => x.id === d.body.id).claimAmount).toBe('10.00');
    expect((await call(h, 'GET', '/accounting/stock-movements/check', { token: keeperTok })).body).toMatchObject({ ok: true });
    expect((await call(h, 'GET', `/accounting/stock-movements?sourceId=${d.body.id}`, { token: B.token })).body.items).toEqual([]);
    const hr = await makeUser(h, DEFAULT_TENANT, A.orgId, { role: 'hr', name: 'DocHr' });
    expect((await call(h, 'GET', '/accounting/stock-movements', { token: (await login(h, hr.email)).token })).status).toBe(403);
    const runtime = h.app.get(PrismaService);
    expect(await runAsTenant(t2, () => runtime.stockMovement.count({ where: { sourceId: d.body.id } }))).toBe(0);
    expect(await runAsTenant(DEFAULT_TENANT, () => runtime.stockMovement.count({ where: { sourceId: d.body.id } }))).toBe(1);
  });

  it('FP-032: резерв — с правом записи документов, чужой клиент — 404; «в пути» — кладовщику; RLS резервов', async () => {
    const t = await tradeA();
    await call(h, 'POST', '/accounting/trade-documents', { token: A.token, body: { docType: 'SUPPLY', date: '2026-10-01', counterpartyId: t.supplier.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '5', price: '10' }] } });
    const o = await call(h, 'POST', '/accounting/trade-documents', { token: A.token, body: { docType: 'CUSTOMER_ORDER', date: '2026-10-02', counterpartyId: t.customer.id, storeId: t.s1.id, lines: [{ productId: t.goods.id, qty: '2', price: '20' }] } });
    const keeper = await makeUser(h, DEFAULT_TENANT, A.orgId, { role: 'storekeeper', name: 'ResKeeper' });
    const keeperTok = (await login(h, keeper.email)).token;
    expect((await call(h, 'POST', `/accounting/trade-documents/${o.body.id}/reserve`, { token: keeperTok })).status).toBe(403);
    expect((await call(h, 'POST', `/accounting/trade-documents/${o.body.id}/reserve`, { token: B.token })).status).toBe(404);
    const r = await call(h, 'POST', `/accounting/trade-documents/${o.body.id}/reserve`, { token: A.token });
    expect([r.status, r.body.lines[0].reserved]).toEqual([201, '2']);
    expect((await call(h, 'GET', '/accounting/transfers-in-transit', { token: keeperTok })).status).toBe(200);
    const runtime = h.app.get(PrismaService);
    expect(await runAsTenant(t2, () => runtime.stockReservation.count({ where: { sourceId: o.body.id } }))).toBe(0);
    expect(await runAsTenant(DEFAULT_TENANT, () => runtime.stockReservation.count({ where: { sourceId: o.body.id } }))).toBe(1);
    await call(h, 'POST', `/accounting/trade-documents/${o.body.id}/release-reserve`, { token: A.token });
  });
});
