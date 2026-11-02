// FP-029: пробное проведение (эффект без записи) и согласования, привязанные к версии/хэшу, организации и действию,
// сумме и сроку; изменение отменяет согласование; одноразовость; четыре глаза — на настоящей БД.
import { randomUUID } from 'crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { makeServices, makeOrg, makeTrade, ctxFor } from './accounting-helpers';

const prisma = new PrismaService();
const s = makeServices(prisma);
const manual = (rows: { amount: string; dr: string; cr: string }[]) => ({ lines: rows.map((r) => ({ amount: r.amount, debit: { account: r.dr }, credit: { account: r.cr } })) });
async function code(p: Promise<unknown>) {
  try { await p; return 'OK'; } catch (e: any) { return e?.response?.code ?? e?.message; }
}
async function colleague(ctx: { organizationId: string }, role = 'chief_accountant') {
  const user = await prisma.user.create({ data: { organizationId: ctx.organizationId, email: `ap-${randomUUID()}@test.local`, passwordHash: 'x', firstName: 'Второй', lastName: 'Сотрудник' } });
  await prisma.orgMembership.create({ data: { userId: user.id, organizationId: ctx.organizationId, role } });
  return ctxFor(ctx.organizationId, user.id, role);
}

beforeAll(async () => {
  await prisma.$connect();
  await s.chart.bootstrap();
});
afterAll(() => prisma.$disconnect());

describe('FP-029: пробное проведение', () => {
  it('торговый документ: проводки и движение остатка показаны, но ничего не записано', async () => {
    const ctx = await makeOrg(prisma);
    const t = await makeTrade(prisma, ctx, { vatPayer: false });
    const d = await s.trade.create(ctx, { docType: 'SUPPLY', date: '2026-10-01', counterpartyId: t.supplier.id, storeId: t.s1.id, lines: [{ productId: t.goods.id, qty: '10', price: '100' }] });
    const sim = await s.trade.simulate(ctx, d.id);
    expect(sim.error).toBeNull();
    expect(sim.entry.postings.map((p: any) => `${p.side}${p.account.code}:${p.amount}`).sort()).toEqual(['C3310:1000', 'D1330:1000'].sort());
    expect(sim.stock).toEqual([{ storeId: t.s1.id, productId: t.goods.id, before: '0', after: '10', change: '10' }]);
    expect(sim.approval).toMatchObject({ required: false, satisfied: true });
    // Ничего не записано: статус, остаток, проводки, история.
    expect((await prisma.document.findUniqueOrThrow({ where: { id: d.id } })).status).toBe('DRAFT');
    expect(await prisma.stock.count({ where: { productId: t.goods.id, storeId: t.s1.id, qty: { not: 0 } } })).toBe(0);
    expect(await prisma.accEntry.count({ where: { sourceId: d.id } })).toBe(0);
    expect((await s.trade.versions(ctx, d.id)).map((v) => v.action)).toEqual(['CREATE']);

    // Отгрузка больше остатка — проблема видна заранее, документ не тронут.
    const sale = await s.trade.create(ctx, { docType: 'DEMAND', date: '2026-10-02', counterpartyId: t.customer.id, storeId: t.s1.id, lines: [{ productId: t.goods.id, qty: '5', price: '200' }] });
    const bad = await s.trade.simulate(ctx, sale.id);
    expect(bad.error ?? bad.issue).toBeTruthy();
    expect((await prisma.document.findUniqueOrThrow({ where: { id: sale.id } })).status).toBe('DRAFT');
  });

  it('бухгалтерский документ: проводки; закрытый период — причина видна, документ не тронут', async () => {
    const ctx = await makeOrg(prisma);
    const d = await s.docs.create(ctx, { docType: 'MANUAL_OPERATION', date: '2026-10-03', body: manual([{ amount: '250', dr: '7170', cr: '5030' }]) });
    const sim = await s.docs.simulate(ctx, d.id);
    expect(sim.error).toBeNull();
    expect(sim.entry.postings.map((p: any) => `${p.side}${p.account.code}:${p.amount}`).sort()).toEqual(['C5030:250', 'D7170:250'].sort());
    expect(await prisma.accEntry.count({ where: { sourceId: d.id } })).toBe(0);
    expect((await prisma.accDocument.findUniqueOrThrow({ where: { id: d.id } })).status).toBe('DRAFT');
    await prisma.accPeriodLock.create({ data: { organizationId: ctx.organizationId, lockedUntil: new Date('2026-10-31') } });
    const locked = await s.docs.simulate(ctx, d.id);
    expect(locked.error).toMatchObject({ code: 'PERIOD_CLOSED' });
    expect(locked.entry).toBeNull();
  });
});

describe('FP-029: согласования', () => {
  async function setup(minAmount = '1000') {
    const ctx = await makeOrg(prisma, 'accountant');
    const boss = await colleague(ctx);
    const t = await makeTrade(prisma, ctx, { vatPayer: false });
    await s.approvals.createPolicy(boss, { docKind: 'TRADE', docType: '*', minAmount, ttlHours: 2 });
    const doc = (qty: string) => s.trade.create(ctx, { docType: 'SUPPLY', date: '2026-10-01', counterpartyId: t.supplier.id, storeId: t.s1.id, lines: [{ productId: t.goods.id, qty, price: '100' }] });
    return { ctx, boss, t, doc };
  }

  it('ниже порога — без согласования; выше — требуется, четыре глаза, согласованная версия проводится один раз', async () => {
    const { ctx, boss, doc } = await setup();
    const small = await doc('5'); // 500
    expect((await s.trade.post(ctx, small.id)).status).toBe('POSTED');

    const big = await doc('15'); // 1500
    expect((await s.trade.simulate(ctx, big.id)).approval).toMatchObject({ required: true, satisfied: false, policy: { minAmount: '1000.00', ttlHours: 2 } });
    expect(await code(s.trade.post(ctx, big.id))).toBe('APPROVAL_REQUIRED');
    expect(await code(s.approvals.request(ctx, { docKind: 'TRADE', docId: big.id, note: 'Поставка' }))).toBe('VERSION_CONFLICT'); // без версии
    const a = await s.approvals.request(ctx, { docKind: 'TRADE', docId: big.id, expectedVersion: 1, note: 'Поставка' });
    expect(a).toMatchObject({ status: 'PENDING', docVersion: 1, amount: expect.anything(), contentHash: expect.stringMatching(/^[0-9a-f]{64}$/), ttlHours: 2 });
    expect((await s.approvals.request(ctx, { docKind: 'TRADE', docId: big.id, expectedVersion: 1 })).id).toBe(a.id); // повтор — то же
    expect(await code(s.trade.post(ctx, big.id))).toBe('APPROVAL_PENDING');
    expect(await code(s.approvals.decide(ctx, a.id, { decision: 'APPROVE' }))).toBe('FOUR_EYES');
    const ok = await s.approvals.decide(boss, a.id, { decision: 'APPROVE', note: 'Сверено' });
    expect(ok.status).toBe('APPROVED');
    expect(ok.expiresAt!.getTime() - ok.decidedAt!.getTime()).toBe(2 * 3600_000);
    expect(await code(s.approvals.decide(boss, a.id, { decision: 'REJECT', note: 'передумал' }))).toBe('APPROVAL_DECIDED');
    expect((await s.trade.simulate(ctx, big.id)).approval).toMatchObject({ required: true, satisfied: true });

    // Экран перед проведением сохраняет документ: сохранение без изменений — не новая версия, согласование в силе.
    const saved = await s.trade.update(ctx, big.id, { expectedVersion: 1, lines: [{ productId: big.lines[0].productId, qty: '15', price: '100' }] });
    expect(saved.version).toBe(1);
    expect((await prisma.approval.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('APPROVED');
    expect((await s.trade.post(ctx, big.id, undefined, 1)).status).toBe('POSTED');
    expect((await prisma.approval.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('CONSUMED');
    // Одноразовое: снять проведение и провести снова — нужно новое согласование.
    await s.trade.unpost(ctx, big.id);
    expect(await code(s.trade.post(ctx, big.id))).toBe('APPROVAL_REQUIRED');
  });

  it('изменение документа отменяет согласование; подмена в обход сервиса, просрочка и другая сумма — не пропускают', async () => {
    const { ctx, boss, t, doc } = await setup();
    const d = await doc('20');
    const a1 = await s.approvals.request(ctx, { docKind: 'TRADE', docId: d.id, expectedVersion: 1 });
    await s.approvals.decide(boss, a1.id, { decision: 'APPROVE' });
    await s.trade.update(ctx, d.id, { expectedVersion: 1, lines: [{ productId: t.goods.id, qty: '30', price: '100' }] });
    expect((await prisma.approval.findUniqueOrThrow({ where: { id: a1.id } })).status).toBe('SUPERSEDED');
    expect(await code(s.trade.post(ctx, d.id))).toBe('APPROVAL_REQUIRED');

    // Согласовано, затем строки черновика изменены в обход сервиса (без отмены согласования) — хэш не совпал.
    const a2 = await s.approvals.request(ctx, { docKind: 'TRADE', docId: d.id, expectedVersion: 2 });
    await s.approvals.decide(boss, a2.id, { decision: 'APPROVE' });
    await prisma.documentLine.updateMany({ where: { documentId: d.id }, data: { price: 1 } });
    expect(await code(s.trade.post(ctx, d.id))).toBe('APPROVAL_STALE');
    expect((await s.trade.simulate(ctx, d.id)).approval).toMatchObject({ required: true, satisfied: false });
    await prisma.documentLine.updateMany({ where: { documentId: d.id }, data: { price: 100 } });

    // Изменение после запроса и до решения — решение не выдаётся на другое содержимое.
    const a3 = await s.approvals.request(ctx, { docKind: 'TRADE', docId: d.id, expectedVersion: 2 });
    expect(a3.id).toBe(a2.id); // содержимое снова как согласовано — то же согласование
    const priced = await prisma.documentLine.updateMany({ where: { documentId: d.id }, data: { price: 2 } });
    expect(priced.count).toBe(1);
    const a3b = await s.approvals.request(ctx, { docKind: 'TRADE', docId: d.id, expectedVersion: 2 });
    expect(a3b.id).not.toBe(a2.id); // другое содержимое — новый запрос, прежнее согласование отменено
    expect((await prisma.approval.findUniqueOrThrow({ where: { id: a2.id } })).status).toBe('SUPERSEDED');
    await prisma.documentLine.updateMany({ where: { documentId: d.id }, data: { price: 100 } });
    expect(await code(s.approvals.decide(boss, a3b.id, { decision: 'APPROVE' }))).toBe('APPROVAL_STALE');
    await prisma.documentLine.updateMany({ where: { documentId: d.id }, data: { price: 2 } });
    await prisma.documentLine.updateMany({ where: { documentId: d.id }, data: { price: 100 } });

    // Просрочка и подменённая сумма согласования.
    const a4 = await s.approvals.request(ctx, { docKind: 'TRADE', docId: d.id, expectedVersion: 2 });
    await s.approvals.decide(boss, a4.id, { decision: 'APPROVE' });
    await prisma.approval.update({ where: { id: a4.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await code(s.trade.post(ctx, d.id))).toBe('APPROVAL_EXPIRED');
    await prisma.approval.update({ where: { id: a4.id }, data: { expiresAt: new Date(Date.now() + 3600_000), amount: 1 } });
    expect(await code(s.trade.post(ctx, d.id))).toBe('APPROVAL_AMOUNT_MISMATCH');
    await prisma.approval.update({ where: { id: a4.id }, data: { amount: 3000 } });
    expect((await s.trade.post(ctx, d.id)).status).toBe('POSTED');
  });

  it('отказ — с причиной; область: согласование и документ другой организации недоступны; бухгалтерский документ по виду', async () => {
    const { ctx, boss, t, doc } = await setup('0');
    const d = await doc('1');
    const a = await s.approvals.request(ctx, { docKind: 'TRADE', docId: d.id, expectedVersion: 1 });
    expect(await code(s.approvals.decide(boss, a.id, { decision: 'REJECT' }))).toBe('REASON_REQUIRED');
    expect((await s.approvals.decide(boss, a.id, { decision: 'REJECT', note: 'Нет договора' })).status).toBe('REJECTED');
    expect(await code(s.trade.post(ctx, d.id))).toBe('APPROVAL_REQUIRED');

    const other = await makeOrg(prisma);
    expect(await code(s.approvals.request(other, { docKind: 'TRADE', docId: d.id, expectedVersion: 1 }))).toBe('DOC_NOT_FOUND');
    const a2 = await s.approvals.request(ctx, { docKind: 'TRADE', docId: d.id, expectedVersion: 1 });
    expect(await code(s.approvals.decide(await colleague(other), a2.id, { decision: 'APPROVE' }))).toBe('NOT_FOUND');

    // Бухгалтерские документы: правило только для BANK_OUT — ручная операция без согласования, платёж — с ним.
    await s.approvals.createPolicy(boss, { docKind: 'ACC', docType: 'BANK_OUT', minAmount: '0', ttlHours: 1 });
    const m = await s.docs.create(ctx, { docType: 'MANUAL_OPERATION', date: '2026-10-03', body: manual([{ amount: '10', dr: '7170', cr: '5030' }]) });
    expect((await s.docs.post(ctx, m.id)).status).toBe('POSTED');
    const pay = await s.docs.create(ctx, { docType: 'BANK_OUT', date: '2026-10-03', body: { bankAccountId: t.bank.id, operation: 'SUPPLIER', counterpartyId: t.supplier.id, amount: '99.00' } });
    expect(await code(s.docs.post(ctx, pay.id))).toBe('APPROVAL_REQUIRED');
    const pa = await s.approvals.request(ctx, { docKind: 'ACC', docId: pay.id, expectedVersion: pay.version });
    await s.approvals.decide(boss, pa.id, { decision: 'APPROVE' });
    // Сохранение без изменений (как делает экран перед проведением) — версия та же, согласование в силе.
    expect((await s.docs.update(ctx, pay.id, { expectedVersion: pay.version, body: pay.body })).version).toBe(pay.version);
    const posted: any = await s.docs.post(ctx, pay.id).catch((e) => e.response);
    expect(posted.status).toBe('POSTED');
    expect((await prisma.approval.findUniqueOrThrow({ where: { id: pa.id } })).status).toBe('CONSUMED');
  });
});
