// FP-033: инвентаризация (сверка с фактом, учётное считает сервер и сверяет при проведении, причины, согласованные
// расхождения), причины списания, партии и сроки годности (FEFO, просрочка, остаток партии не в минус) — на настоящей БД.
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { OutboxService } from '../src/common/outbox/outbox.service';
import { SalesService } from '../src/modules/trade/sales.service';
import { StockLedgerService } from '../src/modules/accounting/inventory/stock-ledger.service';
import { OrgContext } from '../src/modules/accounting/access/org-context';
import { makeServices, makeOrg, makeTrade, ctxFor } from './accounting-helpers';

const prisma = new PrismaService();
const s = makeServices(prisma);
const ledger = new StockLedgerService(prisma);
const sales = new SalesService(prisma, new OutboxService(prisma));
const D = Prisma.Decimal;

async function code(p: Promise<unknown>) {
  try { await p; return 'OK'; } catch (e: any) { return e?.response?.code ?? e?.code ?? e?.message; }
}
const stockOf = async (productId: string, storeId: string) => String((await prisma.stock.findFirst({ where: { productId, storeId, binId: null } }))?.qty ?? 0);
async function bal(ctx: OrgContext, account: string) {
  const rows = await prisma.accPosting.findMany({ where: { organizationId: ctx.organizationId, isActive: true, account: { code: account } } });
  return rows.reduce((a, r) => (r.side === 'D' ? a.plus(r.amount) : a.minus(r.amount)), new D(0)).toFixed(2);
}
async function colleague(ctx: OrgContext, role = 'chief_accountant') {
  const user = await prisma.user.create({ data: { organizationId: ctx.organizationId, email: `inv-${randomUUID()}@test.local`, passwordHash: 'x', firstName: 'Второй', lastName: 'Сотрудник' } });
  await prisma.orgMembership.create({ data: { userId: user.id, organizationId: ctx.organizationId, role } });
  return ctxFor(ctx.organizationId, user.id, role);
}
const lotsOf = async (sourceId: string) => (await prisma.stockMovement.findMany({ where: { sourceId }, orderBy: [{ createdAt: 'asc' }] })).map((m) => `${m.kind}:${m.lotNumber ?? '-'}:${m.qty}`);

beforeAll(async () => {
  await prisma.$connect();
  await s.chart.bootstrap();
});
afterAll(() => prisma.$disconnect());

async function world() {
  const ctx = await makeOrg(prisma, 'accountant');
  const t = await makeTrade(prisma, ctx, { vatPayer: false });
  const sup = (lines: any[], date = '2026-10-01') => s.trade.create(ctx, { docType: 'SUPPLY', date, counterpartyId: t.supplier.id, storeId: t.s1.id, status: 'POSTED', lines });
  return { ctx, t, sup };
}

describe('FP-033: инвентаризация', () => {
  it('сверка с фактом: учётное — от сервера, причины и цена расхождений, согласование «четыре глаза», проводки и движения', async () => {
    const { ctx, t, sup } = await world();
    const boss = await colleague(ctx);
    await sup([{ productId: t.goods.id, qty: '10', price: '100' }, { productId: t.goods2.id, qty: '5', price: '50' }]);
    const inv = (lines: any[]) => s.trade.create(ctx, { docType: 'INVENTORY', date: '2026-10-05', storeId: t.s1.id, lines });
    expect(await code(inv([{ productId: t.goods.id, qty: '8', price: '100' }]))).toBe('COUNT_REASON_REQUIRED');
    expect(await code(inv([{ productId: t.goods.id, qty: '8', discrepancyReason: 'THEFT' }]))).toBe('COUNT_PRICE_REQUIRED');
    expect(await code(inv([{ productId: t.goods.id, qty: '8', price: '100', discrepancyReason: 'OTHER' }]))).toBe('COUNT_REASON');
    expect(await code(inv([{ productId: t.goods.id, qty: '10', price: '100', discrepancyReason: 'THEFT' }]))).toBe('COUNT_REASON');
    expect(await code(inv([{ productId: t.goods.id, qty: '-1', price: '100' }]))).toBe('BAD_QTY');
    // Учётное из запроса не принимается: сервер считает 10 и 5.
    const d = await inv([
      { productId: t.goods.id, qty: '8', price: '100', discrepancyReason: 'THEFT', bookQty: '999' },
      { productId: t.goods2.id, qty: '6', price: '50', discrepancyReason: 'UNRECORDED' },
    ]);
    expect(d.lines.map((l: any) => [l.bookQty.toString(), l.qty.toString()])).toEqual([['10', '8'], ['5', '6']]);
    expect(new D(d.total!).toFixed(2)).toBe('250.00'); // |−2|×100 + 1×50 — сумма расхождений для согласования

    // Расхождения согласуются всегда (встроенное правило), автор не согласует сам.
    expect(await code(s.trade.post(ctx, d.id))).toBe('APPROVAL_REQUIRED');
    const a = await s.approvals.request(ctx, { docKind: 'TRADE', docId: d.id, expectedVersion: d.version });
    expect(await code(s.approvals.decide(ctx, a.id, { decision: 'APPROVE' }))).toBe('FOUR_EYES');
    await s.approvals.decide(boss, a.id, { decision: 'APPROVE' });
    const posted = await s.trade.post(ctx, d.id);
    expect(await lotsOf(d.id)).toEqual(['INVENTORY_SHORTAGE:-:-2', 'INVENTORY_SURPLUS:-:1']);
    expect([await stockOf(t.goods.id, t.s1.id), await stockOf(t.goods2.id, t.s1.id)]).toEqual(['8', '6']);
    // Недостача — по себестоимости на 7170, излишек — по цене строки Дт 1330 / Кт 6190.
    expect([await bal(ctx, '7170'), await bal(ctx, '6190'), await bal(ctx, '1330')]).toEqual(['200.00', '-50.00', '1100.00']);
    expect(posted.entry!.postings.map((p: any) => `${p.side}${p.account.code}:${new D(p.amount).toFixed(2)}`).sort()).toEqual(['C6190:50.00', 'D1330:50.00']);

    // Без расхождений — проводится без согласования и без последствий.
    const same = await inv([{ productId: t.goods.id, qty: '8' }]);
    expect((await s.trade.post(ctx, same.id)).status).toBe('POSTED');
    expect(await lotsOf(same.id)).toEqual([]);
    expect(await prisma.accEntry.count({ where: { sourceId: same.id } })).toBe(0);
    expect((await ledger.check(ctx)).ok).toBe(true);
  });

  it('учёт изменился после подсчёта (движение задним числом) — проводить нельзя, пока учётное не обновлено и не согласовано заново', async () => {
    const { ctx, t, sup } = await world();
    const boss = await colleague(ctx);
    await sup([{ productId: t.goods.id, qty: '10', price: '100' }]);
    const d = await s.trade.create(ctx, { docType: 'INVENTORY', date: '2026-10-05', storeId: t.s1.id, lines: [{ productId: t.goods.id, qty: '9', price: '100', discrepancyReason: 'NATURAL_LOSS' }] });
    const a = await s.approvals.request(ctx, { docKind: 'TRADE', docId: d.id, expectedVersion: d.version });
    await s.approvals.decide(boss, a.id, { decision: 'APPROVE' });
    // Реализация задним числом (до даты инвентаризации) — учётное стало 9.
    await s.trade.create(ctx, { docType: 'DEMAND', date: '2026-10-03', counterpartyId: t.customer.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '1', price: '200' }] });
    expect(await code(s.trade.post(ctx, d.id))).toBe('INVENTORY_BOOK_CHANGED');
    // Сохранение пересчитывает учётное: теперь факт = учёту, причина лишняя.
    expect(await code(s.trade.update(ctx, d.id, { expectedVersion: d.version }))).toBe('COUNT_REASON');
    const u = await s.trade.update(ctx, d.id, { expectedVersion: d.version, lines: [{ productId: t.goods.id, qty: '9', price: '100' }] });
    expect([u.version, u.lines[0].bookQty!.toString()]).toEqual([2, '9']);
    expect((await prisma.approval.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('SUPERSEDED');
    expect((await s.trade.post(ctx, d.id)).status).toBe('POSTED');
  });

  it('заполнить по остаткам: позиции склада (партии, ячейки) на дату, факт = учётное, цена — последняя стоимость прихода (своей партии)', async () => {
    const { ctx, t, sup } = await world();
    await prisma.product.update({ where: { id: t.goods2.id }, data: { lotTracking: true } });
    await sup([{ productId: t.goods.id, qty: '3', price: '100' }, { productId: t.goods2.id, qty: '2', price: '40', lotNumber: 'B-1' }, { productId: t.goods2.id, qty: '1', price: '45', lotNumber: 'B-2' }]);
    await sup([{ productId: t.goods.id, qty: '1', price: '120' }], '2026-10-10'); // после даты — не входит
    const d = await s.trade.create(ctx, { docType: 'INVENTORY', date: '2026-10-05', storeId: t.s1.id, lines: [{ productId: t.goods.id, qty: '3' }] });
    const f = await s.trade.fillFromStock(ctx, d.id, { expectedVersion: d.version });
    expect(f.lines.map((l: any) => [l.productId === t.goods.id ? 'goods' : 'goods2', l.lotNumber, l.bookQty.toString(), l.qty.toString(), l.price?.toString()]).sort()).toEqual([
      ['goods', null, '3', '3', '120'], ['goods2', 'B-1', '2', '2', '40'], ['goods2', 'B-2', '1', '1', '45'],
    ].sort());
    // Партионный товар считается по партиям: новая находка без партии — нельзя.
    expect(await code(s.trade.update(ctx, d.id, { expectedVersion: f.version, lines: [{ productId: t.goods2.id, qty: '1', price: '40', discrepancyReason: 'UNRECORDED' }] }))).toBe('LOT_REQUIRED');
    // Остаток без партии (до включения партионного учёта) пересчитывается как есть.
    const { ctx: c2, t: t2, sup: sup2 } = await world();
    await sup2([{ productId: t2.goods.id, qty: '4', price: '10' }]);
    await prisma.product.update({ where: { id: t2.goods.id }, data: { lotTracking: true } });
    const d2 = await s.trade.create(c2, { docType: 'INVENTORY', date: '2026-10-05', storeId: t2.s1.id });
    const f2 = await s.trade.fillFromStock(c2, d2.id, { expectedVersion: d2.version });
    expect(f2.lines.map((l: any) => [l.lotNumber, l.bookQty.toString()])).toEqual([[null, '4']]);
  });
});

describe('FP-033: списание — с причиной', () => {
  it('причина строки или документа; «другое» — с пояснением', async () => {
    const { ctx, t, sup } = await world();
    await sup([{ productId: t.goods.id, qty: '5', price: '10' }]);
    const loss = (extra: any, line: any = {}) => s.trade.create(ctx, { docType: 'LOSS', date: '2026-10-02', storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '1', ...line }], ...extra });
    expect(await code(loss({}))).toBe('LOSS_REASON_REQUIRED');
    expect(await code(loss({}, { discrepancyReason: 'LOST' }))).toBe('LOSS_REASON');
    expect(await code(loss({}, { discrepancyReason: 'OTHER' }))).toBe('LOSS_REASON');
    expect((await loss({}, { discrepancyReason: 'OTHER', discrepancyNote: 'упал со стеллажа' })).lines[0]).toMatchObject({ discrepancyReason: 'OTHER' });
    expect((await loss({ lossReason: 'DAMAGED' })).lines[0].discrepancyReason).toBe('DAMAGED');
    expect(await code(s.trade.create(ctx, { docType: 'DEMAND', date: '2026-10-02', counterpartyId: t.customer.id, storeId: t.s1.id, lines: [{ productId: t.goods.id, qty: '1', price: '1', discrepancyReason: 'DAMAGED' }] }))).toBe('RECEIPT_FIELDS');
  });
});

describe('FP-033: партии и сроки годности', () => {
  it('приход — с партией и сроком; расход — FEFO без просроченных; просроченное только списать; остаток партии не в минус', async () => {
    const { ctx, t, sup } = await world();
    await prisma.product.update({ where: { id: t.goods.id }, data: { lotTracking: true, expiryTracking: true } });
    expect(await code(sup([{ productId: t.goods.id, qty: '5', price: '10' }]))).toBe('LOT_REQUIRED');
    expect(await code(sup([{ productId: t.goods.id, qty: '5', price: '10', lotNumber: 'L1' }]))).toBe('EXPIRY_REQUIRED');
    await sup([{ productId: t.goods.id, qty: '5', price: '10', lotNumber: 'L1', expiryDate: '2026-12-31' }, { productId: t.goods.id, qty: '5', price: '10', lotNumber: 'L2', expiryDate: '2026-11-15' }]);
    await sup([{ productId: t.goods.id, qty: '2', price: '10', lotNumber: 'L3', expiryDate: '2026-10-10' }], '2026-10-02');
    const sale = (qty: string, extra: any = {}, date = '2026-11-01') => s.trade.create(ctx, { docType: 'DEMAND', date, counterpartyId: t.customer.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty, price: '20', ...extra }] });
    // FEFO: L3 просрочена (10.10) — пропущена; первой — L2 (15.11), затем L1.
    const d1 = await sale('7');
    expect(await lotsOf(d1.id)).toEqual(['SHIPMENT:L2:-5', 'SHIPMENT:L1:-2']);
    // Встречное движение обязано совпадать с исходным по партии (БД).
    const orig = await prisma.stockMovement.findFirstOrThrow({ where: { sourceId: d1.id, lotNumber: 'L2' } });
    const bad = await code(prisma.stockMovement.create({ data: { organizationId: orig.organizationId, productId: orig.productId, storeId: orig.storeId, qty: 5, kind: orig.kind, sourceType: orig.sourceType, sourceId: orig.sourceId, reversesId: orig.id, lotNumber: 'L1', expiryDate: orig.expiryDate, occurredAt: orig.occurredAt } }));
    expect(String(bad)).toMatch(/STOCK_MOVE_REVERSAL/);
    expect(await prisma.stockMovement.count({ where: { reversesId: orig.id } })).toBe(0);
    expect(await code(sale('1', { lotNumber: 'L2' }))).toBe('LOT_INSUFFICIENT'); // L2 кончилась — проверка БД
    expect(await code(sale('1', { lotNumber: 'L3' }))).toBe('LOT_EXPIRED');
    expect(await code(sale('4'))).toBe('LOT_INSUFFICIENT'); // годной осталось 3 (L1), просроченную L3 не берём
    expect(await code(s.trade.create(ctx, { docType: 'MOVE', date: '2026-11-01', storeId: t.s1.id, storeToId: t.s2.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '1', lotNumber: 'L3' }] }))).toBe('LOT_EXPIRED');
    // Списание просроченного — можно (FEFO берёт L3 первой).
    const w = await s.trade.create(ctx, { docType: 'LOSS', date: '2026-11-01', storeId: t.s1.id, lossReason: 'EXPIRED', status: 'POSTED', lines: [{ productId: t.goods.id, qty: '2' }] });
    expect(await lotsOf(w.id)).toEqual(['WRITE_OFF:L3:-2']);
    // Перемещение переносит партию на склад-получатель.
    const mv = await s.trade.create(ctx, { docType: 'MOVE', date: '2026-11-02', storeId: t.s1.id, storeToId: t.s2.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '2' }] });
    expect(await lotsOf(mv.id)).toEqual(['TRANSFER_OUT:L1:-2', 'TRANSFER_IN:L1:2']);
    const rep = await ledger.lots(ctx, { on: '2026-11-02' });
    expect(rep.items.map((i: any) => [i.storeId === t.s1.id ? 's1' : 's2', i.lotNumber, i.qty, i.daysLeft])).toEqual([['s1', 'L1', '1', 59], ['s2', 'L1', '2', 59]]);
    expect((await ledger.lots(ctx, { on: '2026-11-02', expiringInDays: '30' })).items).toEqual([]);
    // Снятие реализации возвращает партии; снять поступление, чья партия продана, — нельзя.
    await s.trade.unpost(ctx, d1.id);
    expect((await ledger.lots(ctx, { on: '2026-11-02', storeId: t.s1.id })).items.map((i: any) => [i.lotNumber, i.qty])).toEqual([['L2', '5'], ['L1', '3']]);
    expect(await code(s.trade.unpost(ctx, mv.id).then(() => s.trade.unpost(ctx, w.id)).then(async () => {
      const sup2 = (await prisma.document.findFirstOrThrow({ where: { organizationId: ctx.organizationId, docType: 'SUPPLY', date: new Date('2026-10-01') } })).id;
      await s.trade.create(ctx, { docType: 'DEMAND', date: '2026-11-03', counterpartyId: t.customer.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '1', price: '20', lotNumber: 'L2' }] });
      return s.trade.unpost(ctx, sup2);
    }))).toBe('LOT_INSUFFICIENT');
    expect((await ledger.check(ctx)).ok).toBe(true);
  });

  it('касса и старые модули: нехватка партий не останавливает продажу — остаток уходит без партии', async () => {
    const { ctx, t, sup } = await world();
    await prisma.product.update({ where: { id: t.goods.id }, data: { lotTracking: true } });
    await sup([{ productId: t.goods.id, qty: '2', price: '10', lotNumber: 'P1' }]);
    const sh = await sales.createShipment({ tenantId: ctx.tenantId, organizationId: ctx.organizationId, userId: ctx.userId, role: 'chief_accountant' }, { date: '2026-10-02', storeId: t.s1.id, counterpartyId: t.customer.id, status: 'POSTED', items: [{ productId: t.goods.id, qty: 3, price: 20 }] });
    expect(await lotsOf(sh.id)).toEqual(['SHIPMENT:P1:-2', 'SHIPMENT:-:-1']);
  });
});
