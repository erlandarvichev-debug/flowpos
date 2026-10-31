// FP-025 через HTTP под рабочей ролью (RLS): штрихкоды, весовые, версии и сопоставления — только своего клиента;
// изменение настроек — по праву catalog.manage; форма веба (uomId/kind) принимается.
import { randomInt } from 'crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { call, login, makeUser, startApp, uid, HttpApp } from './http-app';
import { DEFAULT_TENANT, defaultTenant } from './accounting-helpers';
import { gs1CheckDigit } from '../src/modules/catalog/barcode';
import { runAsTenant } from '../src/common/db-context';

let h: HttpApp;
let prisma: PrismaService;
let t2: string;
type Who = { orgId: string; token: string; uomId: string };
let A: Who, B: Who;
/** Метка прогона в именах товаров — по ней тест убирает за собой. */
const RUN = `t${uid()}`;
const ean = () => { const d = `48${String(randomInt(0, 1e10)).padStart(10, '0')}`; return d + gs1CheckDigit(d); };

async function who(tenantId: string, name: string, role = 'owner', orgId?: string): Promise<Who> {
  const org = orgId ?? (await prisma.organization.create({ data: { tenantId, name: `${name} ${uid()}` } })).id;
  const u = await makeUser(h, tenantId, org, { role, name });
  const uom = await prisma.uom.findFirst({ where: { tenantId } }) ?? await prisma.uom.create({ data: { tenantId, name: 'шт', shortName: 'шт' } });
  return { orgId: org, token: (await login(h, u.email)).token, uomId: uom.id };
}

beforeAll(async () => {
  h = await startApp();
  prisma = h.prisma;
  await defaultTenant(prisma);
  t2 = (await prisma.tenant.create({ data: { name: `Каталог HTTP ${uid()}` } })).id;
  A = await who(DEFAULT_TENANT, 'CatHttpA');
  B = await who(t2, 'CatHttpB');
}, 60_000);

afterAll(async () => {
  if (prisma) {
    // Товары основного клиента, созданные тестом (по уникальной метке в имени).
    const mine = (await prisma.product.findMany({ where: { tenantId: DEFAULT_TENANT, name: { contains: RUN } }, select: { id: true } })).map((p) => p.id);
    await prisma.productBarcode.deleteMany({ where: { productId: { in: mine } } });
    await prisma.product.deleteMany({ where: { id: { in: mine } } });
    await prisma.productVersion.deleteMany({ where: { productId: { in: mine } } });
  }
  if (prisma && t2) {
    const orgs = (await prisma.organization.findMany({ where: { tenantId: t2 }, select: { id: true } })).map((o) => o.id);
    await prisma.productBarcode.deleteMany({ where: { tenantId: t2 } });
    await prisma.product.deleteMany({ where: { tenantId: t2 } });
    await prisma.productVersion.deleteMany({ where: { tenantId: t2 } });
    await prisma.catalogSettings.deleteMany({ where: { tenantId: { in: [t2, DEFAULT_TENANT] } } });
    await prisma.uom.deleteMany({ where: { tenantId: t2 } });
    await prisma.authSession.deleteMany({ where: { user: { tenantId: t2 } } });
    await prisma.refreshToken.deleteMany({ where: { user: { tenantId: t2 } } });
    await prisma.orgMembership.deleteMany({ where: { tenantId: t2 } });
    await prisma.user.deleteMany({ where: { tenantId: t2 } });
    await prisma.organization.deleteMany({ where: { id: { in: orgs } } });
    await prisma.tenant.delete({ where: { id: t2 } });
  }
  await h?.app.close();
});

describe('FP-025 каталог через HTTP', () => {
  it('один EAN у двух клиентов; поиск по коду — только свой товар; дубль у клиента — 409 с понятным текстом', async () => {
    const code = ean();
    const a = await call(h, 'POST', '/catalog/items', { token: A.token, body: { name: `Сок A ${RUN} ${uid()}`, uomId: A.uomId, kind: 'PRODUCT', vatRate: 16, barcodes: [{ barcode: code }] } });
    expect(a.status).toBe(201);
    const b = await call(h, 'POST', '/catalog/items', { token: B.token, body: { name: `Сок B ${RUN} ${uid()}`, uomId: B.uomId, barcodes: [{ barcode: code }] } });
    expect(b.status).toBe(201);
    expect((await call(h, 'GET', `/catalog/items/barcode/${code}`, { token: A.token })).body).toMatchObject({ productId: a.body.id, source: 'BARCODE', factor: '1' });
    expect((await call(h, 'GET', `/catalog/items/barcode/${code}`, { token: B.token })).body.productId).toBe(b.body.id);
    expect((await call(h, 'GET', `/catalog/items/barcode/${ean()}`, { token: A.token })).status).toBe(404);

    const a2 = await call(h, 'POST', '/catalog/items', { token: A.token, body: { name: `Сок A2 ${RUN} ${uid()}`, uomId: A.uomId } });
    const dup = await call(h, 'POST', `/catalog/items/${a2.body.id}/barcodes`, { token: A.token, body: { barcode: code } });
    expect(dup.status).toBe(409);
    expect(dup.body).toMatchObject({ code: 'BARCODE_TAKEN', message: expect.stringContaining('Сок A') });
    const search = await call(h, 'GET', `/catalog/items?search=${code}`, { token: A.token });
    expect(search.body.items.map((i: any) => i.id)).toEqual([a.body.id]);
  });

  it('версии и сопоставления чужого товара — 404; свои — видны', async () => {
    const a = await call(h, 'POST', '/catalog/items', { token: A.token, body: { name: `Версии ${RUN} ${uid()}`, uomId: A.uomId } });
    await call(h, 'PUT', `/catalog/items/${a.body.id}`, { token: A.token, body: { name: `Версии (2) ${RUN} ${uid()}`, syncStatus: 'SYNCED' } });
    const v = await call(h, 'GET', `/catalog/items/${a.body.id}/versions`, { token: A.token });
    expect(v.body.map((x: any) => x.version)).toEqual([2, 1]);
    expect((await call(h, 'GET', `/catalog/items/${a.body.id}/versions`, { token: B.token })).status).toBe(404);
    expect((await call(h, 'GET', `/catalog/items/${a.body.id}/mappings`, { token: B.token })).status).toBe(404);
    expect((await call(h, 'GET', `/catalog/items/${a.body.id}`, { token: B.token })).status).toBe(404);
    // RLS: прямой запрос рабочей ролью в контексте другого клиента версий и штрихкодов не видит.
    const runtime = h.app.get(PrismaService); // клиент приложения — flowpos_app, без обхода RLS
    expect(await runAsTenant(t2, () => runtime.productVersion.count({ where: { productId: a.body.id } }))).toBe(0);
    expect(await runAsTenant(t2, () => runtime.productBarcode.count({ where: { tenantId: DEFAULT_TENANT } }))).toBe(0);
    expect(await runAsTenant(DEFAULT_TENANT, () => runtime.productVersion.count({ where: { productId: a.body.id } }))).toBe(2);
  });

  it('весовые: настройки — по праву catalog.manage; код из этикетки находит товар по PLU', async () => {
    const aud = await who(DEFAULT_TENANT, 'CatAud', 'auditor', A.orgId);
    expect((await call(h, 'GET', '/catalog/items/settings', { token: aud.token })).status).toBe(200);
    expect((await call(h, 'PUT', '/catalog/items/settings', { token: aud.token, body: { prefixes: ['21'], pluLength: 5 } })).status).toBe(403);
    expect((await call(h, 'PUT', '/catalog/items/settings', { token: A.token, body: { prefixes: ['46'] } })).body.code).toBe('WEIGHT_PREFIX');
    expect((await call(h, 'PUT', '/catalog/items/settings', { token: A.token, body: { prefixes: ['21'], pluLength: 5 } })).status).toBe(200);
    const plu = String(randomInt(10000, 99999));
    const p = await call(h, 'POST', '/catalog/items', { token: A.token, body: { name: `Сыр ${RUN} ${uid()}`, uomId: A.uomId, plu } });
    expect(p.status).toBe(201);
    const d = `21${plu}00750`;
    const r = await call(h, 'GET', `/catalog/items/barcode/${d}${gs1CheckDigit(d)}`, { token: A.token });
    expect(r.body).toMatchObject({ productId: p.body.id, source: 'WEIGHT', weightKg: '0.750' });
    // Настройки другого клиента — свои (у B весовые выключены).
    expect((await call(h, 'GET', `/catalog/items/barcode/${d}${gs1CheckDigit(d)}`, { token: B.token })).status).toBe(404);
    expect((await call(h, 'GET', '/catalog/items/settings', { token: B.token })).body).toEqual({ prefixes: [], pluLength: 5 });
  });
});
