// Сквозные бизнес-процессы: каждый сценарий — в своей организации, после каждого шага проверяются связи между
// документами (основание → исполнение → возврат → оплата) и инварианты: остаток = сумма движений, количество на 1330 =
// оперативный остаток, двойная запись сбалансирована, сальдо расчётов с контрагентом = сумма документов и оплат.
// Тест не меняет код: найденное несоответствие бизнес-логике остаётся падающей проверкой с пометкой «BUG?».
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { StockLedgerService } from '../src/modules/accounting/inventory/stock-ledger.service';
import { OrgContext } from '../src/modules/accounting/access/org-context';
import { makeServices, makeOrg, makeTrade, ctxFor } from './accounting-helpers';

const prisma = new PrismaService();
const s = makeServices(prisma);
const ledger = new StockLedgerService(prisma);
const D = Prisma.Decimal;
type Dec = Prisma.Decimal;
type Trade = Awaited<ReturnType<typeof makeTrade>>;

async function code(p: Promise<unknown>) {
  try { await p; return 'OK'; } catch (e: any) { return e?.response?.code ?? e?.code ?? e?.message; }
}

/** Сальдо (Дт − Кт) действующих проводок счёта БУ; фильтр — контрагент, товар, склад. */
async function bal(ctx: OrgContext, account: string, f: { counterpartyId?: string; productId?: string; storeId?: string } = {}) {
  const rows = await prisma.accPosting.findMany({ where: { organizationId: ctx.organizationId, isActive: true, ledger: 'BU', account: { code: account }, ...f } });
  return rows.reduce((a, r) => (r.side === 'D' ? a.plus(r.amount) : a.minus(r.amount)), new D(0)).toFixed(2);
}
/** Оперативный остаток: факт, резерв, свободно (по складу, все ячейки). */
async function st(productId: string, storeId: string) {
  const rows = await prisma.stock.findMany({ where: { productId, storeId } });
  const qty = rows.reduce((a, r) => a.plus(r.qty), new D(0)), reserved = rows.reduce((a, r) => a.plus(r.reserved), new D(0));
  return { qty: qty.toString(), reserved: reserved.toString(), free: qty.minus(reserved).toString() };
}
const qtyOf = async (productId: string, storeId: string) => (await st(productId, storeId)).qty;
const costOf = async (docId: string) => ((await prisma.accEntry.findMany({ where: { sourceType: 'COST', sourceId: { startsWith: `TRADE_DOCUMENT:${docId}:` }, status: 'ACTIVE' }, include: { postings: { include: { account: true } } } }))
  .flatMap((e) => e.postings).map((p) => `${p.side}${p.account.code}:${new D(p.amount).toFixed(2)}`).sort());
const openItems = async (ctx: OrgContext, account: string, counterpartyId: string) =>
  (await s.posting.openItems(prisma as any, ctx.organizationId, account, new Date('2026-12-31'), { COUNTERPARTY: counterpartyId }))
    .filter((x) => !x.balance.isZero()).map((x) => [x.settlementDocId, x.balance.abs().toFixed(2)]).sort();
async function colleague(ctx: OrgContext, role = 'chief_accountant') {
  const user = await prisma.user.create({ data: { organizationId: ctx.organizationId, email: `bf-${randomUUID()}@test.local`, passwordHash: 'x', firstName: 'Второй', lastName: 'Сотрудник' } });
  await prisma.orgMembership.create({ data: { userId: user.id, organizationId: ctx.organizationId, role } });
  return ctxFor(ctx.organizationId, user.id, role);
}

// Знак документа в расчётах с контрагентом (+ — контрагент должен нам больше, − — мы должны больше).
const TRADE_SIGN: Record<string, number> = { DEMAND: 1, SALES_RETURN: -1, PAYMENT_IN: -1, SUPPLY: -1, LANDED_COST: -1, PURCHASE_RETURN: 1, PAYMENT_OUT: 1 };
const sorted = (m: Map<string, Dec>) => [...m.entries()].filter(([, v]) => !v.isZero()).map(([k, v]) => [k, v.toFixed(2)]).sort();

/**
 * Инварианты организации (раздел 7): после любого шага они должны выполняться.
 * 1) остаток каждой строки stock = сумма движений журнала (stock-movements/check);
 * 2) двойная запись: Σ Дт = Σ Кт действующих проводок;
 * 3) расчёты: по каждому контрагенту сальдо 1210/3510/3310/1710 = Σ итогов проведённых документов и оплат со знаком;
 * 4) запасы: количество на 1330 (по товару и складу) = оперативный остаток; стоимость не отрицательна и нулевая,
 *    когда товара нет (стоимость «оставшихся партий» не висит без количества).
 */
async function invariants(ctx: OrgContext) {
  const check = await ledger.check(ctx);
  expect(check.mismatches).toEqual([]);

  const sides = await prisma.accPosting.groupBy({ by: ['side'], where: { organizationId: ctx.organizationId, isActive: true, ledger: 'BU' }, _sum: { amount: true } });
  const dr = new D(sides.find((x) => x.side === 'D')?._sum.amount ?? 0), cr = new D(sides.find((x) => x.side === 'C')?._sum.amount ?? 0);
  expect(dr.toFixed(2)).toBe(cr.toFixed(2));

  const expected = new Map<string, Dec>();
  const add = (cp: string | null | undefined, v: Dec) => { if (cp) expected.set(cp, (expected.get(cp) ?? new D(0)).plus(v)); };
  const docs = await prisma.document.findMany({ where: { organizationId: ctx.organizationId, status: 'POSTED', deleted: false, docType: { in: Object.keys(TRADE_SIGN) as any } } });
  for (const d of docs) add(d.counterpartyId, new D(d.total ?? 0).times(TRADE_SIGN[d.docType]));
  const money = await prisma.accDocument.findMany({ where: { organizationId: ctx.organizationId, status: 'POSTED', docType: { in: ['BANK_IN', 'BANK_OUT', 'CASH_IN', 'CASH_OUT'] } } });
  for (const m of money) {
    const b = (m.body ?? {}) as any;
    if (b.operation === 'CUSTOMER' || b.operation === 'SUPPLIER') add(b.counterpartyId, new D(m.amount).times(m.docType.endsWith('_IN') ? -1 : 1));
  }
  const rows = await prisma.$queryRaw<{ cp: string; v: string }[]>`
    SELECT p.counterparty_id AS cp, sum(CASE WHEN p.side = 'D' THEN p.amount ELSE -p.amount END)::text AS v
    FROM acc_postings p JOIN acc_accounts a ON a.id = p.account_id
    WHERE p.organization_id = ${ctx.organizationId} AND p.is_active AND p.ledger = 'BU' AND p.counterparty_id IS NOT NULL AND a.code IN ('1210', '3510', '3310', '1710')
    GROUP BY 1`;
  expect(sorted(new Map(rows.map((r) => [r.cp, new D(r.v)])))).toEqual(sorted(expected));

  const inv = await prisma.$queryRaw<{ product_id: string; store_id: string; q: string; v: string }[]>`
    SELECT p.product_id, p.store_id, sum(CASE WHEN p.side = 'D' THEN coalesce(p.quantity, 0) ELSE -coalesce(p.quantity, 0) END)::text AS q,
           sum(CASE WHEN p.side = 'D' THEN p.amount ELSE -p.amount END)::text AS v
    FROM acc_postings p JOIN acc_accounts a ON a.id = p.account_id
    WHERE p.organization_id = ${ctx.organizationId} AND p.is_active AND p.ledger = 'BU' AND a.code = '1330'
    GROUP BY 1, 2`;
  const stock = await prisma.stock.groupBy({ by: ['productId', 'storeId'], where: { store: { organizationId: ctx.organizationId } }, _sum: { qty: true } });
  const accQty = new Map(inv.map((r) => [`${r.product_id}:${r.store_id}`, new D(r.q)]));
  const opQty = new Map(stock.map((r) => [`${r.productId}:${r.storeId}`, new D(r._sum.qty ?? 0)]));
  expect(sorted(accQty)).toEqual(sorted(opQty));
  for (const r of inv) {
    expect([r.product_id, new D(r.v).gte(0)]).toEqual([r.product_id, true]);
    if (new D(r.q).isZero()) expect([r.product_id, r.store_id, new D(r.v).toFixed(2)]).toEqual([r.product_id, r.store_id, '0.00']);
  }
}

beforeAll(async () => {
  await prisma.$connect();
  await s.chart.bootstrap();
});
afterAll(() => prisma.$disconnect());

async function world(opts: { vatPayer?: boolean; method?: 'FIFO' | 'AVERAGE' } = {}) {
  const ctx = await makeOrg(prisma);
  const t = await makeTrade(prisma, ctx, { vatPayer: opts.vatPayer ?? false, method: opts.method ?? 'FIFO' });
  return { ctx, t };
}
const supply = (ctx: OrgContext, t: Trade, qty: string, price: string, date = '2026-10-01', extra: any = {}) =>
  s.trade.create(ctx, { docType: 'SUPPLY', date, counterpartyId: t.supplier.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty, price }], ...extra });
const sale = (ctx: OrgContext, t: Trade, qty: string, price: string, date = '2026-10-03', extra: any = {}) =>
  s.trade.create(ctx, { docType: 'DEMAND', date, counterpartyId: t.customer.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty, price }], ...extra });
const payIn = (ctx: OrgContext, t: Trade, amount: string, date: string) =>
  s.trade.create(ctx, { docType: 'PAYMENT_IN', date, counterpartyId: t.customer.id, bankAccountId: t.bank.id, amount, status: 'POSTED' });

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('1. Продажа: заказ → резерв → отгрузки частями по заказу → оплаты частями → акт сверки', () => {
  it('остаток и резерв, исполнение заказа, долг покупателя по документам — после каждого шага; в конце 0', async () => {
    const { ctx, t } = await world();
    await supply(ctx, t, '10', '100');
    const order = await s.trade.create(ctx, { docType: 'CUSTOMER_ORDER', date: '2026-10-02', counterpartyId: t.customer.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '6', price: '200' }] });
    expect([order.status, order.entry, (order.fulfillment as any).state]).toEqual(['POSTED', null, 'OPEN']);
    expect(await bal(ctx, '1210', { counterpartyId: t.customer.id })).toBe('0.00'); // заказ — без расчётов
    expect(await st(t.goods.id, t.s1.id)).toEqual({ qty: '10', reserved: '0', free: '10' });

    expect((await s.trade.reserve(ctx, order.id)).lines[0]).toMatchObject({ ordered: '6', reserved: '6', shortfall: '0' });
    expect(await st(t.goods.id, t.s1.id)).toEqual({ qty: '10', reserved: '6', free: '4' });

    // Отгрузка 1: на основании — склад, покупатель, цена заказа; принято 4 из 6.
    const d1 = await s.trade.fromBase(ctx, order.id, 'DEMAND', '2026-10-03');
    expect([d1.status, d1.storeId, d1.counterpartyId, d1.lines[0].qty.toString(), d1.lines[0].price!.toString(), (d1.attributes as any).baseId])
      .toEqual(['DRAFT', t.s1.id, t.customer.id, '6', '200', order.id]);
    await s.trade.update(ctx, d1.id, { expectedVersion: d1.version, lines: [{ productId: t.goods.id, qty: '4' }] });
    expect(await st(t.goods.id, t.s1.id)).toEqual({ qty: '10', reserved: '6', free: '4' }); // черновик ничего не двигает
    const p1d = await s.trade.post(ctx, d1.id);
    expect(new D(p1d.total!).toFixed(2)).toBe('800.00');
    expect(await st(t.goods.id, t.s1.id)).toEqual({ qty: '6', reserved: '2', free: '4' });
    expect((await s.trade.get(ctx, order.id)).fulfillment).toMatchObject({ state: 'PARTIAL', lines: [{ ordered: '6', fulfilled: '4', remaining: '2' }] });
    expect(await bal(ctx, '1210', { counterpartyId: t.customer.id })).toBe('800.00');
    expect([await bal(ctx, '6010'), await bal(ctx, '7010'), await bal(ctx, '1330')]).toEqual(['-800.00', '400.00', '600.00']);
    await invariants(ctx);

    // Оплата части: гасит долг по реализации 1.
    const pay1 = await payIn(ctx, t, '500', '2026-10-04');
    expect(pay1.status).toBe('POSTED');
    expect([await bal(ctx, '1210', { counterpartyId: t.customer.id }), await bal(ctx, '1030')]).toEqual(['300.00', '500.00']);
    expect(await openItems(ctx, '1210', t.customer.id)).toEqual([[d1.id, '300.00']]);
    await invariants(ctx);

    // Отгрузка 2: остаток заказа (2) — заказ исполнен, резерв израсходован.
    const d2 = await s.trade.fromBase(ctx, order.id, 'DEMAND', '2026-10-05');
    expect(d2.lines.map((l: any) => l.qty.toString())).toEqual(['2']);
    await s.trade.post(ctx, d2.id);
    expect(await st(t.goods.id, t.s1.id)).toEqual({ qty: '4', reserved: '0', free: '4' });
    const ful = (await s.trade.get(ctx, order.id)).fulfillment!;
    expect(ful).toMatchObject({ state: 'FULFILLED', lines: [{ ordered: '6', fulfilled: '6', remaining: '0' }] });
    expect(ful.documents.map((x: any) => x.id).sort()).toEqual([d1.id, d2.id].sort());
    expect((await prisma.stockReservation.findMany({ where: { sourceId: order.id } })).map((r) => [r.remaining.toString(), r.closeReason])).toEqual([['0', 'SHIPPED']]);
    expect(await code(s.trade.fromBase(ctx, order.id, 'DEMAND'))).toBe('BASE_FULFILLED');
    expect(await bal(ctx, '1210', { counterpartyId: t.customer.id })).toBe('700.00');
    expect(await openItems(ctx, '1210', t.customer.id)).toEqual([[d1.id, '300.00'], [d2.id, '400.00']].sort());
    await invariants(ctx);

    // Оплата остатка: долг 0, аванса нет.
    await payIn(ctx, t, '700', '2026-10-06');
    expect([await bal(ctx, '1210', { counterpartyId: t.customer.id }), await bal(ctx, '3510', { counterpartyId: t.customer.id }), await bal(ctx, '1030')]).toEqual(['0.00', '0.00', '1200.00']);
    expect(await openItems(ctx, '1210', t.customer.id)).toEqual([]);
    expect((await s.reports.settlements(ctx, { date: '2026-10-31' })).lines.find((l: any) => l.counterpartyId === t.customer.id)).toBeUndefined();
    expect([await bal(ctx, '6010'), await bal(ctx, '7010'), await bal(ctx, '1330')]).toEqual(['-1200.00', '600.00', '400.00']);

    // Акт сверки: все четыре документа и нулевое конечное сальдо.
    const r = await s.reports.reconciliation(ctx, { counterpartyId: t.customer.id, from: '2026-10-01', to: '2026-10-31' });
    expect(r.rows.map((x) => [x.date, x.document.split(' №')[0], x.debit, x.credit])).toEqual([
      ['2026-10-03', 'Реализация', '800.00', '0.00'],
      ['2026-10-04', 'Оплата от покупателя', '0.00', '500.00'],
      ['2026-10-05', 'Реализация', '400.00', '0.00'],
      ['2026-10-06', 'Оплата от покупателя', '0.00', '700.00'],
    ]);
    expect([r.opening, r.turnover.debit, r.turnover.credit, r.closing]).toEqual(['0.00', '1200.00', '1200.00', '0.00']);
    await invariants(ctx);
  });

  it('реализацию, оплаченную торговой оплатой (PAYMENT_IN), нельзя снять с проведения, пока оплата на ней (как с банковской)', async () => {
    const { ctx, t } = await world();
    await supply(ctx, t, '10', '100');
    // Контроль: банковская оплата (FP-036) блокирует снятие реализации.
    const sBank = await sale(ctx, t, '1', '300');
    const bank = await s.docs.create(ctx, { docType: 'BANK_IN', date: '2026-10-04', body: { bankAccountId: t.bank.id, operation: 'CUSTOMER', counterpartyId: t.customer.id, amount: '300' } });
    await s.docs.post(ctx, bank.id);
    expect(await code(s.trade.unpost(ctx, sBank.id))).toBe('PAYMENTS_ALLOCATED');
    // Торговая оплата гасит долг с той же аналитикой «документ расчётов»…
    const sTrade = await sale(ctx, t, '1', '500', '2026-10-05');
    await payIn(ctx, t, '500', '2026-10-06');
    expect(await openItems(ctx, '1210', t.customer.id)).toEqual([]);
    // BUG?: PAYMENT_IN (trade-rules.ts:296 → settlementPostings) гасит долг по SETTLEMENT_DOC, но не пишет
    // payment_allocations (их пишет только documents.service → syncAllocations для BANK_/CASH_), поэтому
    // assertNoLandedCosts (trade-documents.service.ts:354) не видит оплату, и реализацию можно снять: оплата повисает
    // кредитом на 1210 по несуществующему долгу (вместо отказа или аванса 3510).
    const res = await code(s.trade.unpost(ctx, sTrade.id));
    expect({ unpost: res, r1210: await bal(ctx, '1210', { counterpartyId: t.customer.id }), r3510: await bal(ctx, '3510', { counterpartyId: t.customer.id }), open: await openItems(ctx, '1210', t.customer.id) })
      .toEqual({ unpost: 'PAYMENTS_ALLOCATED', r1210: '0.00', r3510: '0.00', open: [] });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('2. Закупка: заказ поставщику → приёмка с недостачей → доп. расходы → возврат по поступлению → оплата', () => {
  it('кредиторка, остаток, себестоимость единицы после доп. расходов; возврат — не больше принятого', async () => {
    const { ctx, t } = await world();
    const po = await s.trade.create(ctx, { docType: 'PURCHASE_ORDER', date: '2026-10-01', counterpartyId: t.supplier.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '10', price: '100' }] });
    expect([po.status, po.entry, (po.fulfillment as any).state]).toEqual(['POSTED', null, 'OPEN']);
    expect(await bal(ctx, '3310', { counterpartyId: t.supplier.id })).toBe('0.00');

    // Приёмка по заказу: ожидается 10, принято 8 (недостача).
    const rc = await s.trade.fromBase(ctx, po.id, 'SUPPLY', '2026-10-02');
    expect([rc.counterpartyId, rc.storeId, rc.lines[0].qty.toString(), rc.lines[0].expectedQty!.toString()]).toEqual([t.supplier.id, t.s1.id, '10', '10']);
    await s.trade.update(ctx, rc.id, { expectedVersion: rc.version, lines: [{ productId: t.goods.id, qty: '8', price: '100', expectedQty: '10', discrepancyReason: 'SHORTAGE' }] });
    const rcp = await s.trade.post(ctx, rc.id);
    expect(rcp.receipt).toMatchObject({ hasDiscrepancy: true, claimAmount: '200.00', lines: [{ expected: '10', accepted: '8', shortage: '2' }] });
    expect(await qtyOf(t.goods.id, t.s1.id)).toBe('8');
    expect([await bal(ctx, '3310', { counterpartyId: t.supplier.id }), await bal(ctx, '1330')]).toEqual(['-800.00', '800.00']);
    expect((await s.trade.get(ctx, po.id)).fulfillment).toMatchObject({ state: 'PARTIAL', lines: [{ ordered: '10', fulfilled: '8', remaining: '2' }] });
    await invariants(ctx);

    // Доп. расходы 160 на 8 шт → себестоимость единицы 120.
    const lc = await s.trade.create(ctx, { docType: 'LANDED_COST', date: '2026-10-03', counterpartyId: t.supplier.id, baseId: rc.id, status: 'POSTED', lines: [{ productId: t.service.id, qty: '1', price: '160' }] });
    expect(lc.status).toBe('POSTED');
    expect([await bal(ctx, '3310', { counterpartyId: t.supplier.id }), await bal(ctx, '1330')]).toEqual(['-960.00', '960.00']);
    const unit = async () => (await s.reports.stock(ctx, { date: '2026-10-31', storeId: t.s1.id })).lines.filter((l: any) => l.productId === t.goods.id).map((l: any) => [l.quantity, l.amount, l.unitCost]);
    expect(await unit()).toEqual([['8.000', '960.00', '120.00']]);
    expect((await s.reports.settlements(ctx, { date: '2026-10-31' })).lines.find((l: any) => l.counterpartyId === t.supplier.id)).toMatchObject({ payable: '960.00' });
    expect(await code(s.trade.update(ctx, rc.id, { expectedVersion: rcp.version, reason: 'правка', lines: [{ productId: t.goods.id, qty: '7', price: '100' }] }))).toBe('LANDED_COST_DEPENDS');
    await invariants(ctx);

    // Возврат поставщику на основании поступления: по умолчанию — всё принятое, по цене поступления.
    const ret = await s.trade.fromBase(ctx, rc.id, 'PURCHASE_RETURN', '2026-10-04');
    expect([ret.status, ret.lines[0].qty.toString(), ret.lines[0].price!.toString()]).toEqual(['DRAFT', '8', '100']);
    const over = await s.trade.update(ctx, ret.id, { expectedVersion: ret.version, returnReason: 'брак упаковки', lines: [{ productId: t.goods.id, qty: '9' }] } as any);
    expect(await code(s.trade.post(ctx, ret.id, undefined, over.version))).toBe('RETURN_EXCEEDS_SHIPPED');
    const three = await s.trade.update(ctx, ret.id, { expectedVersion: over.version, lines: [{ productId: t.goods.id, qty: '3' }] });
    await s.trade.post(ctx, ret.id, undefined, three.version);
    expect(await qtyOf(t.goods.id, t.s1.id)).toBe('5');
    // Поставщику возвращается 300 (цена накладной), доля доп. расходов возвращённых (60) — в прочие расходы;
    // себестоимость единицы остатка не меняется.
    expect([await bal(ctx, '3310', { counterpartyId: t.supplier.id }), await bal(ctx, '1330'), await bal(ctx, '7170')]).toEqual(['-660.00', '600.00', '60.00']);
    expect(await unit()).toEqual([['5.000', '600.00', '120.00']]);
    expect(await code(s.trade.create(ctx, { docType: 'PURCHASE_RETURN', date: '2026-10-05', counterpartyId: t.supplier.id, storeId: t.s1.id, baseId: rc.id, returnReason: 'брак упаковки', status: 'POSTED', lines: [{ productId: t.goods.id, qty: '6' }] }))).toBe('RETURN_EXCEEDS_SHIPPED');
    expect(await qtyOf(t.goods.id, t.s1.id)).toBe('5');
    await invariants(ctx);

    // Оплата поставщику банком — кредиторка 0.
    const out = await s.docs.create(ctx, { docType: 'BANK_OUT', date: '2026-10-06', body: { bankAccountId: t.bank.id, operation: 'SUPPLIER', counterpartyId: t.supplier.id, amount: '660' } });
    await s.docs.post(ctx, out.id);
    expect([await bal(ctx, '3310', { counterpartyId: t.supplier.id }), await bal(ctx, '1710', { counterpartyId: t.supplier.id }), await bal(ctx, '1030')]).toEqual(['0.00', '0.00', '-660.00']);
    const r =await s.reports.reconciliation(ctx, { counterpartyId: t.supplier.id, from: '2026-10-01', to: '2026-10-31' });
    expect(r.rows.map((x) => [x.document.split(' №')[0], x.debit, x.credit])).toEqual([
      ['Поступление', '0.00', '800.00'], ['Доп. расходы', '0.00', '160.00'], ['Возврат поставщику', '300.00', '0.00'], ['Списание со счёта', '660.00', '0.00'],
    ]);
    expect(r.closing).toBe('0.00');
    await invariants(ctx);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('3. Возвраты покупателя', () => {
  it('возврат по реализации (НДС): остаток назад, долг и НДС уменьшаются, себестоимость сторнируется; сверх отгруженного — нельзя', async () => {
    const { ctx, t } = await world({ vatPayer: true });
    await supply(ctx, t, '10', '116'); // цена с НДС 16%: 100 + 16
    expect(await bal(ctx, '1330')).toBe('1000.00');
    const sl = await sale(ctx, t, '4', '232'); // 4 × (200 + 32)
    expect([await bal(ctx, '1210', { counterpartyId: t.customer.id }), await bal(ctx, '6010'), await bal(ctx, '3130'), await bal(ctx, '7010'), await bal(ctx, '1330')])
      .toEqual(['928.00', '-800.00', '-128.00', '400.00', '600.00']);

    const ret = await s.trade.fromBase(ctx, sl.id, 'SALES_RETURN', '2026-10-05');
    expect([ret.storeId, ret.lines[0].qty.toString(), ret.lines[0].price!.toString()]).toEqual([t.s1.id, '4', '232']);
    await s.trade.update(ctx, ret.id, { expectedVersion: ret.version, lines: [{ productId: t.goods.id, qty: '1' }] });
    await s.trade.post(ctx, ret.id);
    expect(await qtyOf(t.goods.id, t.s1.id)).toBe('7');
    expect([await bal(ctx, '1210', { counterpartyId: t.customer.id }), await bal(ctx, '6020'), await bal(ctx, '3130'), await bal(ctx, '7010'), await bal(ctx, '1330')])
      .toEqual(['696.00', '200.00', '-96.00', '300.00', '700.00']);
    expect(await costOf(ret.id)).toEqual(['C7010:100.00', 'D1330:100.00']);
    await invariants(ctx);

    expect(await code(s.trade.create(ctx, { docType: 'SALES_RETURN', date: '2026-10-06', counterpartyId: t.customer.id, storeId: t.s1.id, baseId: sl.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '4' }] }))).toBe('RETURN_EXCEEDS_SHIPPED');
    expect(await qtyOf(t.goods.id, t.s1.id)).toBe('7');
    await s.trade.create(ctx, { docType: 'SALES_RETURN', date: '2026-10-06', counterpartyId: t.customer.id, storeId: t.s1.id, baseId: sl.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '3' }] });
    expect(await qtyOf(t.goods.id, t.s1.id)).toBe('10');
    expect([await bal(ctx, '1210', { counterpartyId: t.customer.id }), await bal(ctx, '6020'), await bal(ctx, '3130'), await bal(ctx, '7010'), await bal(ctx, '1330')])
      .toEqual(['0.00', '800.00', '0.00', '0.00', '1000.00']);
    expect((await s.trade.get(ctx, sl.id)).returns).toMatchObject({ lines: [{ shipped: '4', returned: '4', left: '0' }] });
    expect(await code(s.trade.fromBase(ctx, sl.id, 'SALES_RETURN'))).toBe('BASE_FULFILLED');
    expect((await s.reports.reconciliation(ctx, { counterpartyId: t.customer.id, from: '2026-10-01', to: '2026-10-31' })).closing).toBe('0.00');
    await invariants(ctx);
  });

  it('реализацию с проведённым возвратом нельзя снять с проведения или пометить на удаление', async () => {
    const { ctx, t } = await world();
    await supply(ctx, t, '10', '100');
    const sl1 = await sale(ctx, t, '4', '200');
    const sl2 = await sale(ctx, t, '4', '200');
    for (const sl of [sl1, sl2]) await s.trade.create(ctx, { docType: 'SALES_RETURN', date: '2026-10-05', counterpartyId: t.customer.id, storeId: t.s1.id, baseId: sl.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '2' }] });
    expect([await qtyOf(t.goods.id, t.s1.id), await bal(ctx, '1210', { counterpartyId: t.customer.id })]).toEqual(['6', '800.00']);
    // BUG?: assertNoLandedCosts (trade-documents.service.ts:352-369) защищает только поступление с доп. расходами,
    // отгрузку «в пути» с приёмками и документ с оплатами; реализацию с проведённым возвратом можно снять или удалить —
    // возвраты остаются по реализации, которой нет: товара на складе больше, чем пришло, у покупателя кредит 1210 без
    // оплаты, выручка 6010 = 0 при сторно 6020.
    const unpost = await code(s.trade.unpost(ctx, sl1.id));
    const cancel = await code(s.trade.cancel(ctx, sl2.id));
    expect({ unpost: unpost !== 'OK', cancel: cancel !== 'OK', stock: await qtyOf(t.goods.id, t.s1.id), r1210: await bal(ctx, '1210', { counterpartyId: t.customer.id }), r6010: await bal(ctx, '6010'), r6020: await bal(ctx, '6020') })
      .toEqual({ unpost: true, cancel: true, stock: '6', r1210: '800.00', r6010: '-1600.00', r6020: '800.00' });
  });

  it('проведённую реализацию нельзя уменьшить ниже уже возвращённого', async () => {
    const { ctx, t } = await world();
    await supply(ctx, t, '10', '100');
    const sl = await sale(ctx, t, '4', '200');
    await s.trade.create(ctx, { docType: 'SALES_RETURN', date: '2026-10-05', counterpartyId: t.customer.id, storeId: t.s1.id, baseId: sl.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '3' }] });
    // BUG?: update() проведённого документа проверяет только его собственный лимит по основанию (assertBasisLimits,
    // trade-documents.service.ts:513), но не лимиты зависимых возвратов: реализация 1 шт. при возврате 3 шт. проходит —
    // возвращено больше, чем продано.
    const res = await code(s.trade.update(ctx, sl.id, { expectedVersion: sl.version, reason: 'покупатель взял меньше', lines: [{ productId: t.goods.id, qty: '1', price: '200' }] }));
    expect({ rejected: res !== 'OK', stock: await qtyOf(t.goods.id, t.s1.id), r1210: await bal(ctx, '1210', { counterpartyId: t.customer.id }), returns: (await s.trade.get(ctx, sl.id)).returns!.lines })
      .toEqual({ rejected: true, stock: '9', r1210: '200.00', returns: [{ productId: t.goods.id, shipped: '4', returned: '3', left: '1' }] });
  });

  it('возврат по основанию уменьшает долг по документу-основанию (открытые позиции для разнесения оплат)', async () => {
    const { ctx, t } = await world();
    const sup = await supply(ctx, t, '10', '100');
    const sl = await sale(ctx, t, '4', '200');
    await s.trade.create(ctx, { docType: 'SALES_RETURN', date: '2026-10-05', counterpartyId: t.customer.id, storeId: t.s1.id, baseId: sl.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '1' }] });
    await s.trade.create(ctx, { docType: 'PURCHASE_RETURN', date: '2026-10-05', counterpartyId: t.supplier.id, storeId: t.s1.id, baseId: sup.id, returnReason: 'брак упаковки', status: 'POSTED', lines: [{ productId: t.goods.id, qty: '3' }] });
    expect([await bal(ctx, '1210', { counterpartyId: t.customer.id }), await bal(ctx, '3310', { counterpartyId: t.supplier.id })]).toEqual(['600.00', '-700.00']);
    // BUG?: возврат пишет Кт 1210 / Дт 3310 с SETTLEMENT_DOC = сам возврат (trade-rules.ts:98 cp(), строки 172 и 254),
    // а не документ-основание: реализация остаётся открытой на полную сумму, возврат висит отдельной «переплатой».
    // Оплата 600 закрывает долг в целом, но открытые позиции не закрываются (реализация 200, возврат −200), ручное
    // разнесение позволяет отнести на реализацию все 800 (ALLOC_EXCEEDS_DEBT не срабатывает), а на возврат — нельзя.
    const before = { customer: await openItems(ctx, '1210', t.customer.id), supplier: await openItems(ctx, '3310', t.supplier.id) };
    await payIn(ctx, t, '600', '2026-10-06');
    expect({ ...before, afterPayment: await openItems(ctx, '1210', t.customer.id) })
      .toEqual({ customer: [[sl.id, '600.00']], supplier: [[sup.id, '700.00']], afterPayment: [] });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('4. Изменение и пометка на удаление проведённых документов', () => {
  it('правка количества в отгрузке: остаток, проводки, долг и себестоимость согласованы; правки подряд в одну секунду; удаление возвращает всё', async () => {
    const { ctx, t } = await world();
    await supply(ctx, t, '10', '100');
    const d = await sale(ctx, t, '5', '200', '2026-10-02');
    const state = async () => [await qtyOf(t.goods.id, t.s1.id), await bal(ctx, '1210', { counterpartyId: t.customer.id }), await bal(ctx, '6010'), await bal(ctx, '7010'), await bal(ctx, '1330')];
    expect(await state()).toEqual(['5', '1000.00', '-1000.00', '500.00', '500.00']);
    expect(await code(s.trade.update(ctx, d.id, { expectedVersion: d.version, lines: [{ productId: t.goods.id, qty: '3', price: '200' }] }))).toBe('REASON_REQUIRED');

    const u1 = await s.trade.update(ctx, d.id, { expectedVersion: d.version, reason: 'ошибка в количестве', lines: [{ productId: t.goods.id, qty: '3', price: '200' }] });
    expect([u1.status, new D(u1.total!).toFixed(2)]).toEqual(['POSTED', '600.00']);
    expect(await state()).toEqual(['7', '600.00', '-600.00', '300.00', '700.00']);
    expect(await costOf(d.id)).toEqual(['C1330:300.00', 'D7010:300.00']);
    await invariants(ctx);

    // Две правки подряд (в пределах одной секунды) — действуют последние строки, старые проводки сняты.
    const u2 = await s.trade.update(ctx, d.id, { expectedVersion: u1.version, reason: 'правка 2', lines: [{ productId: t.goods.id, qty: '4', price: '200' }] });
    const u3 = await s.trade.update(ctx, d.id, { expectedVersion: u2.version, reason: 'правка 3', lines: [{ productId: t.goods.id, qty: '2', price: '200' }] });
    expect(u3.version).toBe(u2.version + 1);
    expect(await state()).toEqual(['8', '400.00', '-400.00', '200.00', '800.00']);
    expect(await prisma.accEntry.count({ where: { sourceType: 'TRADE_DOCUMENT', sourceId: d.id, status: 'ACTIVE' } })).toBe(1);
    expect(u3.entry!.postings.filter((p: any) => p.account.code === '1210').map((p: any) => new D(p.amount).toFixed(2))).toEqual(['400.00']);
    expect(await costOf(d.id)).toEqual(['C1330:200.00', 'D7010:200.00']);
    expect(await code(s.trade.update(ctx, d.id, { expectedVersion: u1.version, reason: 'старая версия', lines: [{ productId: t.goods.id, qty: '1', price: '200' }] }))).toBe('VERSION_CONFLICT');
    await invariants(ctx);

    // Пометка на удаление — всё возвращается; восстановление — черновик без последствий; повторное проведение.
    const c = await s.trade.cancel(ctx, d.id);
    expect([c.status, c.deleted, c.entry]).toEqual(['CANCELLED', true, null]);
    expect(await state()).toEqual(['10', '0.00', '0.00', '0.00', '1000.00']);
    expect(await costOf(d.id)).toEqual([]);
    await invariants(ctx);
    const rs = await s.trade.restore(ctx, d.id);
    expect(rs.status).toBe('DRAFT');
    expect(await state()).toEqual(['10', '0.00', '0.00', '0.00', '1000.00']);
    await s.trade.post(ctx, d.id);
    expect(await state()).toEqual(['8', '400.00', '-400.00', '200.00', '800.00']);
    expect((await s.trade.versions(ctx, d.id)).map((v) => v.action)).toEqual(['CREATE', 'POST', 'UPDATE', 'POST', 'UPDATE', 'POST', 'UPDATE', 'POST', 'CANCEL', 'RESTORE', 'POST']);
    await invariants(ctx);
  });

  it('правка отгрузки по заказу — не больше заказанного; удаление отгрузки возвращает исполнение заказа', async () => {
    const { ctx, t } = await world();
    await supply(ctx, t, '10', '100');
    const order = await s.trade.create(ctx, { docType: 'CUSTOMER_ORDER', date: '2026-10-02', counterpartyId: t.customer.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '3', price: '200' }] });
    const d = await s.trade.fromBase(ctx, order.id, 'DEMAND', '2026-10-03');
    const p = await s.trade.post(ctx, d.id);
    expect((await s.trade.get(ctx, order.id)).fulfillment!.state).toBe('FULFILLED');
    expect(await code(s.trade.update(ctx, d.id, { expectedVersion: p.version, reason: 'добавили', lines: [{ productId: t.goods.id, qty: '4' }] }))).toBe('ORDER_OVERSHIP');
    expect([await qtyOf(t.goods.id, t.s1.id), await bal(ctx, '1210', { counterpartyId: t.customer.id })]).toEqual(['7', '600.00']);
    await s.trade.cancel(ctx, d.id);
    expect((await s.trade.get(ctx, order.id)).fulfillment).toMatchObject({ state: 'OPEN', lines: [{ fulfilled: '0', remaining: '3' }] });
    expect([await qtyOf(t.goods.id, t.s1.id), await bal(ctx, '1210', { counterpartyId: t.customer.id })]).toEqual(['10', '0.00']);
    await invariants(ctx);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('5. Инвентаризация, перемещения, резервы', () => {
  it('инвентаризация: недостача и излишек меняют остаток и проводки; снятие проведения возвращает', async () => {
    const { ctx, t } = await world();
    const boss = await colleague(ctx);
    await s.trade.create(ctx, { docType: 'SUPPLY', date: '2026-10-01', counterpartyId: t.supplier.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '10', price: '100' }, { productId: t.goods2.id, qty: '5', price: '50' }] });
    const inv = await s.trade.create(ctx, { docType: 'INVENTORY', date: '2026-10-05', storeId: t.s1.id, lines: [
      { productId: t.goods.id, qty: '8', price: '100', discrepancyReason: 'THEFT' },
      { productId: t.goods2.id, qty: '6', price: '50', discrepancyReason: 'UNRECORDED' },
    ] });
    expect(inv.lines.map((l: any) => [l.bookQty.toString(), l.qty.toString()])).toEqual([['10', '8'], ['5', '6']]);
    expect(await code(s.trade.post(ctx, inv.id))).toBe('APPROVAL_REQUIRED');
    const a = await s.approvals.request(ctx, { docKind: 'TRADE', docId: inv.id, expectedVersion: inv.version });
    await s.approvals.decide(boss, a.id, { decision: 'APPROVE' });
    await s.trade.post(ctx, inv.id);
    expect([await qtyOf(t.goods.id, t.s1.id), await qtyOf(t.goods2.id, t.s1.id)]).toEqual(['8', '6']);
    expect([await bal(ctx, '7170'), await bal(ctx, '6190'), await bal(ctx, '1330')]).toEqual(['200.00', '-50.00', '1100.00']);
    await invariants(ctx);
    await s.trade.unpost(ctx, inv.id);
    expect([await qtyOf(t.goods.id, t.s1.id), await qtyOf(t.goods2.id, t.s1.id)]).toEqual(['10', '5']);
    expect([await bal(ctx, '7170'), await bal(ctx, '6190'), await bal(ctx, '1330')]).toEqual(['0.00', '0.00', '1250.00']);
    await invariants(ctx);
  });

  it('перемещение в два этапа: между этапами товар «в пути» (остаток и стоимость), затем на складе-получателе', async () => {
    const { ctx, t } = await world();
    await supply(ctx, t, '10', '100');
    const ship = await s.trade.create(ctx, { docType: 'MOVE', date: '2026-10-02', storeId: t.s1.id, storeToId: t.s2.id, twoStage: true, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '6' }] });
    const transit = await prisma.store.findFirstOrThrow({ where: { organizationId: ctx.organizationId, isTransit: true } });
    const where = async () => [await qtyOf(t.goods.id, t.s1.id), await qtyOf(t.goods.id, transit.id), await qtyOf(t.goods.id, t.s2.id),
      await bal(ctx, '1330', { storeId: t.s1.id }), await bal(ctx, '1330', { storeId: transit.id }), await bal(ctx, '1330', { storeId: t.s2.id })];
    expect(await where()).toEqual(['4', '6', '0', '400.00', '600.00', '0.00']);
    expect((await s.trade.inTransit(ctx)).map((x: any) => x.id)).toEqual([ship.id]);
    await invariants(ctx);
    await s.trade.receive(ctx, ship.id, { date: '2026-10-03', lines: [{ productId: t.goods.id, qty: '2' }] });
    expect(await where()).toEqual(['4', '4', '2', '400.00', '400.00', '200.00']);
    await s.trade.receive(ctx, ship.id, { date: '2026-10-04' });
    expect(await where()).toEqual(['4', '0', '6', '400.00', '0.00', '600.00']);
    expect(await s.trade.inTransit(ctx)).toEqual([]);
    expect(await bal(ctx, '1330')).toBe('1000.00'); // перемещение не меняет общую стоимость
    // Продажа со склада-получателя — по стоимости, пришедшей с партией.
    await sale(ctx, t, '6', '150', '2026-10-05', { storeId: t.s2.id });
    expect([await bal(ctx, '7010'), await bal(ctx, '1330', { storeId: t.s2.id })]).toEqual(['600.00', '0.00']);
    await invariants(ctx);
  });

  it('резерв одного заказа не отгружается другим заказом и продажей без основания', async () => {
    const { ctx, t } = await world();
    await supply(ctx, t, '10', '100');
    const order = (qty: string) => s.trade.create(ctx, { docType: 'CUSTOMER_ORDER', date: '2026-10-02', counterpartyId: t.customer.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty, price: '200' }] });
    const a = await order('6'), b = await order('6');
    await s.trade.reserve(ctx, a.id);
    expect((await s.trade.reserve(ctx, b.id)).lines[0]).toMatchObject({ reserved: '4', shortfall: '2' });
    expect(await st(t.goods.id, t.s1.id)).toEqual({ qty: '10', reserved: '10', free: '0' });
    const sb = await s.trade.fromBase(ctx, b.id, 'DEMAND', '2026-10-03');
    expect(await code(s.trade.post(ctx, sb.id))).toBe('RESERVED_STOCK'); // 6 по заказу B — 2 из резерва A
    expect(await code(sale(ctx, t, '1', '200'))).toBe('RESERVED_STOCK');
    expect(await st(t.goods.id, t.s1.id)).toEqual({ qty: '10', reserved: '10', free: '0' });
    const sb4 = await s.trade.update(ctx, sb.id, { expectedVersion: sb.version, lines: [{ productId: t.goods.id, qty: '4' }] });
    await s.trade.post(ctx, sb.id, undefined, sb4.version);
    const sa = await s.trade.fromBase(ctx, a.id, 'DEMAND', '2026-10-03');
    await s.trade.post(ctx, sa.id);
    expect(await st(t.goods.id, t.s1.id)).toEqual({ qty: '0', reserved: '0', free: '0' });
    expect([(await s.trade.get(ctx, a.id)).fulfillment!.state, (await s.trade.get(ctx, b.id)).fulfillment!.state]).toEqual(['FULFILLED', 'PARTIAL']);
    await invariants(ctx);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('6. Закрытый период', () => {
  it('документы закрытого периода не проводятся, не меняются, не снимаются без права и причины; черновик — можно', async () => {
    const { ctx, t } = await world();
    await supply(ctx, t, '10', '100', '2026-09-10');
    const sep = await sale(ctx, t, '2', '200', '2026-09-15');
    const snap = async () => [await qtyOf(t.goods.id, t.s1.id), await bal(ctx, '1210'), await bal(ctx, '7010'), await bal(ctx, '1330')];
    expect(await snap()).toEqual(['8', '400.00', '200.00', '800.00']);
    await s.periods.setLock(ctx, '2026-09-30');

    expect(await code(sale(ctx, t, '1', '200', '2026-09-20'))).toBe('PERIOD_CLOSED');
    expect(await prisma.document.count({ where: { organizationId: ctx.organizationId, docType: 'DEMAND' } })).toBe(1); // откат целиком
    const draft = await s.trade.create(ctx, { docType: 'DEMAND', date: '2026-09-20', counterpartyId: t.customer.id, storeId: t.s1.id, lines: [{ productId: t.goods.id, qty: '1', price: '200' }] });
    expect(draft.status).toBe('DRAFT'); // черновик без последствий — допустим
    expect(await code(s.trade.post(ctx, draft.id))).toBe('PERIOD_CLOSED');
    expect(await code(s.trade.update(ctx, sep.id, { expectedVersion: sep.version, reason: 'правка', lines: [{ productId: t.goods.id, qty: '1', price: '200' }] }))).toBe('PERIOD_CLOSED');
    expect(await code(s.trade.unpost(ctx, sep.id))).toBe('PERIOD_CLOSED');
    expect(await code(s.trade.cancel(ctx, sep.id))).toBe('PERIOD_CLOSED');
    const after = await s.trade.get(ctx, sep.id);
    expect([after.status, after.version, after.deleted]).toEqual(['POSTED', sep.version, false]);
    expect(await snap()).toEqual(['8', '400.00', '200.00', '800.00']);

    // Документ открытого периода нельзя перенести в закрытый.
    const oct = await sale(ctx, t, '1', '200', '2026-10-05');
    expect(await code(s.trade.update(ctx, oct.id, { expectedVersion: oct.version, reason: 'дата', date: '2026-09-25' }))).toBe('PERIOD_CLOSED');
    expect((await s.trade.get(ctx, oct.id)).date.toISOString().slice(0, 10)).toBe('2026-10-05');

    // Бухгалтер без права — нельзя даже с причиной.
    const acc = await colleague(ctx, 'accountant');
    expect(await code(s.trade.post(acc, draft.id, { reason: 'документы пришли поздно' }))).toBe('PERIOD_OVERRIDE_FORBIDDEN');
    expect(await snap()).toEqual(['7', '600.00', '300.00', '700.00']);
    await invariants(ctx);
  });

  it('главный бухгалтер с причиной может провести торговый документ в закрытом периоде (как документ бухгалтерии)', async () => {
    const { ctx, t } = await world();
    await supply(ctx, t, '10', '100', '2026-09-10');
    await s.periods.setLock(ctx, '2026-09-30');
    const draft = await s.trade.create(ctx, { docType: 'DEMAND', date: '2026-09-20', counterpartyId: t.customer.id, storeId: t.s1.id, lines: [{ productId: t.goods.id, qty: '1', price: '200' }] });
    expect(ctx.can('acc.period.override')).toBe(true);
    // BUG?: trade.post/update/unpost/cancel принимают override (и контроллер передаёт body.override), но
    // AutopilotService.syncTradeDocument (autopilot.service.ts:110) проверяет период от systemCtx, которому
    // acc.period.override запрещён (autopilot.service.ts:16-18) — переопределение недоступно никому, даже главному
    // бухгалтеру с причиной; для документов бухгалтерии (docs.post) то же самое разрешено (accounting-core.int-spec.ts).
    const res = await code(s.trade.post(ctx, draft.id, { reason: 'документы пришли поздно' }));
    expect({ post: res, stock: await qtyOf(t.goods.id, t.s1.id), audit: (await prisma.auditLog.count({ where: { organizationId: ctx.organizationId, action: 'PERIOD_OVERRIDE' } })) > 0 })
      .toEqual({ post: 'OK', stock: '9', audit: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('7. Инварианты денег и запасов на смешанной истории', () => {
  it('НДС сверху, средняя, два склада, возвраты, банк и торговые оплаты, правки и удаления — инварианты держатся', async () => {
    const { ctx, t } = await world({ vatPayer: true, method: 'AVERAGE' });
    // Поступления: цены без НДС (итог документа = сумма + НДС) и с НДС.
    const sup1 = await s.trade.create(ctx, { docType: 'SUPPLY', date: '2026-10-01', counterpartyId: t.supplier.id, storeId: t.s1.id, vatIncluded: false, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '10', price: '100' }, { productId: t.goods2.id, qty: '3', price: '33.33' }] });
    expect(new D(sup1.total!).toFixed(2)).toBe(new D(1000).plus(99.99).times(1.16).toDecimalPlaces(2).toFixed(2));
    await s.trade.create(ctx, { docType: 'SUPPLY', date: '2026-10-02', counterpartyId: t.supplier.id, storeId: t.s2.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '7', price: '123.45' }] });
    await s.trade.create(ctx, { docType: 'LANDED_COST', date: '2026-10-02', counterpartyId: t.supplier.id, baseId: sup1.id, status: 'POSTED', lines: [{ productId: t.service.id, qty: '1', price: '57.99' }] });
    await invariants(ctx);
    // Продажи без НДС сверху и с ним, со скидкой.
    const d1 = await s.trade.create(ctx, { docType: 'DEMAND', date: '2026-10-03', counterpartyId: t.customer.id, storeId: t.s1.id, vatIncluded: false, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '3', price: '199.99', discount: '7' }, { productId: t.goods2.id, qty: '1', price: '50' }] });
    const d2 = await sale(ctx, t, '4', '250', '2026-10-04', { storeId: t.s2.id });
    await s.trade.create(ctx, { docType: 'MOVE', date: '2026-10-04', storeId: t.s1.id, storeToId: t.s2.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '2' }] });
    await invariants(ctx);
    // Возвраты, оплаты (торговая и банковская), правка и удаление.
    await s.trade.create(ctx, { docType: 'SALES_RETURN', date: '2026-10-05', counterpartyId: t.customer.id, storeId: t.s1.id, baseId: d1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '1' }] });
    await s.trade.create(ctx, { docType: 'PURCHASE_RETURN', date: '2026-10-05', counterpartyId: t.supplier.id, storeId: t.s1.id, baseId: sup1.id, returnReason: 'брак упаковки', status: 'POSTED', lines: [{ productId: t.goods2.id, qty: '1' }] });
    await payIn(ctx, t, '333.33', '2026-10-06');
    const bin = await s.docs.create(ctx, { docType: 'BANK_IN', date: '2026-10-06', body: { bankAccountId: t.bank.id, operation: 'CUSTOMER', counterpartyId: t.customer.id, amount: '5000' } });
    await s.docs.post(ctx, bin.id); // больше долга — остаток в аванс
    await s.trade.create(ctx, { docType: 'PAYMENT_OUT', date: '2026-10-06', counterpartyId: t.supplier.id, bankAccountId: t.bank.id, amount: '700', status: 'POSTED' });
    await invariants(ctx);
    const d3 = await sale(ctx, t, '2', '210', '2026-10-07');
    await s.trade.update(ctx, d3.id, { expectedVersion: d3.version, reason: 'правка', lines: [{ productId: t.goods.id, qty: '1', price: '210' }] });
    await s.trade.cancel(ctx, d2.id).catch(() => undefined); // разнесённая оплата может запрещать — не важно для инвариантов
    await invariants(ctx);
    // Остаток по 1330 = отчёт «Остатки» (стоимость оставшихся партий).
    const rep = await s.reports.stock(ctx, { date: '2026-10-31' });
    expect(rep.total).toBe(await bal(ctx, '1330'));
  });
});
