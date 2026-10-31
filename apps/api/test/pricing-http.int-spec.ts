// FP-027 через HTTP под рабочей ролью (RLS): цены и снимки — только своей организации и клиента; кассир получает
// снимок, но публиковать и менять цены не может.
import { PrismaService } from '../src/prisma/prisma.service';
import { call, login, makeUser, startApp, uid, HttpApp } from './http-app';
import { DEFAULT_TENANT, defaultTenant } from './accounting-helpers';
import { runAsTenant } from '../src/common/db-context';

let h: HttpApp;
let prisma: PrismaService;
let t2: string;
type Who = { orgId: string; token: string };
let A: Who, B: Who;
const created: string[] = [];

async function who(tenantId: string, name: string, role = 'owner', orgId?: string): Promise<Who> {
  const org = orgId ?? (await prisma.organization.create({ data: { tenantId, name: `${name} ${uid()}` } })).id;
  const u = await makeUser(h, tenantId, org, { role, name });
  return { orgId: org, token: (await login(h, u.email)).token };
}

beforeAll(async () => {
  h = await startApp();
  prisma = h.prisma;
  await defaultTenant(prisma);
  t2 = (await prisma.tenant.create({ data: { name: `Цены HTTP ${uid()}` } })).id;
  A = await who(DEFAULT_TENANT, 'PrHttpA');
  B = await who(t2, 'PrHttpB');
}, 60_000);

afterAll(async () => {
  if (prisma) {
    await prisma.priceListItem.deleteMany({ where: { productId: { in: created } } });
    await prisma.product.deleteMany({ where: { id: { in: created } } });
  }
  if (prisma && t2) {
    await prisma.authSession.deleteMany({ where: { user: { tenantId: t2 } } });
    await prisma.refreshToken.deleteMany({ where: { user: { tenantId: t2 } } });
    await prisma.orgMembership.deleteMany({ where: { tenantId: t2 } });
    await prisma.user.deleteMany({ where: { tenantId: t2 } });
    await prisma.organization.deleteMany({ where: { tenantId: t2 } });
    await prisma.tenant.delete({ where: { id: t2 } });
  }
  await h?.app.close();
});

describe('FP-027 цены через HTTP', () => {
  it('прайс-лист и снимок: чужой клиент — 404; кассир читает снимок, но не публикует; RLS прямым запросом', async () => {
    const uom = (await prisma.uom.findFirst({ where: { tenantId: DEFAULT_TENANT } }))!;
    const p = await prisma.product.create({ data: { tenantId: DEFAULT_TENANT, name: `HTTP цена ${uid()}`, uomId: uom.id } });
    created.push(p.id);
    const l = await call(h, 'POST', '/pricing/price-lists', { token: A.token, body: { name: 'Розница', validFrom: '2026-01-01' } });
    expect(l.status).toBe(201);
    expect((await call(h, 'POST', `/pricing/price-lists/${l.body.id}/items`, { token: A.token, body: { upsert: [{ productId: p.id, price: '990' }] } })).status).toBe(201);
    expect((await call(h, 'PUT', `/pricing/price-lists/${l.body.id}`, { token: A.token, body: { status: 'ACTIVE' } })).status).toBe(200);
    const prev = await call(h, 'POST', '/pricing/preview', { token: A.token, body: { date: '2026-11-03', lines: [{ productId: p.id, qty: '2' }] } });
    expect(prev.body).toMatchObject({ total: '1980.00', payable: '1980.00' });
    const snap = await call(h, 'POST', '/pricing/snapshots', { token: A.token, body: { from: '2026-11-03' } });
    expect(snap.body).toMatchObject({ version: 1, unchanged: false });

    const cashier = await who(DEFAULT_TENANT, 'PrCash', 'cashier', A.orgId);
    const latest = await call(h, 'GET', '/pricing/snapshots/latest', { token: cashier.token });
    expect(latest.status).toBe(200);
    expect(latest.body).toMatchObject({ version: 1, hash: snap.body.hash, payload: { priceLists: [{ name: 'Розница' }] } });
    expect((await call(h, 'GET', '/pricing/snapshots/latest?since=1', { token: cashier.token })).body).toMatchObject({ notModified: true });
    expect((await call(h, 'POST', '/pricing/snapshots', { token: cashier.token, body: {} })).status).toBe(403);
    expect((await call(h, 'POST', `/pricing/price-lists/${l.body.id}/items`, { token: cashier.token, body: { upsert: [{ productId: p.id, price: '1' }] } })).status).toBe(403);

    expect((await call(h, 'GET', `/pricing/price-lists/${l.body.id}`, { token: B.token })).status).toBe(404);
    expect((await call(h, 'GET', '/pricing/snapshots/latest', { token: B.token })).status).toBe(404);
    expect((await call(h, 'POST', '/pricing/preview', { token: B.token, body: { date: '2026-11-03', lines: [{ productId: p.id, qty: '1' }] } })).body.code).toBe('REF_FOREIGN');

    const runtime = h.app.get(PrismaService); // flowpos_app, без обхода RLS
    expect(await runAsTenant(t2, () => runtime.priceList.count({ where: { id: l.body.id } }))).toBe(0);
    expect(await runAsTenant(t2, () => runtime.priceListItem.count({ where: { priceListId: l.body.id } }))).toBe(0);
    expect(await runAsTenant(t2, () => runtime.pricingSnapshot.count({ where: { id: snap.body.id } }))).toBe(0);
    expect(await runAsTenant(DEFAULT_TENANT, () => runtime.pricingSnapshot.count({ where: { id: snap.body.id } }))).toBe(1);
  });
});
