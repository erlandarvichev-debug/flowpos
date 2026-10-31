// FP-026: контрагенты, реквизиты с датами действия и договоры организации на настоящей БД — дубли БИН, история
// адресов/счетов, договор только своей организации и в сроке действия (торговля, проводки, ЭСФ, справочник).
import { randomInt, randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { Scope } from '../src/common/scope';
import { CounterpartiesService } from '../src/modules/catalog/counterparties.service';
import { WarehousesService } from '../src/modules/catalog/warehouses.service';
import { OutboxService } from '../src/common/outbox/outbox.service';
import { SalesService } from '../src/modules/trade/sales.service';
import { RefsService } from '../src/modules/accounting/refs/refs.service';
import { binCheckDigit } from '../src/modules/catalog/requisites';
import { runAsTenant } from '../src/common/db-context';
import { ctxFor, defaultTenant, makeOrg, makeServices } from './accounting-helpers';

const prisma = new PrismaService();
const cps = new CounterpartiesService(prisma);
const stores = new WarehousesService(prisma);
const sales = new SalesService(prisma, new OutboxService(prisma));
const refs = new RefsService(prisma);
const acc = makeServices(prisma);
const uid = () => randomUUID().slice(0, 8);
/** Случайный корректный БИН. */
const bin = (): string => { const d = String(randomInt(0, 1e11)).padStart(11, '0'); const c = binCheckDigit(d); return c === null ? bin() : d + c; };
const scope = (ctx: { tenantId: string; organizationId: string; userId: string }): Scope => ({ tenantId: ctx.tenantId, organizationId: ctx.organizationId, userId: ctx.userId, role: 'chief_accountant' });
async function code(p: Promise<unknown>) {
  try { await p; return 'OK'; } catch (e: any) { return e?.response?.code ?? e?.status ?? e?.message; }
}

let A: Scope, A2: Scope, B: Scope;
let t2: string;
const created: string[] = [];
const cp = async (s: Scope, extra: Record<string, unknown> = {}) => {
  const c = await cps.create(s, { name: `Контрагент ${uid()}`, inn: bin(), ...extra });
  created.push(c.id);
  return c;
};

beforeAll(async () => {
  await prisma.$connect();
  await defaultTenant(prisma);
  await acc.chart.bootstrap();
  A = scope(await makeOrg(prisma));
  A2 = scope(await makeOrg(prisma));
  t2 = (await prisma.tenant.create({ data: { name: `Контрагенты 2 ${uid()}` } })).id;
  const orgB = await prisma.organization.create({ data: { tenantId: t2, name: `B ${uid()}` } });
  const userB = await prisma.user.create({ data: { tenantId: t2, organizationId: orgB.id, email: `b-${uid()}@cp.local`, passwordHash: 'x', firstName: 'B', lastName: 'B' } });
  B = { tenantId: t2, organizationId: orgB.id, userId: userB.id, role: 'owner' };
});

afterAll(async () => {
  const docs = (await prisma.document.findMany({ where: { counterpartyId: { in: created } }, select: { id: true } })).map((d) => d.id);
  await prisma.outbox.deleteMany({ where: { localId: { in: docs } } });
  await prisma.documentLine.deleteMany({ where: { documentId: { in: docs } } });
  await prisma.document.deleteMany({ where: { id: { in: docs } } });
  await prisma.contract.deleteMany({ where: { counterpartyId: { in: created } } });
  await prisma.counterparty.deleteMany({ where: { id: { in: created } } });
  await prisma.user.deleteMany({ where: { tenantId: t2 } });
  await prisma.organization.deleteMany({ where: { tenantId: t2 } });
  await prisma.tenant.delete({ where: { id: t2 } });
  await prisma.$disconnect();
});

describe('FP-026: реквизиты', () => {
  it('БИН с контрольным разрядом; дубль у видимого — с именем, у личного другой организации — без; поля обмена не принимаются', async () => {
    expect(await code(cps.create(A, { name: 'Опечатка', inn: '940140000386' }))).toBe('BIN_CHECK_DIGIT');
    const a = await cp(A, { msId: 'подмена', onecGuid: 'подмена', syncStatus: 'SYNCED', deleted: true, owner: 'FLOWPOS' });
    const row = await prisma.counterparty.findUniqueOrThrow({ where: { id: a.id } });
    expect(row).toMatchObject({ msId: null, onecGuid: null, deleted: false, kind: 'LEGAL', countryCode: 'KZ' });

    const dup: any = await cps.create(A, { name: 'Дубль', inn: a.inn }).catch((e) => e.response);
    expect(dup).toMatchObject({ code: 'COUNTERPARTY_DUPLICATE_BIN', message: expect.stringContaining(a.name), details: { counterpartyId: a.id } });
    const priv = await cp(A2, { organizationId: A2.organizationId });
    const hidden: any = await cps.create(A, { name: 'Дубль чужого', inn: priv.inn }).catch((e) => e.response);
    expect(hidden.code).toBe('COUNTERPARTY_DUPLICATE_BIN');
    expect(hidden.message).not.toContain(priv.name);
    expect(hidden.details).toBeUndefined();
    // Другой клиент — свой справочник: тот же БИН законен.
    expect((await cp(B, { inn: a.inn })).inn).toBe(a.inn);
    // Смена БИН — с проверкой дубля и записью в журнал.
    expect(await code(cps.update(A, priv.id, { inn: a.inn }))).toBe(404); // личный другой организации — не виден
    const b2 = await cp(A);
    expect(await code(cps.update(A, b2.id, { inn: a.inn }))).toBe('COUNTERPARTY_DUPLICATE_BIN');
    const nb = bin();
    await cps.update(A, b2.id, { inn: nb });
    expect(await prisma.auditLog.findFirst({ where: { entityId: b2.id, action: 'COUNTERPARTY_BIN_CHANGED' } })).toMatchObject({ after: { before: b2.inn, after: nb } });
  });

  it('нерезидент: своя страна и налоговый номер без проверки формата; резидент — только KZ', async () => {
    const nr = await cp(A, { kind: 'NONRESIDENT', countryCode: 'cn', inn: 'CN-91310000' });
    expect(nr).toMatchObject({ countryCode: 'CN', inn: 'CN-91310000' });
    expect(await code(cps.create(A, { name: 'x', kind: 'NONRESIDENT', countryCode: 'KZ' }))).toBe('COUNTRY');
    expect(await code(cps.create(A, { name: 'x', countryCode: 'RU', inn: bin() }))).toBe('COUNTRY');
    expect(await code(cps.create(A, { name: 'x', kbe: '33' }))).toBe('KBE_FORMAT');
  });

  it('адрес и счёт с датами действия: новый закрывает прежний, прошлое не переписывается, реквизиты на дату', async () => {
    const c = await cp(A);
    await cps.addAddress(A, c.id, { line: 'г. Астана, ул. Первая, 1', validFrom: '2025-01-01' });
    await cps.addAddress(A, c.id, { line: 'г. Алматы, пр. Абая, 10', validFrom: '2026-04-01' });
    await cps.addAddress(A, c.id, { kind: 'ACTUAL', line: 'г. Алматы, склад 3', validFrom: '2025-06-01' });
    expect(await code(cps.addAddress(A, c.id, { line: 'г. Шымкент, ул. Задним числом, 5', validFrom: '2026-01-01' }))).toBe('ADDRESS_BACKDATED');
    const card = await cps.findOne(A, c.id);
    expect(card.addresses.filter((x) => x.kind === 'LEGAL').map((x) => [x.line, x.validTo?.toISOString().slice(0, 10) ?? null])).toEqual([
      ['г. Алматы, пр. Абая, 10', null],
      ['г. Астана, ул. Первая, 1', '2026-03-31'],
    ]);
    expect((await cps.requisitesOn(A, c.id, '2026-03-31')).legalAddress!.line).toBe('г. Астана, ул. Первая, 1');
    expect((await cps.requisitesOn(A, c.id, '2026-04-01')).legalAddress!.line).toBe('г. Алматы, пр. Абая, 10');
    expect((await cps.requisitesOn(A, c.id, '2024-12-31')).legalAddress).toBeNull();

    expect(await code(cps.addBankAccount(A, c.id, { iban: 'KZ87125KZT5004100100', bik: 'HSBKKZKX', bankName: 'Банк' }))).toBe('IBAN_CHECK');
    const acc1 = await cps.addBankAccount(A, c.id, { iban: 'KZ86125KZT5004100100', bik: 'HSBKKZKX', bankName: 'Halyk', validFrom: '2025-01-01' });
    expect(acc1.isDefault).toBe(true); // первый в валюте — основной
    const acc2 = await cps.addBankAccount(A, c.id, { iban: 'KZ75125KZT2069100100', bik: 'KCJBKZKX', bankName: 'Bank CenterCredit', isDefault: true, validFrom: '2026-01-01' });
    expect((await prisma.counterpartyBankAccount.findUniqueOrThrow({ where: { id: acc1.id } })).isDefault).toBe(false);
    expect(await code(cps.addBankAccount(A, c.id, { iban: 'KZ86125KZT5004100100', bik: 'HSBKKZKX', bankName: 'Halyk' }))).toBe('IBAN_DUPLICATE');
    await cps.closeBankAccount(A, c.id, acc2.id, { validTo: '2026-06-30' });
    expect((await cps.requisitesOn(A, c.id, '2026-07-01')).bankAccount!.id).toBe(acc1.id);
    // 01.03.2026 действовали оба счёта; основным тогда был открытый позже (BCC) — он и выбирается.
    expect((await cps.requisitesOn(A, c.id, '2026-03-01')).bankAccount!.id).toBe(acc2.id);
    // Реквизиты чужого клиента — недоступны.
    expect(await code(cps.addAddress(B, c.id, { line: 'Чужой адрес, 1' }))).toBe(404);
  });
});

describe('FP-026: договоры организации — нет чужих ссылок', () => {
  async function setup() {
    const shared = await cp(A); // общий контрагент клиента — виден и A, и A2
    const other = await cp(A);
    const storeA = await stores.create(A, { name: `Склад ${uid()}` });
    const storeA2 = await stores.create(A2, { name: `Склад ${uid()}` });
    const k = await cps.createContract(A, shared.id, { number: `Д-${uid()}`, date: '2026-01-10', endDate: '2026-12-31', type: 'SALE' });
    return { shared, other, storeA, storeA2, k };
  }
  const order = (s: Scope, storeId: string, counterpartyId: string, contractId: string, date = '2026-10-30') =>
    runAsTenant(s.tenantId, () => sales.createOrder(s, { date, counterpartyId, contractId, storeId, items: [] }));

  it('договор видит и использует только его организация; номер уникален; дата обязательна', async () => {
    const w = await setup();
    expect(w.k).toMatchObject({ organizationId: A.organizationId, startDate: new Date('2026-01-10T00:00:00Z') });
    expect((await cps.findOne(A2, w.shared.id)).contracts).toEqual([]);
    expect(await cps.contracts(A2, w.shared.id)).toEqual([]);
    expect((await refs.contracts(ctxFor(A2.organizationId, A2.userId, 'chief_accountant'), w.shared.id))).toEqual([]);
    expect((await refs.contracts(ctxFor(A.organizationId, A.userId, 'chief_accountant'), w.shared.id)).map((c: any) => c.id)).toEqual([w.k.id]);
    expect(await code(cps.updateContract(A2, w.shared.id, w.k.id, { name: 'захват' }))).toBe(404);
    expect(await code(cps.createContract(A, w.shared.id, { number: w.k.number, date: '2026-02-01' }))).toBe('CONTRACT_DUPLICATE');
    expect(await code(cps.createContract(A, w.shared.id, { number: 'Без даты' }))).toBe('CONTRACT_DATE');
    expect(await code(cps.createContract(A, w.shared.id, { number: 'Наоборот', date: '2026-05-01', endDate: '2026-04-01' }))).toBe('CONTRACT_PERIOD');
    // Тот же номер у другой организации с тем же контрагентом — законно.
    expect((await cps.createContract(A2, w.shared.id, { number: w.k.number, date: '2026-02-01' })).organizationId).toBe(A2.organizationId);
  });

  it('торговый документ: чужая организация, чужой контрагент, вне срока, закрытый — отказ; свой в сроке — да', async () => {
    const w = await setup();
    expect((await order(A, w.storeA.id, w.shared.id, w.k.id)).contractId).toBe(w.k.id);
    expect(await code(order(A2, w.storeA2.id, w.shared.id, w.k.id))).toBe('REF_FOREIGN'); // договор организации A
    expect(await code(order(A, w.storeA.id, w.other.id, w.k.id))).toBe('REF_FOREIGN'); // договор другого контрагента
    expect(await code(order(A, w.storeA.id, w.shared.id, w.k.id, '2026-01-09'))).toBe('CONTRACT_NOT_EFFECTIVE');
    expect(await code(order(A, w.storeA.id, w.shared.id, w.k.id, '2027-01-01'))).toBe('CONTRACT_NOT_EFFECTIVE');
    await cps.updateContract(A, w.shared.id, w.k.id, { isActive: false });
    expect(await code(order(A, w.storeA.id, w.shared.id, w.k.id))).toBe('CONTRACT_INACTIVE');
    await cps.updateContract(A, w.shared.id, w.k.id, { isActive: true });
    // По договору есть документ на 30.10 — сократить срок до 30.09 или сменить валюту нельзя.
    expect(await code(cps.updateContract(A, w.shared.id, w.k.id, { endDate: '2026-09-30' }))).toBe('CONTRACT_IN_USE');
    expect(await code(cps.updateContract(A, w.shared.id, w.k.id, { currency: 'USD' }))).toBe('CONTRACT_IN_USE');
    expect((await cps.updateContract(A, w.shared.id, w.k.id, { endDate: '2027-12-31' })).endDate!.toISOString().slice(0, 10)).toBe('2027-12-31');
  });

  it('проводка: договор чужой организации, другого контрагента или вне срока — отказ', async () => {
    const w = await setup();
    const ctxA = ctxFor(A.organizationId, A.userId, 'chief_accountant');
    const ctxA2 = ctxFor(A2.organizationId, A2.userId, 'chief_accountant');
    const entry = (date: string, dims: Record<string, string>) => ({ sourceType: 'TEST', sourceId: uid(), sourceVersion: 1, ruleCode: 'T', ruleVersion: '1', date: new Date(date),
      postings: [{ account: '1210', side: 'D', amount: '100', dims }, { account: '5030', side: 'C', amount: '100' }] });
    const tx = <T>(fn: (t: Prisma.TransactionClient) => Promise<T>) => prisma.$transaction(async (t) => { await fn(t); throw new Error('ROLLBACK'); }).catch((e) => { if (e.message !== 'ROLLBACK') throw e; return 'OK'; });
    const posted = (ctx: any, e: any) => tx((t) => acc.posting.writeEntry(t, ctx, e));
    expect(await posted(ctxA, entry('2026-10-15', { COUNTERPARTY: w.shared.id, CONTRACT: w.k.id }))).toBe('OK');
    expect(await code(posted(ctxA2, entry('2026-10-15', { COUNTERPARTY: w.shared.id, CONTRACT: w.k.id })))).toBe('REF_FOREIGN');
    expect(await code(posted(ctxA, entry('2026-10-15', { COUNTERPARTY: w.other.id, CONTRACT: w.k.id })))).toBe('CONTRACT_COUNTERPARTY');
    expect(await code(posted(ctxA, entry('2025-12-31', { COUNTERPARTY: w.shared.id, CONTRACT: w.k.id })))).toBe('CONTRACT_NOT_EFFECTIVE');
  });
});
