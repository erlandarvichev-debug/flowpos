// FP-026 через HTTP под рабочей ролью (RLS): реквизиты и договоры контрагента — только своего клиента и организации;
// изменение — по праву catalog.manage; форма веба принимается.
import { randomInt } from 'crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { call, login, makeUser, startApp, uid, HttpApp } from './http-app';
import { DEFAULT_TENANT, defaultTenant } from './accounting-helpers';
import { binCheckDigit } from '../src/modules/catalog/requisites';
import { runAsTenant } from '../src/common/db-context';

let h: HttpApp;
let prisma: PrismaService;
let t2: string;
type Who = { orgId: string; token: string };
let A: Who, A2: Who, B: Who;
const RUN = `t${uid()}`;
const bin = (): string => { const d = String(randomInt(0, 1e11)).padStart(11, '0'); const c = binCheckDigit(d); return c === null ? bin() : d + c; };

async function who(tenantId: string, name: string, role = 'owner', orgId?: string): Promise<Who> {
  const org = orgId ?? (await prisma.organization.create({ data: { tenantId, name: `${name} ${uid()}` } })).id;
  const u = await makeUser(h, tenantId, org, { role, name });
  return { orgId: org, token: (await login(h, u.email)).token };
}

beforeAll(async () => {
  h = await startApp();
  prisma = h.prisma;
  await defaultTenant(prisma);
  t2 = (await prisma.tenant.create({ data: { name: `Контрагенты HTTP ${uid()}` } })).id;
  A = await who(DEFAULT_TENANT, 'CpHttpA');
  A2 = await who(DEFAULT_TENANT, 'CpHttpA2');
  B = await who(t2, 'CpHttpB');
}, 60_000);

afterAll(async () => {
  if (prisma) {
    const mine = (await prisma.counterparty.findMany({ where: { name: { contains: RUN } }, select: { id: true } })).map((c) => c.id);
    await prisma.contract.deleteMany({ where: { counterpartyId: { in: mine } } });
    await prisma.counterparty.deleteMany({ where: { id: { in: mine } } });
  }
  if (prisma && t2) {
    const orgs = (await prisma.organization.findMany({ where: { tenantId: t2 }, select: { id: true } })).map((o) => o.id);
    await prisma.authSession.deleteMany({ where: { user: { tenantId: t2 } } });
    await prisma.refreshToken.deleteMany({ where: { user: { tenantId: t2 } } });
    await prisma.orgMembership.deleteMany({ where: { tenantId: t2 } });
    await prisma.user.deleteMany({ where: { tenantId: t2 } });
    await prisma.organization.deleteMany({ where: { id: { in: orgs } } });
    await prisma.tenant.delete({ where: { id: t2 } });
  }
  await h?.app.close();
});

describe('FP-026 контрагенты через HTTP', () => {
  it('реквизиты и договоры: чужой клиент — 404; другая организация не видит договор; RLS прямым запросом', async () => {
    const c = await call(h, 'POST', '/catalog/counterparties', { token: A.token, body: { name: `ТОО Ромашка ${RUN}`, kind: 'LEGAL', type: 'CUSTOMER', inn: bin(), kbe: '17' } });
    expect(c.status).toBe(201);
    const id = c.body.id;
    expect((await call(h, 'POST', `/catalog/counterparties/${id}/addresses`, { token: A.token, body: { line: 'г. Алматы, ул. Тестовая, 1', validFrom: '2026-01-01' } })).status).toBe(201);
    expect((await call(h, 'POST', `/catalog/counterparties/${id}/bank-accounts`, { token: A.token, body: { iban: 'KZ86125KZT5004100100', bik: 'HSBKKZKX', bankName: 'Halyk', validFrom: '2026-01-01' } })).status).toBe(201);
    const k = await call(h, 'POST', `/catalog/counterparties/${id}/contracts`, { token: A.token, body: { number: `Д-${RUN}`, date: '2026-01-15', type: 'SALE' } });
    expect(k.status).toBe(201);

    const req = await call(h, 'GET', `/catalog/counterparties/${id}/requisites?on=2026-06-01`, { token: A.token });
    expect(req.body).toMatchObject({ legalAddress: { line: 'г. Алматы, ул. Тестовая, 1' }, bankAccount: { iban: 'KZ86125KZT5004100100', isDefault: true } });

    // Другой клиент: ни карточки, ни реквизитов, ни договоров.
    for (const path of ['', '/requisites', '/contracts']) expect((await call(h, 'GET', `/catalog/counterparties/${id}${path}`, { token: B.token })).status).toBe(404);
    expect((await call(h, 'POST', `/catalog/counterparties/${id}/addresses`, { token: B.token, body: { line: 'Захват адреса, 1' } })).status).toBe(404);
    // Другая организация того же клиента: контрагент общий — виден, договор организации A — нет.
    const card = await call(h, 'GET', `/catalog/counterparties/${id}`, { token: A2.token });
    expect(card.status).toBe(200);
    expect(card.body.contracts).toEqual([]);
    expect((await call(h, 'GET', `/accounting/contracts?counterpartyId=${id}`, { token: A2.token })).body).toEqual([]);
    expect((await call(h, 'PUT', `/catalog/counterparties/${id}/contracts/${k.body.id}`, { token: A2.token, body: { name: 'захват' } })).status).toBe(404);

    const runtime = h.app.get(PrismaService); // flowpos_app, без обхода RLS
    expect(await runAsTenant(t2, () => runtime.counterpartyAddress.count({ where: { counterpartyId: id } }))).toBe(0);
    expect(await runAsTenant(t2, () => runtime.counterpartyBankAccount.count({ where: { counterpartyId: id } }))).toBe(0);
    expect(await runAsTenant(t2, () => runtime.contract.count({ where: { counterpartyId: id } }))).toBe(0);
    expect(await runAsTenant(DEFAULT_TENANT, () => runtime.counterpartyAddress.count({ where: { counterpartyId: id } }))).toBe(1);
  });

  it('изменение реквизитов — по праву catalog.manage; ошибки ввода — понятным кодом', async () => {
    const c = await call(h, 'POST', '/catalog/counterparties', { token: A.token, body: { name: `ИП Тест ${RUN}`, kind: 'ENTREPRENEUR', inn: bin() } });
    const aud = await who(DEFAULT_TENANT, 'CpAud', 'auditor', A.orgId);
    expect((await call(h, 'GET', `/catalog/counterparties/${c.body.id}`, { token: aud.token })).status).toBe(200);
    expect((await call(h, 'POST', `/catalog/counterparties/${c.body.id}/contracts`, { token: aud.token, body: { number: '1', date: '2026-01-01' } })).status).toBe(403);
    expect((await call(h, 'POST', `/catalog/counterparties/${c.body.id}/addresses`, { token: aud.token, body: { line: 'Адрес аудитора, 1' } })).status).toBe(403);
    expect((await call(h, 'POST', '/catalog/counterparties', { token: A.token, body: { name: `x ${RUN}`, inn: '940140000386' } })).body.code).toBe('BIN_CHECK_DIGIT');
    expect((await call(h, 'POST', `/catalog/counterparties/${c.body.id}/bank-accounts`, { token: A.token, body: { iban: 'KZ00', bik: 'HSBKKZKX', bankName: 'x' } })).body.code).toBe('IBAN_FORMAT');
  });
});
