// FP-019 приёмка «Quarter/year/amount/remainder/rule version; нельзя автоматически зачесть весь VAT при download».
import { PrismaService } from '../src/prisma/prisma.service';
import { VatCreditService, VAT_CREDIT_RULE } from '../src/modules/accounting/vat/vat-credit.service';
import { makeServices, makeOrg, makeTrade } from './accounting-helpers';

const prisma = new PrismaService();
const s = makeServices(prisma);
const vat = new VatCreditService(prisma, s.posting, s.periods);

async function code(p: Promise<unknown>) {
  try { await p; return 'OK'; } catch (e: any) { return e?.response?.code ?? e?.code ?? e?.message; }
}

let n = 0;
/** Организация-плательщик НДС и входящий ЭСФ: НДС 1600, оборот 15.07.2026 (3 квартал). */
async function setup(over: Record<string, unknown> = {}, opts: { vatPayer?: boolean } = {}) {
  const ctx = await makeOrg(prisma);
  const t = await makeTrade(prisma, ctx, { vatPayer: opts.vatPayer ?? true });
  const esfId = BigInt(Date.now()) * 1000n + BigInt(n++);
  const inv = await prisma.esfInvoice.create({
    data: {
      organizationId: ctx.organizationId, direction: 'INBOUND', invoiceType: 'ORDINARY_INVOICE', num: String(esfId), date: new Date('2026-07-15'), turnoverDate: new Date('2026-07-15'),
      counterpartyId: t.supplier.id, totalWithoutTax: 10000, totalNds: 1600, totalWithTax: 11600, status: 'DELIVERED', esfStatus: 'DELIVERED', esfId,
      registrationNumber: `ESF-987654321098-20260715-${esfId % 10000n}`, body: '<x/>', bodyHash: 'h', ...over,
    },
  });
  return { ctx, t, inv };
}
const credit = (ctx: any, esfInvoiceId: string, b: Record<string, unknown>) =>
  vat.allocate(ctx, { esfInvoiceId, kind: 'CREDIT', year: 2026, quarter: 3, method: 'MANUAL', basis: 'Товар используется в облагаемом обороте', ...b } as any);

beforeAll(async () => {
  await prisma.$connect();
  await s.chart.bootstrap();
});
afterAll(async () => prisma.$disconnect());

describe('FP-019: НДС к зачёту — только явным распределением', () => {
  it('получение ЭСФ ничего не зачитывает: строк регистра нет, весь НДС — остаток', async () => {
    const { ctx, inv } = await setup();
    const led = await vat.ledger(ctx, inv.id);
    expect([led.credited, led.nonCreditable, led.remainder, led.allocations.length]).toEqual(['0.00', '0.00', '1600.00', 0]);
    expect((await vat.register(ctx, 2026, 3)).rows).toHaveLength(0);
  });

  it('частичный зачёт по кварталам: доля, ручная сумма, остаток, правило и версия в каждой строке', async () => {
    const { ctx, inv } = await setup();
    const p = await credit(ctx, inv.id, { method: 'PROPORTIONAL', shareNumerator: '7000', shareDenominator: '10000' });
    expect([p.amount.toFixed(2), p.year, p.quarter, p.ruleCode, p.ruleVersion]).toEqual(['1120.00', 2026, 3, VAT_CREDIT_RULE.code, VAT_CREDIT_RULE.version]);
    expect((await vat.ledger(ctx, inv.id)).remainder).toBe('480.00');
    await credit(ctx, inv.id, { quarter: 4, amount: '300' });
    expect(await code(credit(ctx, inv.id, { quarter: 4, amount: '200' }))).toBe('VAT_OVER_ALLOCATION'); // остаток 180
    const full = await credit(ctx, inv.id, { quarter: 4, method: 'FULL' });
    expect(full.amount.toFixed(2)).toBe('180.00');
    const led = await vat.ledger(ctx, inv.id);
    expect([led.credited, led.remainder]).toEqual(['1600.00', '0.00']);
    expect(await code(credit(ctx, inv.id, { quarter: 4, method: 'FULL' }))).toBe('VAT_AMOUNT'); // распределять нечего
    const q3 = await vat.register(ctx, 2026, 3);
    const q4 = await vat.register(ctx, 2026, 4);
    expect([q3.credited, q4.credited]).toEqual(['1120.00', '480.00']);
  });

  it('условия правила: не зарегистрирован, отозван, не подтверждённый дополнительный, раньше квартала оборота, не плательщик НДС', async () => {
    const unregistered = await setup({ registrationNumber: null });
    expect(await code(credit(unregistered.ctx, unregistered.inv.id, { amount: '100' }))).toBe('VAT_NOT_ELIGIBLE');
    const revoked = await setup({ status: 'REVOKED', esfStatus: 'REVOKED' });
    expect(await code(credit(revoked.ctx, revoked.inv.id, { amount: '100' }))).toBe('VAT_NOT_ELIGIBLE');
    const additional = await setup({ invoiceType: 'ADDITIONAL_INVOICE', status: 'WAITING_CUSTOMER_CONFIRMATION', esfStatus: 'WAITING_CUSTOMER_CONFIRMATION' });
    expect(await code(credit(additional.ctx, additional.inv.id, { amount: '100' }))).toBe('VAT_NOT_ELIGIBLE');
    await prisma.esfInvoice.update({ where: { id: additional.inv.id }, data: { businessDecision: 'APPROVED', status: 'DELIVERED', esfStatus: 'DELIVERED' } });
    expect(await code(credit(additional.ctx, additional.inv.id, { amount: '100' }))).toBe('OK'); // после решения FP-018
    const early = await setup();
    expect(await code(credit(early.ctx, early.inv.id, { quarter: 2, amount: '100' }))).toBe('VAT_NOT_ELIGIBLE');
    const notPayer = await setup({}, { vatPayer: false });
    expect(await code(credit(notPayer.ctx, notPayer.inv.id, { amount: '100' }))).toBe('VAT_NOT_ELIGIBLE');
    expect(await code(credit(early.ctx, early.inv.id, { amount: '100', basis: '' }))).toBe('VAT_BASIS');
  });

  it('дополнительный ЭСФ на уменьшение: отрицательная корректировка, знак проверяется', async () => {
    const { ctx, inv } = await setup({ invoiceType: 'ADDITIONAL_INVOICE', totalNds: -160, totalWithoutTax: -1000, totalWithTax: -1160, businessDecision: 'APPROVED' });
    expect(await code(credit(ctx, inv.id, { amount: '160' }))).toBe('VAT_OVER_ALLOCATION');
    const r = await credit(ctx, inv.id, { amount: '-160' });
    expect(r.amount.toFixed(2)).toBe('-160.00');
    expect((await vat.ledger(ctx, inv.id)).remainder).toBe('0.00');
  });

  it('не к зачёту — в расходы проводкой; сторно — новой строкой и обратной проводкой, исходная строка не меняется', async () => {
    const { ctx, inv } = await setup();
    await expect(s.posting.balance(prisma as any, ctx.organizationId, '1420', new Date('2026-12-31'))).resolves.toBeDefined();
    const nc = await vat.allocate(ctx, { esfInvoiceId: inv.id, kind: 'NON_CREDITABLE', year: 2026, quarter: 3, method: 'MANUAL', amount: '400', basis: 'Товар для необлагаемого оборота', expenseAccount: '7210', date: '2026-09-30' });
    const posted = await prisma.accPosting.findMany({ where: { entryId: nc.entryId! }, include: { account: true }, orderBy: { lineNo: 'asc' } });
    expect(posted.map((p) => [p.account.code, p.side, p.amount.toFixed(2)])).toEqual([['7210', 'D', '400.00'], ['1420', 'C', '400.00']]);
    expect(await code(vat.allocate(ctx, { esfInvoiceId: inv.id, kind: 'NON_CREDITABLE', year: 2026, quarter: 3, method: 'MANUAL', amount: '1', basis: 'дата не в квартале', expenseAccount: '7210', date: '2026-10-01' }))).toBe('VAT_PERIOD');

    expect(await code(vat.reverse(ctx, nc.id, { basis: 'ош', year: 2026, quarter: 2 }))).toBe('VAT_BASIS');
    expect(await code(vat.reverse(ctx, nc.id, { basis: 'Ошибка в отнесении', year: 2026, quarter: 2 }))).toBe('VAT_PERIOD'); // раньше исходного
    const rev = await vat.reverse(ctx, nc.id, { basis: 'Ошибка в отнесении', year: 2026, quarter: 4, date: '2026-10-05' });
    expect([rev.kind, rev.amount.toFixed(2), rev.reversedId, rev.quarter]).toEqual(['REVERSAL', '-400.00', nc.id, 4]);
    const back = await prisma.accPosting.findMany({ where: { entryId: rev.entryId! }, include: { account: true }, orderBy: { lineNo: 'asc' } });
    expect(back.map((p) => [p.account.code, p.side])).toEqual([['7210', 'C'], ['1420', 'D']]);
    expect((await prisma.vatCreditAllocation.findUniqueOrThrow({ where: { id: nc.id } })).amount.toFixed(2)).toBe('400.00');
    expect(await code(vat.reverse(ctx, nc.id, { basis: 'Повторное сторно', year: 2026, quarter: 4, date: '2026-10-06' }))).toBe('VAT_REVERSAL');
    expect((await vat.ledger(ctx, inv.id)).remainder).toBe('1600.00');
  });

  it('регистр неизменяем в БД: изменить или удалить строку нельзя даже владельцу таблиц', async () => {
    const { ctx, inv } = await setup();
    const r = await credit(ctx, inv.id, { amount: '100' });
    await expect(prisma.vatCreditAllocation.update({ where: { id: r.id }, data: { amount: 1600 } })).rejects.toThrow(/неизменяем/);
    await expect(prisma.vatCreditAllocation.delete({ where: { id: r.id } })).rejects.toThrow(/неизменяем/);
  });

  it('два одновременных «весь остаток» — зачитывается один раз', async () => {
    const { ctx, inv } = await setup();
    const results = await Promise.all([credit(ctx, inv.id, { method: 'FULL' }).then(() => 'OK', (e) => e?.response?.code), credit(ctx, inv.id, { method: 'FULL' }).then(() => 'OK', (e) => e?.response?.code)]);
    expect(results.sort()).toEqual(['OK', 'VAT_AMOUNT']);
    expect((await vat.ledger(ctx, inv.id)).credited).toBe('1600.00');
  });
});
