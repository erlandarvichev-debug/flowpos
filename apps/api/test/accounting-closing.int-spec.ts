import { PrismaService } from '../src/prisma/prisma.service';
import * as ExcelJS from 'exceljs';
import { makeServices, makeOrg, makeTrade } from './accounting-helpers';
import { toPdf, toXlsx } from '../src/modules/accounting/statements/statement-export';

const prisma = new PrismaService();
const s = makeServices(prisma);

async function expectCode(p: Promise<any>, code: string) {
  await expect(p).rejects.toMatchObject({ response: expect.objectContaining({ code }) });
}
const val = (st: any, code: string) => Number(st.lines.find((l: any) => l.code === code)?.current ?? 'NaN');
const rate = (date: string, r: string) =>
  prisma.currencyRate.upsert({ where: { currencyCode_date: { currencyCode: 'USD', date: new Date(date) } }, create: { currencyCode: 'USD', date: new Date(date), rate: r }, update: { rate: r } });

beforeAll(async () => {
  await prisma.$connect();
  await s.chart.bootstrap();
});
afterAll(async () => prisma.$disconnect());

describe('Этап 3: закрытие месяца → сверка ОСВ, склада, денег, прибыли; повторное закрытие воспроизводимо', () => {
  it('ноябрь: переоценка, баланс/ОПиУ/ДДС сходятся; открытие и повторное закрытие дают те же итоги; декабрь — финрезультат года', async () => {
    const ctx = await makeOrg(prisma);
    const t = await makeTrade(prisma, ctx, { vatPayer: true });
    const usd = await prisma.orgBankAccount.create({ data: { organizationId: ctx.organizationId, name: 'USD', iban: `KZ${String(Date.now()).slice(-10)}USD00000`, bic: 'HSBKKZKX', bankName: 'Банк', currency: 'USD' } });
    const post = async (docType: string, date: string, body: any) => s.docs.post(ctx, (await s.docs.create(ctx, { docType, date, body })).id);

    // Начальные остатки 31.10: банк 1 000 000 / вклад учредителя
    const ob = await s.docs.create(ctx, { docType: 'OPENING_BALANCE', date: '2026-10-31', body: { lines: [
      { account: '1030', side: 'D', amount: '1000000.00', dims: { BANK_ACCOUNT: t.bank.id }, ledger: 'BU' },
      { account: '5030', side: 'C', amount: '1000000.00', ledger: 'BU' },
    ] } });
    await s.docs.post(ctx, ob.id);

    // Ноябрь
    await rate('2026-11-02', '500');
    await post('BANK_IN', '2026-11-03', { bankAccountId: usd.id, operation: 'CUSTOMER', counterpartyId: t.customer.id, currencyAmount: '1000.00' }); // аванс 1000 USD = 500 000 ₸
    await s.trade.create(ctx, { docType: 'SUPPLY', date: '2026-11-05', counterpartyId: t.supplier.id, storeId: t.s1.id, lines: [{ productId: t.goods.id, qty: '10', price: '1160' }], status: 'POSTED' });
    await s.trade.create(ctx, { docType: 'DEMAND', date: '2026-11-10', counterpartyId: t.customer.id, storeId: t.s1.id, lines: [{ productId: t.goods.id, qty: '4', price: '2320' }], status: 'POSTED' });
    await rate('2026-11-30', '520'); // доллар подорожал: 1000 × 20 = +20 000 ₸ курсовой доход

    let st = await s.closing.status(ctx, '2026-11');
    expect(st.canClose).toBe(true);
    expect(st.steps.find((x: any) => x.code === 'RATES')!.status).toBe('ok');
    expect(st.actions.join(' ')).toMatch(/переоценить валютные остатки/);

    const c1 = await s.closing.close(ctx, '2026-11');
    expect(c1.closed).toBe(true);
    expect(c1.summary.revaluation).toMatchObject({ gain: '20000.00', loss: '0.00' });
    // аванс покупателя покрыл реализацию 9 280: деньги 1 000 000 + 520 000
    expect(c1.summary.cash).toBe('1520000.00');
    expect(c1.summary.stock).toBe('6000.00'); // 10 по 1000 − 4 списано
    expect(c1.summary.vatPayable).toBe('-320.00'); // НДС к уплате 1280 − к зачёту 1600
    expect(c1.summary.grossProfitYtd).toBe('4000.00');
    expect(c1.summary.profitYtd).toBe('24000.00'); // 4000 валовая + 20 000 курсовая
    expect(c1.summary.turnover.debit).toBe(c1.summary.turnover.credit);

    // Баланс на 30.11 сходится; ОПиУ и ДДС сверяются
    const bs = await s.statements.balance(ctx, { date: '2026-11-30' });
    expect(bs.checks.every((c: any) => c.ok)).toBe(true);
    expect(val(bs, '010')).toBe(1520000);
    expect(val(bs, '020')).toBe(6000);
    expect(val(bs, '214')).toBe(11600); // долг поставщику
    expect(val(bs, '219')).toBe(500000 - 9280); // остаток аванса покупателя (по курсу получения — неденежная статья)
    expect(val(bs, '414')).toBe(24000); // незакрытая прибыль года
    expect(val(bs, 'BA')).toBe(val(bs, 'BP'));
    const pl = await s.statements.profitLoss(ctx, { from: '2026-11-01', to: '2026-11-30' });
    expect(pl.checks.every((c: any) => c.ok)).toBe(true);
    expect([val(pl, '010'), val(pl, '011'), val(pl, '012'), val(pl, '024'), val(pl, '300')]).toEqual([8000, 4000, 4000, 20000, 24000]);
    const cf = await s.statements.cashFlow(ctx, { from: '2026-11-01', to: '2026-11-30' });
    expect(cf.checks.every((c: any) => c.ok)).toBe(true);
    expect([val(cf, '013'), val(cf, '120'), val(cf, '150'), val(cf, '160')]).toEqual([500000, 20000, 1000000, 1520000]);

    // Закрытый месяц не меняется
    await expectCode(post('BANK_OUT', '2026-11-15', { bankAccountId: t.bank.id, operation: 'COMMISSION', amount: '10.00' }), 'PERIOD_CLOSED');
    await expectCode(s.closing.close(ctx, '2026-11'), 'ALREADY_CLOSED');

    // Открыть (с причиной) и закрыть снова — те же итоги и те же закрывающие проводки
    await expectCode(s.closing.reopen(ctx, '2026-11', ''), 'REASON_REQUIRED');
    await s.closing.reopen(ctx, '2026-11', 'проверка воспроизводимости');
    expect((await s.closing.status(ctx, '2026-11')).closed).toBe(false);
    const c2 = await s.closing.close(ctx, '2026-11');
    expect(c2.reproducible).toBe(true);
    expect(c2.summary.closingEntries).toBe(c1.summary.closingEntries);

    // Декабрь: доллар подешевел (−10 000), закрытие года переносит прибыль на 5610
    await rate('2026-12-31', '510');
    const c3 = await s.closing.close(ctx, '2026-12');
    expect(c3.summary.revaluation).toMatchObject({ gain: '0.00', loss: '10000.00' });
    expect(c3.summary.finResult!.result).toBe('14000.00'); // 8000 − 4000 + 20 000 − 10 000
    const bsY = await s.statements.balance(ctx, { date: '2026-12-31' });
    expect(bsY.checks.every((c: any) => c.ok)).toBe(true);
    expect(val(bsY, '414')).toBe(14000);
    const tb = await s.reports.trialBalance(ctx, { from: '2026-12-01', to: '2026-12-31' });
    const acct = (code: string) => (tb.lines as any[]).find((l) => l.code === code);
    expect(acct('5610').closing.credit).toBe('14000.00');
    expect(['6010', '6130', '7010', '7130', '5710'].map((c) => acct(c)?.closing ?? { debit: '0.00', credit: '0.00' })).toEqual(Array(5).fill({ debit: '0.00', credit: '0.00' }));
    // ОПиУ за год не теряет обороты из-за закрывающих проводок
    const plY = await s.statements.profitLoss(ctx, { from: '2026-01-01', to: '2026-12-31' });
    expect(val(plY, '300')).toBe(14000);
    expect(plY.checks.every((c: any) => c.ok)).toBe(true);
    // в тысячах тенге итоги сходятся с допуском округления
    const bsK = await s.statements.balance(ctx, { date: '2026-12-31', unit: 'THOUSANDS' });
    expect(bsK.checks.every((c: any) => c.ok)).toBe(true);
    expect(val(bsK, '010')).toBe(1510); // 1 510 000 ₸

    // Выгрузка: XLSX читается обратно с теми же числами, PDF валиден
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await toXlsx(bsY)) as any);
    const rows = wb.worksheets[0].getSheetValues() as any[];
    const r010 = rows.find((r) => r && r[2] === '010');
    expect(r010[3]).toBe(1510000);
    expect(String(rows[1][1])).toMatch(/Бухгалтерский баланс/);
    const pdf = await toPdf(cf);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(5000);
  });

  it('блокирующие проблемы не дают закрыть месяц: отрицательный остаток денег', async () => {
    const ctx = await makeOrg(prisma);
    const t = await makeTrade(prisma, ctx, { vatPayer: false });
    const eur = await prisma.orgBankAccount.create({ data: { organizationId: ctx.organizationId, name: 'EUR', iban: `KZ${String(Date.now()).slice(-10)}EUR00000`, bic: 'HSBKKZKX', bankName: 'Банк', currency: 'EUR' } });
    await prisma.currencyRate.upsert({ where: { currencyCode_date: { currencyCode: 'EUR', date: new Date('2031-03-02') } }, create: { currencyCode: 'EUR', date: new Date('2031-03-02'), rate: '600' }, update: {} });
    await s.docs.post(ctx, (await s.docs.create(ctx, { docType: 'BANK_IN', date: '2031-03-03', body: { bankAccountId: eur.id, operation: 'OTHER', corrAccount: '5030', currencyAmount: '10.00' } })).id);
    await s.docs.post(ctx, (await s.docs.create(ctx, { docType: 'BANK_OUT', date: '2031-03-04', body: { bankAccountId: t.bank.id, operation: 'COMMISSION', amount: '500.00' } })).id);
    const st = await s.closing.status(ctx, '2031-04');
    expect(st.steps.find((x: any) => x.code === 'NEGATIVE_CASH')!.status).toBe('error');
    expect(st.canClose).toBe(false);
    const err = await s.closing.close(ctx, '2031-04').catch((e) => e.response);
    expect(err.code).toBe('CLOSE_BLOCKED');
    expect(err.fix).toMatch(/Кредитовое сальдо/);
  });
});

describe('Эквайринг 1020 → 1030', () => {
  it('оплаты картами: деньги в пути зачисляются банком за вычетом комиссии; мастер закрытия видит незачисленное', async () => {
    const ctx = await makeOrg(prisma);
    const t = await makeTrade(prisma, ctx, { vatPayer: false });
    const post = async (docType: string, date: string, body: any) => s.docs.post(ctx, (await s.docs.create(ctx, { docType, date, body })).id);
    await s.trade.create(ctx, { docType: 'RETAIL_DEMAND', date: '2032-02-10', storeId: t.s2.id, status: 'POSTED', paymentType: 'CARD', lines: [{ productId: t.service.id, qty: '1', price: '2320' }] });
    let st = await s.closing.status(ctx, '2032-02');
    expect(st.steps.find((x: any) => x.code === 'CASH_IN_TRANSIT')).toMatchObject({ status: 'warn' });

    const acq = await post('BANK_IN', '2032-02-11', { bankAccountId: t.bank.id, operation: 'ACQUIRING', amount: '2273.60', commission: '46.40' });
    expect(acq.entry!.postings.map((p: any) => `${p.side}${p.account.code}:${p.amount}`).sort()).toEqual(['C1020:2320', 'D1030:2273.6', 'D7020:46.4'].sort());
    st = await s.closing.status(ctx, '2032-02');
    expect(st.steps.find((x: any) => x.code === 'CASH_IN_TRANSIT')).toMatchObject({ status: 'ok' });
    // ДДС: зачисление по картам — поступление от реализации (через 1020 — внутреннее перемещение не считается дважды)
    const cf = await s.statements.cashFlow(ctx, { from: '2032-02-01', to: '2032-02-29' });
    expect(cf.checks.every((c: any) => c.ok)).toBe(true);
    expect(val(cf, '011')).toBe(2320);
    expect(val(cf, '027')).toBe(46.4);
    expect(val(cf, '160')).toBe(2273.6);
  });
});
