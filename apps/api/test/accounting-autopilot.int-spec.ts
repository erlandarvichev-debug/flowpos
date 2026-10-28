import { PrismaService } from '../src/prisma/prisma.service';
import { makeServices, makeOrg, makeTrade } from './accounting-helpers';

const prisma = new PrismaService();
const s = makeServices(prisma);

async function expectCode(p: Promise<any>, code: string) {
  await expect(p).rejects.toMatchObject({ response: expect.objectContaining({ code }) });
}
const line = (tb: any, code: string) => tb.lines.find((l: any) => l.code === code) ?? { opening: { debit: '0.00', credit: '0.00' }, turnover: { debit: '0.00', credit: '0.00' }, closing: { debit: '0.00', credit: '0.00' } };

beforeAll(async () => {
  await prisma.$connect();
  await s.chart.bootstrap();
});
afterAll(async () => prisma.$disconnect());

describe('Сквозной сценарий: покупка → оплата → продажа → оплата → возврат → закрытие', () => {
  it('сверка ОСВ, склада, денег, прибыли и НДС (плательщик НДС 16%, цены с НДС)', async () => {
    const ctx = await makeOrg(prisma);
    const t = await makeTrade(prisma, ctx, { vatPayer: true });

    // 1. Начальные остатки
    const ob = await s.docs.create(ctx, { docType: 'OPENING_BALANCE', date: '2026-09-30', body: { lines: [
      { account: '1030', side: 'D', amount: '1000000.00', dims: { BANK_ACCOUNT: t.bank.id }, ledger: 'BU' },
      { account: '5030', side: 'C', amount: '1000000.00', ledger: 'BU' },
    ] } });
    await s.docs.post(ctx, ob.id);

    // 2. Покупка 10 шт × 1 160 (с НДС)
    const supply = await s.trade.create(ctx, { docType: 'SUPPLY', date: '2026-10-02', counterpartyId: t.supplier.id, storeId: t.s1.id, lines: [{ productId: t.goods.id, qty: '10', price: '1160' }], status: 'POSTED' });
    expect(supply.entry!.postings.map((p: any) => `${p.side}${p.account.code}:${p.amount}`).sort()).toEqual(['C3310:11600', 'D1330:10000', 'D1420:1600'].sort());

    // 3. Оплата поставщику
    const pay = await s.docs.create(ctx, { docType: 'BANK_OUT', date: '2026-10-03', body: { bankAccountId: t.bank.id, operation: 'SUPPLIER', counterpartyId: t.supplier.id, amount: '11600.00' } });
    await s.docs.post(ctx, pay.id);

    // 4. Продажа 4 шт × 2 320 (с НДС)
    const sale = await s.trade.create(ctx, { docType: 'DEMAND', date: '2026-10-05', counterpartyId: t.customer.id, storeId: t.s1.id, lines: [{ productId: t.goods.id, qty: '4', price: '2320' }], status: 'POSTED' });
    expect(sale.entry!.postings.map((p: any) => `${p.side}${p.account.code}:${p.amount}`).sort()).toEqual(['D1210:9280', 'C6010:8000', 'C3130:1280'].sort());
    expect(sale.costEntries.flatMap((e: any) => e.postings.map((p: any) => `${p.side}${p.account.code}:${p.amount}`)).sort()).toEqual(['D7010:4000', 'C1330:4000'].sort());

    // 5. Оплата покупателя 10 000: 9 280 закрывает долг, 720 — аванс
    const inc = await s.docs.create(ctx, { docType: 'BANK_IN', date: '2026-10-06', body: { bankAccountId: t.bank.id, operation: 'CUSTOMER', counterpartyId: t.customer.id, amount: '10000.00' } });
    const incPosted = await s.docs.post(ctx, inc.id);
    expect(incPosted.entry!.postings.map((p: any) => `${p.side}${p.account.code}:${p.amount}`).sort()).toEqual(['D1030:10000', 'C1210:9280', 'C3510:720'].sort());

    // 6. Возврат 1 шт от покупателя
    const ret = await s.trade.create(ctx, { docType: 'SALES_RETURN', date: '2026-10-07', counterpartyId: t.customer.id, storeId: t.s1.id, lines: [{ productId: t.goods.id, qty: '1', price: '2320' }], status: 'POSTED' });
    expect(ret.costEntries.flatMap((e: any) => e.postings.map((p: any) => `${p.side}${p.account.code}:${p.amount}`)).sort()).toEqual(['D1330:1000', 'C7010:1000'].sort());

    // 7. Закрытие месяца
    await s.periods.setLock(ctx, '2026-10-31');
    const tb = await s.reports.trialBalance(ctx, { from: '2026-10-01', to: '2026-10-31' });
    expect(tb.balanced).toBe(true);
    expect(tb.warnings).toEqual([]);
    // Склад: 7 шт по 1 000
    const stock = await s.reports.stock(ctx, { date: '2026-10-31' });
    expect(stock.lines).toHaveLength(1);
    expect(stock.lines[0]).toMatchObject({ quantity: '7.000', amount: '7000.00', unitCost: '1000.00' });
    expect(line(tb, '1330').closing.debit).toBe('7000.00');
    // Деньги
    expect(line(tb, '1030').closing.debit).toBe('998400.00');
    // Прибыль: выручка 8 000 − возврат 2 000; себестоимость 4 000 − 1 000 → валовая прибыль 3 000
    expect(line(tb, '6010').turnover.credit).toBe('8000.00');
    expect(line(tb, '6020').closing.debit).toBe('2000.00');
    expect(line(tb, '7010').closing.debit).toBe('3000.00');
    // НДС: к уплате 1 280 − 320 = 960, к зачёту 1 600
    expect(line(tb, '3130').closing.credit).toBe('960.00');
    expect(line(tb, '1420').closing.debit).toBe('1600.00');
    // Расчёты
    const st = await s.reports.settlements(ctx, { date: '2026-10-31' });
    const cust = st.lines.find((l: any) => l.counterpartyId === t.customer.id);
    expect(cust).toMatchObject({ receivable: '-2320.00', advanceReceived: '720.00' });
    expect(st.lines.find((l: any) => l.counterpartyId === t.supplier.id)).toBeUndefined();

    // 8. Закрытый период: документ в октябре не проводится, повторный пересчёт себестоимости ничего не меняет
    await expectCode(s.trade.create(ctx, { docType: 'DEMAND', date: '2026-10-20', counterpartyId: t.customer.id, storeId: t.s1.id, lines: [{ productId: t.goods.id, qty: '1', price: '2320' }], status: 'POSTED' }), 'PERIOD_CLOSED');
    const before = await prisma.accEntry.count({ where: { organizationId: ctx.organizationId } });
    await prisma.$transaction((tx) => s.cost.recalcProducts(tx, ctx, [t.goods.id]));
    expect(await prisma.accEntry.count({ where: { organizationId: ctx.organizationId } })).toBe(before);
  });
});

describe('Себестоимость', () => {
  it('FIFO: поступление задним числом пересчитывает себестоимость продажи, история сохраняется', async () => {
    const ctx = await makeOrg(prisma);
    const t = await makeTrade(prisma, ctx, { vatPayer: false });
    await s.trade.create(ctx, { docType: 'SUPPLY', date: '2026-10-01', counterpartyId: t.supplier.id, storeId: t.s1.id, lines: [{ productId: t.goods.id, qty: '10', price: '100' }], status: 'POSTED' });
    const sale = await s.trade.create(ctx, { docType: 'DEMAND', date: '2026-10-10', counterpartyId: t.customer.id, storeId: t.s1.id, lines: [{ productId: t.goods.id, qty: '5', price: '300' }], status: 'POSTED' });
    expect(sale.costEntries[0]!.postings.find((p: any) => p.side === 'D')!.amount.toString()).toBe('500');
    await s.trade.create(ctx, { docType: 'SUPPLY', date: '2026-09-30', counterpartyId: t.supplier.id, storeId: t.s1.id, lines: [{ productId: t.goods.id, qty: '5', price: '200' }], status: 'POSTED' });
    const after = await s.trade.get(ctx, sale.id);
    expect(after.costEntries[0]!.postings.find((p: any) => p.side === 'D')!.amount.toString()).toBe('1000');
    const superseded = await prisma.accEntry.count({ where: { organizationId: ctx.organizationId, sourceType: 'COST', status: 'SUPERSEDED' } });
    expect(superseded).toBe(1);
    const stock = await s.reports.stock(ctx, {});
    expect(stock.lines[0]).toMatchObject({ quantity: '10.000', amount: '1000.00' });
  });

  it('средняя стоимость', async () => {
    const ctx = await makeOrg(prisma);
    const t = await makeTrade(prisma, ctx, { vatPayer: false, method: 'AVERAGE' });
    await s.trade.create(ctx, { docType: 'SUPPLY', date: '2026-10-01', counterpartyId: t.supplier.id, storeId: t.s1.id, lines: [{ productId: t.goods.id, qty: '10', price: '100' }], status: 'POSTED' });
    await s.trade.create(ctx, { docType: 'SUPPLY', date: '2026-10-02', counterpartyId: t.supplier.id, storeId: t.s1.id, lines: [{ productId: t.goods.id, qty: '10', price: '200' }], status: 'POSTED' });
    const sale = await s.trade.create(ctx, { docType: 'DEMAND', date: '2026-10-03', counterpartyId: t.customer.id, storeId: t.s1.id, lines: [{ productId: t.goods.id, qty: '5', price: '300' }], status: 'POSTED' });
    expect(sale.costEntries[0]!.postings.find((p: any) => p.side === 'D')!.amount.toString()).toBe('750');
  });

  it('отрицательный остаток запрещён: документ не проводится и не оставляет следов', async () => {
    const ctx = await makeOrg(prisma);
    const t = await makeTrade(prisma, ctx);
    await expectCode(s.trade.create(ctx, { docType: 'DEMAND', date: '2026-10-03', counterpartyId: t.customer.id, storeId: t.s1.id, lines: [{ productId: t.goods.id, qty: '1', price: '300' }], status: 'POSTED' }), 'NEGATIVE_STOCK');
    expect(await prisma.accPosting.count({ where: { organizationId: ctx.organizationId } })).toBe(0);
    expect(await prisma.document.count({ where: { organizationId: ctx.organizationId } })).toBe(0);
  });

  it('конкурентные списания последней единицы: проходит ровно одно', async () => {
    const ctx = await makeOrg(prisma);
    const t = await makeTrade(prisma, ctx, { vatPayer: false });
    await s.trade.create(ctx, { docType: 'SUPPLY', date: '2026-10-01', counterpartyId: t.supplier.id, storeId: t.s1.id, lines: [{ productId: t.goods.id, qty: '1', price: '100' }], status: 'POSTED' });
    const drafts = await Promise.all([1, 2, 3].map(() => s.trade.create(ctx, { docType: 'DEMAND', date: '2026-10-05', counterpartyId: t.customer.id, storeId: t.s1.id, lines: [{ productId: t.goods.id, qty: '1', price: '300' }] })));
    const res = await Promise.allSettled(drafts.map((d) => s.trade.post(ctx, d.id)));
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const stock = await s.reports.stock(ctx, {});
    expect(stock.lines).toHaveLength(0);
  });

  it('перемещение и списание: себестоимость переходит между складами, недостача — в прочие расходы', async () => {
    const ctx = await makeOrg(prisma);
    const t = await makeTrade(prisma, ctx, { vatPayer: false });
    await s.trade.create(ctx, { docType: 'SUPPLY', date: '2026-10-01', counterpartyId: t.supplier.id, storeId: t.s1.id, lines: [{ productId: t.goods.id, qty: '10', price: '100' }], status: 'POSTED' });
    await s.trade.create(ctx, { docType: 'MOVE', date: '2026-10-02', storeId: t.s1.id, storeToId: t.s2.id, lines: [{ productId: t.goods.id, qty: '4' }], status: 'POSTED' });
    await s.trade.create(ctx, { docType: 'LOSS', date: '2026-10-03', storeId: t.s2.id, lines: [{ productId: t.goods.id, qty: '1' }], status: 'POSTED' });
    const stock = await s.reports.stock(ctx, {});
    const byStore = Object.fromEntries(stock.lines.map((l: any) => [l.storeId, `${l.quantity}/${l.amount}`]));
    expect(byStore[t.s1.id]).toBe('6.000/600.00');
    expect(byStore[t.s2.id]).toBe('3.000/300.00');
    const tb = await s.reports.trialBalance(ctx, { from: '2026-10-01', to: '2026-10-31' });
    expect(line(tb, '7170').closing.debit).toBe('100.00');
    expect(tb.balanced).toBe(true);
  });
});

describe('Розница, НДС-режимы, авансы', () => {
  it('чек наличными — в кассу магазина (касса создаётся автоматически), картой — деньги в пути', async () => {
    const ctx = await makeOrg(prisma);
    const t = await makeTrade(prisma, ctx, { vatPayer: true });
    await s.trade.create(ctx, { docType: 'SUPPLY', date: '2026-10-01', counterpartyId: t.supplier.id, storeId: t.s2.id, lines: [{ productId: t.goods.id, qty: '10', price: '116' }], status: 'POSTED' });
    const cash = await s.trade.create(ctx, { docType: 'RETAIL_DEMAND', date: '2026-10-02', storeId: t.s2.id, paymentType: 'CASH', lines: [{ productId: t.goods.id, qty: '1', price: '232' }], status: 'POSTED' });
    const card = await s.trade.create(ctx, { docType: 'RETAIL_DEMAND', date: '2026-10-02', storeId: t.s2.id, paymentType: 'CARD', lines: [{ productId: t.goods.id, qty: '1', price: '232' }], status: 'POSTED' });
    expect(cash.entry!.postings.find((p: any) => p.side === 'D')!.account.code).toBe('1010');
    expect(card.entry!.postings.find((p: any) => p.side === 'D')!.account.code).toBe('1020');
    const box = await prisma.cashbox.findFirst({ where: { organizationId: ctx.organizationId, storeId: t.s2.id } });
    expect(box).toBeTruthy();
    expect(cash.entry!.postings.find((p: any) => p.account.code === '3130')!.amount.toString()).toBe('32');
  });

  it('неплательщик НДС: вся сумма покупки — в стоимость товара; услуга — в расходы', async () => {
    const ctx = await makeOrg(prisma);
    const t = await makeTrade(prisma, ctx, { vatPayer: false });
    const d = await s.trade.create(ctx, { docType: 'SUPPLY', date: '2026-10-01', counterpartyId: t.supplier.id, storeId: t.s1.id, lines: [{ productId: t.goods.id, qty: '2', price: '580' }, { productId: t.service.id, qty: '1', price: '1000' }], status: 'POSTED' });
    expect(d.entry!.postings.map((p: any) => `${p.side}${p.account.code}:${p.amount}`).sort()).toEqual(['D1330:1160', 'D7020:1000', 'C3310:2160'].sort());
  });

  it('аванс поставщику зачитывается при поступлении, частичная поставка по заказу', async () => {
    const ctx = await makeOrg(prisma);
    const t = await makeTrade(prisma, ctx, { vatPayer: false });
    const adv = await s.docs.create(ctx, { docType: 'BANK_OUT', date: '2026-10-01', body: { bankAccountId: t.bank.id, operation: 'SUPPLIER', counterpartyId: t.supplier.id, amount: '500.00' } });
    const advP = await s.docs.post(ctx, adv.id);
    expect(advP.entry!.postings.map((p: any) => `${p.side}${p.account.code}:${p.amount}`).sort()).toEqual(['D1710:500', 'C1030:500'].sort());
    const order = await s.trade.create(ctx, { docType: 'PURCHASE_ORDER', date: '2026-10-01', counterpartyId: t.supplier.id, storeId: t.s1.id, lines: [{ productId: t.goods.id, qty: '10', price: '100' }], status: 'POSTED' });
    const part1 = await s.trade.fromBase(ctx, order.id, 'SUPPLY', '2026-10-02');
    await s.trade.update(ctx, part1.id, { lines: [{ productId: t.goods.id, qty: '3', price: '100' }] });
    const p1 = await s.trade.post(ctx, part1.id);
    expect(p1.entry!.postings.map((p: any) => `${p.side}${p.account.code}:${p.amount}`).sort()).toEqual(['D1330:300', 'C3310:300', 'D3310:300', 'C1710:300'].sort());
    const part2 = await s.trade.fromBase(ctx, order.id, 'SUPPLY', '2026-10-03');
    expect(part2.lines[0].qty.toString()).toBe('7');
    await s.trade.post(ctx, part2.id);
    const st = await s.reports.settlements(ctx, {});
    expect(st.lines[0]).toMatchObject({ payable: '500.00', advancePaid: '0.00' });
    await expectCode(s.trade.fromBase(ctx, order.id, 'SUPPLY'), 'BASE_FULFILLED');
  });
});

describe('Банк и автопилот', () => {
  it('выписка: предпросмотр, разнесение по БИН, повторная загрузка не создаёт дублей', async () => {
    const ctx = await makeOrg(prisma);
    const t = await makeTrade(prisma, ctx, { vatPayer: false });
    const csv = `Дата;Номер документа;Контрагент;БИН/ИИН;Дебет;Кредит;Назначение платежа;КНП\n05.10.2026;101;ТОО Покупатель;${t.customer.inn};;15 000,00;Оплата по счёту 1;710\n06.10.2026;102;Неизвестный;999999999999;2 500,50;;Аренда;859\n06.10.2026;x;;;abc;;;\n`;
    const pv = await s.bank.preview(ctx, { bankAccountId: t.bank.id, csv });
    expect(pv.summary).toMatchObject({ total: 3, new: 2, errors: 1, in: '15000.00', out: '2500.50' });
    expect(pv.rows[0].action).toBe('CUSTOMER_PAYMENT');
    const r1 = await s.bank.commit(ctx, { bankAccountId: t.bank.id, csv });
    expect(r1).toMatchObject({ created: 2, posted: 1, drafts: 1 });
    const r2 = await s.bank.commit(ctx, { bankAccountId: t.bank.id, csv });
    expect(r2).toMatchObject({ created: 0 });
    const st = await s.reports.settlements(ctx, {});
    expect(st.lines.find((l: any) => l.counterpartyId === t.customer.id)).toMatchObject({ advanceReceived: '15000.00' });
  });

  it('фоновый сверщик отражает документы из кассы/обмена и пишет понятную проблему при ошибке', async () => {
    const ctx = await makeOrg(prisma);
    const t = await makeTrade(prisma, ctx, { vatPayer: false });
    // документ «из обмена»: без организации, только склад
    const ext = await prisma.document.create({ data: { docType: 'SUPPLY', status: 'POSTED', date: new Date('2026-10-01'), storeId: t.s1.id, counterpartyId: t.supplier.id, number: 'MS-1', owner: 'C1', total: 1000,
      lines: { create: [{ lineNo: 1, productId: t.goods.id, qty: 10, price: 100, amount: 1000 }] } } });
    const bad = await prisma.document.create({ data: { docType: 'DEMAND', status: 'POSTED', date: new Date('2026-10-02'), storeId: t.s1.id, number: 'MS-2', owner: 'C1', total: 300,
      lines: { create: [{ lineNo: 1, productId: t.goods.id, qty: 1, price: 300, amount: 300 }] } } });
    for (let i = 0; i < 20 && (await s.autopilot.tick(500)); i++);
    const okEntry = await prisma.accEntry.findFirst({ where: { organizationId: ctx.organizationId, sourceType: 'TRADE_DOCUMENT', sourceId: ext.id, status: 'ACTIVE' } });
    expect(okEntry).toBeTruthy();
    const issues = await s.autopilot.issues(ctx);
    expect(issues.find((i: any) => i.sourceId === bad.id)).toMatchObject({ code: 'COUNTERPARTY_REQUIRED' });
    // исправили документ в обмене → проблема решается
    await prisma.document.update({ where: { id: bad.id }, data: { counterpartyId: t.customer.id } });
    const r = await s.autopilot.process(bad.id);
    expect(r.status).toBe('POSTED');
    expect((await s.autopilot.issues(ctx)).length).toBe(0);
    // распроведение в обмене снимает проводки
    await prisma.document.update({ where: { id: bad.id }, data: { status: 'DRAFT' } });
    expect((await s.autopilot.process(bad.id)).status).toBe('CANCELLED');
  });
});

describe('Касса и валюта', () => {
  it('ПКО с банка, РКО под отчёт, комиссия, валютный счёт по курсу на дату', async () => {
    const ctx = await makeOrg(prisma);
    const t = await makeTrade(prisma, ctx, { vatPayer: false });
    const usd = await prisma.orgBankAccount.create({ data: { organizationId: ctx.organizationId, name: 'USD', iban: 'KZ12345USD0000000001', bic: 'HSBKKZKX', bankName: 'Банк', currency: 'USD' } });
    await prisma.currencyRate.upsert({ where: { currencyCode_date: { currencyCode: 'USD', date: new Date('2026-10-01') } }, create: { currencyCode: 'USD', date: new Date('2026-10-01'), rate: '512.34' }, update: { rate: '512.34' } });
    const emp = await prisma.employee.create({ data: { firstName: 'Тест', lastName: 'Подотчётный' } });
    const post = async (docType: string, date: string, body: any) => s.docs.post(ctx, (await s.docs.create(ctx, { docType, date, body })).id);

    await post('BANK_IN', '2026-10-01', { bankAccountId: t.bank.id, operation: 'OTHER', corrAccount: '5030', amount: '100000.00' });
    const cashIn = await post('CASH_IN', '2026-10-02', { cashboxId: t.cash.id, operation: 'FROM_BANK', fromBankAccountId: t.bank.id, amount: '30000.00' });
    expect(cashIn.entry!.postings.map((p: any) => `${p.side}${p.account.code}:${p.amount}`).sort()).toEqual(['D1010:30000', 'C1030:30000'].sort());
    const adv = await post('CASH_OUT', '2026-10-03', { cashboxId: t.cash.id, operation: 'ACCOUNTABLE', employeeId: emp.id, amount: '5000.00' });
    expect(adv.entry!.postings.find((p: any) => p.side === 'D')!.account.code).toBe('1250');
    await post('BANK_OUT', '2026-10-04', { bankAccountId: t.bank.id, operation: 'COMMISSION', amount: '150.00' });
    // валюта: 100 USD × 512.34 = 51 234.00 ₸ (курс от 01.10 действует 05.10)
    const fx = await post('BANK_IN', '2026-10-05', { bankAccountId: usd.id, operation: 'CUSTOMER', counterpartyId: t.customer.id, currencyAmount: '100.00' });
    const fxMoney = fx.entry!.postings.find((p: any) => p.account.code === '1030')!;
    expect(fxMoney.amount.toString()).toBe('51234');
    expect(fxMoney.currency).toBe('USD');
    expect(fxMoney.currencyAmount!.toString()).toBe('100');
    await expectCode(post('BANK_IN', '2026-09-01', { bankAccountId: usd.id, operation: 'CUSTOMER', counterpartyId: t.customer.id, currencyAmount: '1.00' }), 'RATE_MISSING');
    const tb = await s.reports.trialBalance(ctx, { from: '2026-10-01', to: '2026-10-31' });
    expect(tb.balanced).toBe(true);
    expect(line(tb, '1010').closing.debit).toBe('25000.00');
    expect(line(tb, '1030').closing.debit).toBe(String((100000 - 30000 - 150 + 51234).toFixed(2)));
    expect(line(tb, '7030').closing.debit).toBe('150.00');
  });
});
