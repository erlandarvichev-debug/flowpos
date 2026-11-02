// FP-036: выписка — ключ строки на счёте (номер операции банка или содержимое + номер повтора в файле), дубли не
// зачисляются дважды (повтор, параллельная загрузка), оборванная загрузка дозачисляется; разнесение оплат по документам
// расчётов (автоматически от старого, вручную), журнал разнесений и отмен (неизменяем, с причиной, аудит) — на БД.
import { Prisma } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { OrgContext } from '../src/modules/accounting/access/org-context';
import { makeServices, makeOrg, makeTrade } from './accounting-helpers';

const prisma = new PrismaService();
const s = makeServices(prisma);
const D = Prisma.Decimal;

async function code(p: Promise<unknown>) {
  try { await p; return 'OK'; } catch (e: any) {
    return e?.response?.code ?? String(e?.meta?.message ?? e?.message).match(/\b(ACC_IMMUTABLE): /)?.[1] ?? e?.code ?? e?.message;
  }
}
const credited = async (ctx: OrgContext, bankAccountId: string) =>
  (await prisma.accDocument.findMany({ where: { organizationId: ctx.organizationId, docType: 'BANK_IN', status: { not: 'CANCELLED' }, body: { path: ['bankAccountId'], equals: bankAccountId } } }))
    .reduce((a, d) => a.plus(d.amount), new D(0)).toFixed(2);
const allocs = (paymentDocId: string, status?: string) => prisma.paymentAllocation.findMany({ where: { paymentDocId, ...(status ? { status } : {}) }, orderBy: [{ createdAt: 'asc' }, { amount: 'desc' }] });

beforeAll(async () => {
  await prisma.$connect();
  await s.chart.bootstrap();
});
afterAll(() => prisma.$disconnect());

async function world() {
  const ctx = await makeOrg(prisma);
  const t = await makeTrade(prisma, ctx, { vatPayer: false });
  return { ctx, t };
}

describe('FP-036: выписка — ключ строки и дубли', () => {
  it('две одинаковые оплаты за день — обе; повторная загрузка — ни одной; номер операции банка — ключ; другой счёт — свой ключ', async () => {
    const { ctx, t } = await world();
    const head = 'Дата;Номер документа;Контрагент;БИН/ИИН;Дебет;Кредит;Назначение платежа;КНП';
    const row = `05.10.2026;;ТОО Покупатель;${t.customer.inn};;1 000,00;Оплата по счёту;710`;
    const csv = `${head}\n${row}\n${row}\n`;
    const pv = await s.bank.preview(ctx, { bankAccountId: t.bank.id, csv });
    expect(pv.rows.map((r: any) => [r.occurrence, r.duplicate])).toEqual([[1, false], [2, false]]);
    expect(await s.bank.commit(ctx, { bankAccountId: t.bank.id, csv })).toMatchObject({ created: 2, posted: 2 });
    expect(await credited(ctx, t.bank.id)).toBe('2000.00');
    expect(await s.bank.commit(ctx, { bankAccountId: t.bank.id, csv })).toMatchObject({ created: 0, skipped: 2 });
    // В следующей выписке те же две строки + третья такая же — только третья новая.
    expect(await s.bank.commit(ctx, { bankAccountId: t.bank.id, csv: `${csv}${row}\n` })).toMatchObject({ created: 1, skipped: 2 });
    expect(await credited(ctx, t.bank.id)).toBe('3000.00');

    // Номер операции банка: одинаковое содержимое, разные номера — разные строки; тот же номер в другой выписке — дубль.
    const refHead = `${head};Референс`;
    const r1 = `07.10.2026;;ТОО Покупатель;${t.customer.inn};;500,00;Оплата;710;OP-1`, r2 = `07.10.2026;;ТОО Покупатель;${t.customer.inn};;500,00;Оплата;710;OP-2`;
    expect(await s.bank.commit(ctx, { bankAccountId: t.bank.id, csv: `${refHead}\n${r1}\n${r2}\n` })).toMatchObject({ created: 2 });
    expect(await s.bank.commit(ctx, { bankAccountId: t.bank.id, csv: `${refHead}\n${r2}\n` })).toMatchObject({ created: 0, skipped: 1 });
    expect(await credited(ctx, t.bank.id)).toBe('4000.00');
    // Новый номер операции при том же содержимом — новая строка (ключ — номер, а не содержимое).
    const r3 = `07.10.2026;;ТОО Покупатель;${t.customer.inn};;500,00;Оплата;710;OP-3`;
    expect(await s.bank.commit(ctx, { bankAccountId: t.bank.id, csv: `${refHead}\n${r3}\n` })).toMatchObject({ created: 1 });
    expect(await credited(ctx, t.bank.id)).toBe('4500.00');

    // Другой счёт — свои ключи (та же операция в выписке другого счёта — его движение).
    const bank2 = await prisma.orgBankAccount.create({ data: { organizationId: ctx.organizationId, name: 'Банк 2', iban: 'KZ86125KZT5004100199', bic: 'HSBKKZKX', bankName: 'Тестовый банк' } });
    expect(await s.bank.commit(ctx, { bankAccountId: bank2.id, csv })).toMatchObject({ created: 2 });
  });

  it('параллельная загрузка одной выписки — без дублей; оборванная загрузка дозачисляется при повторе', async () => {
    const { ctx, t } = await world();
    const csv = `Дата;Контрагент;БИН/ИИН;Кредит;Назначение платежа\n${[1, 2, 3, 4].map((i) => `0${i}.10.2026;ТОО Покупатель;${t.customer.inn};${i}00,00;Оплата ${i}`).join('\n')}\n`;
    const res = await Promise.allSettled([s.bank.commit(ctx, { bankAccountId: t.bank.id, csv }), s.bank.commit(ctx, { bankAccountId: t.bank.id, csv })]);
    expect(res.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(await credited(ctx, t.bank.id)).toBe('1000.00');
    expect(await prisma.accBankStatementLine.count({ where: { bankAccountId: t.bank.id } })).toBe(4);

    // Обрыв: строка записана, документа нет (как после падения процесса) — повтор загрузки создаёт документ.
    const one = `Дата;Контрагент;БИН/ИИН;Кредит;Назначение платежа\n09.10.2026;ТОО Покупатель;${t.customer.inn};700,00;Оплата 7\n`;
    const pv = await s.bank.preview(ctx, { bankAccountId: t.bank.id, csv: one });
    await prisma.accBankStatementLine.create({ data: { organizationId: ctx.organizationId, bankAccountId: t.bank.id, batchId: 'crashed', hash: pv.rows[0].hash, date: new Date('2026-10-09'), direction: 'IN', amount: 700 } });
    expect((await s.bank.preview(ctx, { bankAccountId: t.bank.id, csv: one })).rows[0]).toMatchObject({ resume: true, duplicate: false });
    expect(await s.bank.commit(ctx, { bankAccountId: t.bank.id, csv: one })).toMatchObject({ created: 1, resumed: 1 });
    expect(await credited(ctx, t.bank.id)).toBe('1700.00');
    expect(await s.bank.commit(ctx, { bankAccountId: t.bank.id, csv: one })).toMatchObject({ created: 0 });

    // Обрыв после создания документа, до отметки строки: документ уже есть — берётся он, второй не создаётся.
    const two = `Дата;Контрагент;БИН/ИИН;Кредит;Назначение платежа\n10.10.2026;ТОО Покупатель;${t.customer.inn};800,00;Оплата 8\n`;
    const h = (await s.bank.preview(ctx, { bankAccountId: t.bank.id, csv: two })).rows[0].hash;
    await prisma.accBankStatementLine.create({ data: { organizationId: ctx.organizationId, bankAccountId: t.bank.id, batchId: 'crashed', hash: h, date: new Date('2026-10-10'), direction: 'IN', amount: 800 } });
    const made = await s.docs.create(ctx, { docType: 'BANK_IN', date: '2026-10-10', body: { bankAccountId: t.bank.id, operation: 'CUSTOMER', counterpartyId: t.customer.id, amount: '800' }, externalSource: 'BANK_STATEMENT', externalId: `${t.bank.id}:${h}` } as any);
    expect(await s.bank.commit(ctx, { bankAccountId: t.bank.id, csv: two })).toMatchObject({ resumed: 1, posted: 1 });
    expect(await prisma.accDocument.count({ where: { externalSource: 'BANK_STATEMENT', externalId: `${t.bank.id}:${h}` } })).toBe(1);
    expect((await prisma.accBankStatementLine.findFirstOrThrow({ where: { bankAccountId: t.bank.id, hash: h } })).documentId).toBe(made.id);
    expect(await credited(ctx, t.bank.id)).toBe('2500.00');
  });
});

describe('FP-036: разнесение оплат', () => {
  async function sales() {
    const { ctx, t } = await world();
    await s.trade.create(ctx, { docType: 'SUPPLY', date: '2026-09-30', counterpartyId: t.supplier.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '100', price: '1' }] });
    const sale = (date: string, price: string) => s.trade.create(ctx, { docType: 'DEMAND', date, counterpartyId: t.customer.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '1', price }] });
    const s1 = await sale('2026-10-01', '1000'), s2 = await sale('2026-10-02', '500');
    const pay = (amount: string, extra: any = {}) => s.docs.create(ctx, { docType: 'BANK_IN', date: '2026-10-05', body: { bankAccountId: t.bank.id, operation: 'CUSTOMER', counterpartyId: t.customer.id, amount, ...extra } });
    const open = async () => (await s.posting.openItems(prisma as any, ctx.organizationId, '1210', new Date('2026-12-31'), { COUNTERPARTY: t.customer.id })).map((x) => [x.settlementDocId, x.balance.toFixed(2)]).sort();
    return { ctx, t, s1, s2, pay, open };
  }

  it('автоматически — от самого старого документа, остаток — аванс; журнал разнесений', async () => {
    const { ctx, s1, s2, pay, open } = await sales();
    // Частичная оплата: сначала самая старая (1000), остаток — на следующую.
    const p = await pay('1200');
    await s.docs.post(ctx, p.id);
    expect((await allocs(p.id, 'ACTIVE')).map((a) => [a.kind, a.settlementDocId, a.amount.toFixed(2), a.manual])).toEqual([
      ['DEBT', s1.id, '1000.00', false], ['DEBT', s2.id, '200.00', false],
    ]);
    expect(await open()).toEqual([[s2.id, '300.00']]);
    const p1 = await pay('500');
    await s.docs.post(ctx, p1.id);
    expect((await allocs(p1.id, 'ACTIVE')).map((a) => [a.kind, a.settlementDocId, a.amount.toFixed(2)])).toEqual([['DEBT', s2.id, '300.00'], ['ADVANCE', null, '200.00']]);
    expect(await open()).toEqual([]);
    const p2 = await pay('50');
    expect(await code(s.docs.post(ctx, p2.id))).toBe('OK');
    expect((await allocs(p2.id, 'ACTIVE')).map((a) => a.kind)).toEqual(['ADVANCE']);
    expect(await prisma.auditLog.count({ where: { entityId: p.id, action: 'PAYMENT_ALLOCATED' } })).toBe(1);
  });

  it('вручную — на выбранные документы; проверки; изменение и снятие отменяют прежние строки с причиной (аудит)', async () => {
    const { ctx, t, s1, s2, pay, open } = await sales();
    expect(await code(s.docs.post(ctx, (await pay('300', { allocations: [{ docId: s1.id, amount: '0' }] })).id))).toBe('ALLOC_BAD_AMOUNT');
    expect(await code(s.docs.post(ctx, (await pay('300', { allocations: [{ docId: t.goods.id, amount: '10' }] })).id))).toBe('ALLOC_NOT_OPEN');
    expect(await code(s.docs.post(ctx, (await pay('300', { allocations: [{ docId: s2.id, amount: '600' }] })).id))).toBe('ALLOC_EXCEEDS_DEBT');
    expect(await code(s.docs.post(ctx, (await pay('300', { allocations: [{ docId: s1.id, amount: '200' }, { docId: s2.id, amount: '200' }] })).id))).toBe('ALLOC_EXCEEDS_PAYMENT');
    expect(await code(s.docs.post(ctx, (await pay('300', { allocations: [{ docId: s2.id, amount: '100' }, { docId: s2.id, amount: '100' }] })).id))).toBe('ALLOC_DUPLICATE');

    // Оплата 300: 250 — на вторую реализацию (вручную), 50 — аванс. Старая (первая) не тронута.
    const p = await pay('300', { allocations: [{ docId: s2.id, amount: '250' }] });
    await s.docs.post(ctx, p.id);
    expect((await allocs(p.id, 'ACTIVE')).map((a) => [a.kind, a.settlementDocId, a.amount.toFixed(2), a.manual])).toEqual([['DEBT', s2.id, '250.00', true], ['ADVANCE', null, '50.00', false]]);
    expect(await open()).toEqual([[s1.id, '1000.00'], [s2.id, '250.00']].sort());

    // Перенос разнесения: изменение проведённого платежа (с причиной) — прежние строки отменены, новые действуют.
    const fresh = await prisma.accDocument.findUniqueOrThrow({ where: { id: p.id } });
    await s.docs.update(ctx, p.id, { expectedVersion: fresh.version, reason: 'Покупатель уточнил назначение', body: { ...(fresh.body as any), allocations: [{ docId: s1.id, amount: '300' }] } } as any);
    const rev = await allocs(p.id, 'REVERSED');
    expect(rev.map((a) => [a.settlementDocId, a.reverseReason, !!a.reversedAt, a.reversedBy])).toEqual([[s2.id, 'Покупатель уточнил назначение', true, ctx.userId], [null, 'Покупатель уточнил назначение', true, ctx.userId]]);
    expect((await allocs(p.id, 'ACTIVE')).map((a) => [a.settlementDocId, a.amount.toFixed(2)])).toEqual([[s1.id, '300.00']]);
    // Реализацию с разнесённой оплатой не снять.
    expect(await code(s.trade.unpost(ctx, s1.id))).toBe('PAYMENTS_ALLOCATED');
    expect(await code(s.trade.unpost(ctx, s2.id))).toBe('OK'); // на неё больше ничего не разнесено

    // Снятие проведения платежа — разнесения отменены с причиной.
    await s.docs.unpost(ctx, p.id, { reason: 'Ошибочно проведён' });
    expect(await allocs(p.id, 'ACTIVE')).toEqual([]);
    expect((await prisma.auditLog.findMany({ where: { entityId: p.id, action: { in: ['PAYMENT_ALLOCATED', 'PAYMENT_ALLOCATION_REVERSED'] } }, orderBy: { ts: 'asc' } })).map((a) => [a.action, a.reason]))
      .toEqual([['PAYMENT_ALLOCATED', 'Проведение'], ['PAYMENT_ALLOCATED', 'Покупатель уточнил назначение'], ['PAYMENT_ALLOCATION_REVERSED', 'Ошибочно проведён']]);

    // Журнал неизменяем в БД: сумму не поменять, строку не удалить, отмена — только с причиной.
    const any = (await allocs(p.id))[0];
    expect(await code(prisma.paymentAllocation.update({ where: { id: any.id }, data: { amount: 1 } }))).toBe('ACC_IMMUTABLE');
    expect(await code(prisma.paymentAllocation.delete({ where: { id: any.id } }))).toBe('ACC_IMMUTABLE');
    await s.docs.post(ctx, p.id);
    const act = (await allocs(p.id, 'ACTIVE'))[0];
    expect(await code(prisma.paymentAllocation.update({ where: { id: act.id }, data: { status: 'REVERSED', reversedAt: new Date() } }))).toBe('ACC_IMMUTABLE');
    // Отмена с причиной, но с подменой суммы — тоже нельзя.
    expect(await code(prisma.paymentAllocation.update({ where: { id: act.id }, data: { status: 'REVERSED', reversedAt: new Date(), reverseReason: 'Ошибка', amount: 1 } }))).toBe('ACC_IMMUTABLE');
  });
});
