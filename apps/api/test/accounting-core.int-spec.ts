import { PrismaService } from '../src/prisma/prisma.service';
import { makeServices, makeOrg, makeBankAndCash, manual, ctxFor } from './accounting-helpers';

const prisma = new PrismaService();
const s = makeServices(prisma);

async function expectCode(p: Promise<any>, code: string) {
  await expect(p).rejects.toMatchObject({ response: expect.objectContaining({ code }) });
}

beforeAll(async () => {
  await prisma.$connect();
  await s.chart.bootstrap();
});
afterAll(async () => prisma.$disconnect());

describe('Бухгалтерское ядро: двойная запись', () => {
  it('проводит сбалансированную операцию и ОСВ сходится до тиына', async () => {
    const ctx = await makeOrg(prisma);
    const { bank, cash } = await makeBankAndCash(prisma, ctx);
    const doc = await s.docs.create(ctx, {
      docType: 'MANUAL_OPERATION', date: '2026-10-05',
      body: manual([
        { amount: '1000000.00', dr: '1030', cr: '5030', drDims: { BANK_ACCOUNT: bank.id } },
        { amount: '0.01', dr: '1010', cr: '1030', drDims: { CASHBOX: cash.id }, crDims: { BANK_ACCOUNT: bank.id } },
      ]),
    });
    const posted = await s.docs.post(ctx, doc.id);
    expect(posted.status).toBe('POSTED');
    expect(posted.entry!.postings).toHaveLength(4);
    const tb = await s.reports.trialBalance(ctx, { from: '2026-10-01', to: '2026-10-31' });
    expect(tb.balanced).toBe(true);
    expect(tb.totals.turnover).toEqual({ debit: '1000000.01', credit: '1000000.01' });
    const r1030 = tb.lines.find((l) => l.code === '1030')!;
    expect(r1030.closing.debit).toBe('999999.99');
  });

  it('отклоняет несбалансированную, групповой счёт и проводку без обязательной аналитики', async () => {
    const ctx = await makeOrg(prisma);
    const unbalanced = await s.docs.create(ctx, {
      docType: 'OPENING_BALANCE', date: '2026-01-01', body: { lines: [{ account: '7170', side: 'D', amount: '0' }] },
    });
    await expectCode(s.docs.post(ctx, unbalanced.id), 'ZERO_AMOUNT');
    const group = await s.docs.create(ctx, { docType: 'MANUAL_OPERATION', date: '2026-10-01', body: manual([{ amount: '10', dr: '1', cr: '5030' }]) });
    await expectCode(s.docs.post(ctx, group.id), 'ACCOUNT_IS_GROUP');
    const noDim = await s.docs.create(ctx, { docType: 'MANUAL_OPERATION', date: '2026-10-01', body: manual([{ amount: '10', dr: '1030', cr: '5030' }]) });
    await expectCode(s.docs.post(ctx, noDim.id), 'DIM_REQUIRED');
    const fractional = await s.docs.create(ctx, { docType: 'MANUAL_OPERATION', date: '2026-10-01', body: manual([{ amount: '10.001', dr: '7170', cr: '5030' }]) });
    await expectCode(s.docs.post(ctx, fractional.id), 'BAD_AMOUNT');
    expect(await prisma.accPosting.count({ where: { organizationId: ctx.organizationId } })).toBe(0);
  });

  it('БД сама запрещает несбалансированную запись, изменение и удаление проводок', async () => {
    const ctx = await makeOrg(prisma);
    const acc = await prisma.accAccount.findFirst({ where: { code: '7170', organizationId: null } });
    const entry = await prisma.accEntry.create({
      data: { organizationId: ctx.organizationId, sourceType: 'TEST', sourceId: 'x', sourceVersion: 1, ruleCode: 'T', ruleVersion: '1', date: new Date() },
    });
    await expect(
      prisma.accPosting.create({ data: { entryId: entry.id, organizationId: ctx.organizationId, date: new Date(), lineNo: 1, side: 'D', accountId: acc!.id, amount: '5' } }),
    ).rejects.toThrow(/ACC_UNBALANCED/);

    const ok = await makeOrg(prisma);
    const d = await s.docs.create(ok, { docType: 'MANUAL_OPERATION', date: '2026-10-02', body: manual([{ amount: '100', dr: '7170', cr: '5030' }]) });
    await s.docs.post(ok, d.id);
    const p = await prisma.accPosting.findFirst({ where: { organizationId: ok.organizationId } });
    await expect(prisma.accPosting.update({ where: { id: p!.id }, data: { amount: '200' } })).rejects.toThrow(/ACC_IMMUTABLE/);
    await expect(prisma.accPosting.delete({ where: { id: p!.id } })).rejects.toThrow(/ACC_IMMUTABLE/);
    const v = await prisma.accDocumentVersion.findFirst({ where: { documentId: d.id } });
    await expect(prisma.accDocumentVersion.update({ where: { id: v!.id }, data: { reason: 'подмена' } })).rejects.toThrow(/ACC_IMMUTABLE/);
  });
});

describe('Идемпотентность и конкуренция', () => {
  it('повторное проведение не создаёт дублей, параллельные проведения дают одну активную запись', async () => {
    const ctx = await makeOrg(prisma);
    const d = await s.docs.create(ctx, { docType: 'MANUAL_OPERATION', date: '2026-10-03', body: manual([{ amount: '777.77', dr: '7170', cr: '5030' }]) });
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => s.docs.post(ctx, d.id)));
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    await s.docs.post(ctx, d.id);
    const active = await prisma.accEntry.count({ where: { organizationId: ctx.organizationId, status: 'ACTIVE' } });
    const all = await prisma.accEntry.count({ where: { organizationId: ctx.organizationId } });
    expect(active).toBe(1);
    expect(all).toBe(1);
    expect(await prisma.accPosting.count({ where: { organizationId: ctx.organizationId, isActive: true } })).toBe(2);
  });

  it('параллельное создание документов даёт уникальные номера', async () => {
    const ctx = await makeOrg(prisma);
    const docs = await Promise.all(
      Array.from({ length: 10 }, () => s.docs.create(ctx, { docType: 'MANUAL_OPERATION', date: '2026-10-03', body: manual([{ amount: '1', dr: '7170', cr: '5030' }]) })),
    );
    expect(new Set(docs.map((d) => d.number)).size).toBe(10);
  });

  it('конфликт версий при одновременном редактировании', async () => {
    const ctx = await makeOrg(prisma);
    const d = await s.docs.create(ctx, { docType: 'MANUAL_OPERATION', date: '2026-10-03', body: manual([{ amount: '1', dr: '7170', cr: '5030' }]) });
    await s.docs.update(ctx, d.id, { expectedVersion: 1, comment: 'первый' });
    await expectCode(s.docs.update(ctx, d.id, { expectedVersion: 1, comment: 'второй' }), 'VERSION_CONFLICT');
  });
});

describe('Исправления сохраняют историю', () => {
  it('изменение проведённого документа требует причину, перепроводит и хранит прежнюю запись', async () => {
    const ctx = await makeOrg(prisma);
    const d = await s.docs.create(ctx, { docType: 'MANUAL_OPERATION', date: '2026-10-03', body: manual([{ amount: '100', dr: '7170', cr: '5030' }]) });
    await s.docs.post(ctx, d.id);
    await expectCode(s.docs.update(ctx, d.id, { expectedVersion: 1, body: manual([{ amount: '150', dr: '7170', cr: '5030' }]) }), 'REASON_REQUIRED');
    const u = await s.docs.update(ctx, d.id, { expectedVersion: 1, body: manual([{ amount: '150', dr: '7170', cr: '5030' }]), reason: 'ошибка в сумме' });
    expect(u.version).toBe(2);
    const entries = await prisma.accEntry.findMany({ where: { organizationId: ctx.organizationId }, orderBy: { createdAt: 'asc' } });
    expect(entries.map((e) => e.status)).toEqual(['SUPERSEDED', 'ACTIVE']);
    const tb = await s.reports.trialBalance(ctx, { from: '2026-10-01', to: '2026-10-31' });
    expect(tb.totals.turnover.debit).toBe('150.00');
    const full = await s.docs.get(ctx, d.id);
    expect(full.versions.map((v) => v.action)).toEqual(['CREATE', 'POST', 'UPDATE']);
    expect(full.versions[2].reason).toBe('ошибка в сумме');
  });

  it('сторно обнуляет обороты, исходный документ остаётся и не может быть распроведён', async () => {
    const ctx = await makeOrg(prisma);
    const d = await s.docs.create(ctx, { docType: 'MANUAL_OPERATION', date: '2026-10-03', body: manual([{ amount: '500', dr: '7170', cr: '5030' }]) });
    await s.docs.post(ctx, d.id);
    const st = await s.docs.storno(ctx, d.id, { date: '2026-10-20', reason: 'ошибочная операция' });
    expect(st.docType).toBe('STORNO');
    expect(st.entry!.postings.every((p) => p.amount.isNegative())).toBe(true);
    const tb = await s.reports.trialBalance(ctx, { from: '2026-10-01', to: '2026-10-31' });
    expect(tb.lines.find((l) => l.code === '7170')!.closing).toEqual({ debit: '0.00', credit: '0.00' });
    await expectCode(s.docs.unpost(ctx, d.id), 'DOC_STORNOED');
    await expectCode(s.docs.storno(ctx, d.id, { date: '2026-10-21', reason: 'ещё раз' }), 'DOC_STORNOED');
  });
});

describe('Закрытие периода', () => {
  it('закрытый период нельзя изменить без права и причины; переопределение пишется в аудит', async () => {
    const chief = await makeOrg(prisma, 'chief_accountant');
    const acc = ctxFor(chief.organizationId, chief.userId, 'accountant');
    const d = await s.docs.create(chief, { docType: 'MANUAL_OPERATION', date: '2026-09-15', body: manual([{ amount: '100', dr: '7170', cr: '5030' }]) });
    await s.periods.setLock(chief, '2026-09-30');
    await expectCode(s.docs.post(chief, d.id), 'PERIOD_CLOSED');
    await expectCode(s.docs.post(acc, d.id, { override: { reason: 'хочу' } }), 'PERIOD_OVERRIDE_FORBIDDEN');
    const ok = await s.docs.post(chief, d.id, { override: { reason: 'исправление по акту сверки' } });
    expect(ok.status).toBe('POSTED');
    const audit = await prisma.auditLog.findFirst({ where: { organizationId: chief.organizationId, action: 'PERIOD_OVERRIDE' } });
    expect(audit?.reason).toBe('исправление по акту сверки');
    // Открытый период работает
    const d2 = await s.docs.create(chief, { docType: 'MANUAL_OPERATION', date: '2026-10-01', body: manual([{ amount: '1', dr: '7170', cr: '5030' }]) });
    expect((await s.docs.post(chief, d2.id)).status).toBe('POSTED');
    // Переоткрыть может только с правом и причиной
    await expectCode(s.periods.setLock(ctxFor(chief.organizationId, chief.userId, 'admin'), '2026-08-31', 'надо'), 'PERIOD_OVERRIDE_FORBIDDEN');
    await expectCode(s.periods.setLock(chief, '2026-08-31'), 'REASON_REQUIRED');
  });
});

describe('Границы периода', () => {
  it('проводка первого и последнего дня попадает в обороты, а не в сальдо (без сдвига часового пояса)', async () => {
    const ctx = await makeOrg(prisma);
    for (const date of ['2026-09-30', '2026-10-01', '2026-10-31', '2026-11-01']) {
      const d = await s.docs.create(ctx, { docType: 'MANUAL_OPERATION', date, body: manual([{ amount: '1', dr: '7170', cr: '5030' }]) });
      await s.docs.post(ctx, d.id);
    }
    const tb = await s.reports.trialBalance(ctx, { from: '2026-10-01', to: '2026-10-31' });
    const r = tb.lines.find((l) => l.code === '7170')!;
    expect(r.opening.debit).toBe('1.00');
    expect(r.turnover.debit).toBe('2.00');
    const card = await s.reports.accountCard(ctx, { account: '7170', from: '2026-10-01', to: '2026-10-31' });
    expect(card.lines).toHaveLength(2);
    expect(card.opening.debit).toBe('1.00');
  });
});

describe('Изоляция организаций', () => {
  it('документы и справочники другой организации недоступны', async () => {
    const a = await makeOrg(prisma);
    const b = await makeOrg(prisma);
    const { cash } = await makeBankAndCash(prisma, a);
    const d = await s.docs.create(a, { docType: 'MANUAL_OPERATION', date: '2026-10-03', body: manual([{ amount: '1', dr: '7170', cr: '5030' }]) });
    await expectCode(s.docs.get(b, d.id), 'DOC_NOT_FOUND');
    await expectCode(s.docs.post(b, d.id), 'DOC_NOT_FOUND');
    await expectCode(
      s.docs.create(b, { docType: 'MANUAL_OPERATION', date: '2026-10-03', body: manual([{ amount: '1', dr: '1010', cr: '5030', drDims: { CASHBOX: cash.id } }]) }),
      'REF_FOREIGN',
    );
    await s.docs.post(a, d.id);
    const tbB = await s.reports.trialBalance(b, { from: '2026-01-01', to: '2026-12-31' });
    expect(tbB.lines).toHaveLength(0);
  });
});

describe('Начальные остатки', () => {
  it('сбалансированный ввод остатков закрывает 0000, несбалансированный — даёт предупреждение', async () => {
    const ctx = await makeOrg(prisma);
    const { bank } = await makeBankAndCash(prisma, ctx);
    const d = await s.docs.create(ctx, {
      docType: 'OPENING_BALANCE', date: '2025-12-31',
      body: { lines: [
        { account: '1030', side: 'D', amount: '250000', dims: { BANK_ACCOUNT: bank.id } },
        { account: '5030', side: 'C', amount: '250000' },
      ] },
    });
    await s.docs.post(ctx, d.id);
    let tb = await s.reports.trialBalance(ctx, { from: '2026-01-01', to: '2026-01-31' });
    expect(tb.warnings).toEqual([]);
    expect(tb.lines.find((l) => l.code === '1030')!.opening.debit).toBe('250000.00');
    const bad = await s.docs.create(ctx, { docType: 'OPENING_BALANCE', date: '2025-12-31', body: { lines: [{ account: '7170', side: 'D', amount: '10' }] } });
    await s.docs.post(ctx, bad.id);
    tb = await s.reports.trialBalance(ctx, { from: '2026-01-01', to: '2026-01-31' });
    expect(tb.warnings.join(' ')).toMatch(/0000/);
  });
});
