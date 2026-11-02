// FP-030: журнал складских движений (источник, количество, стоимость; остаток — только из журнала; отмена —
// встречными движениями) и приёмка поступлений — частичная, с расхождениями, по заказу — на настоящей БД.
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { Scope } from '../src/common/scope';
import { OutboxService } from '../src/common/outbox/outbox.service';
import { PurchasesService } from '../src/modules/trade/purchases.service';
import { StockOpsService } from '../src/modules/trade/stock-ops.service';
import { StockLedgerService } from '../src/modules/accounting/inventory/stock-ledger.service';
import { DEFAULT_TENANT, makeServices, makeOrg, makeTrade } from './accounting-helpers';
import { runtimeDatabaseUrl } from './http-app';

const prisma = new PrismaService();
const s = makeServices(prisma);
const ledger = new StockLedgerService(prisma);
const purchases = new PurchasesService(prisma, new OutboxService(prisma));
const stockOps = new StockOpsService(prisma);
const runtime = new PrismaClient({ datasources: { db: { url: runtimeDatabaseUrl() } } });

async function code(p: Promise<unknown>) {
  try { await p; return 'OK'; } catch (e: any) { return e?.response?.code ?? e?.code ?? e?.meta?.message ?? e?.message; }
}
/** Код ошибки БД (RAISE 'КОД: …') из ошибки Prisma. */
async function dbCode(p: Promise<unknown>) {
  // Текст ошибки Prisma содержит и строки исходника теста — берём именно сообщение PostgreSQL.
  try { await p; return 'OK'; } catch (e: any) { return String(e?.meta?.message ?? e?.message).match(/\b(STOCK_LEDGER_ONLY|STOCK_MOVE_[A-Z]+|ACC_IMMUTABLE): /)?.[1] ?? String(e?.message).slice(-300); }
}
const qtyOf = async (productId: string, storeId: string) => String((await prisma.stock.findFirst({ where: { productId, storeId, binId: null } }))?.qty ?? 0);
const moves = (sourceId: string) => prisma.stockMovement.findMany({ where: { sourceId }, orderBy: [{ createdAt: 'asc' }, { sourceLine: 'asc' }, { qty: 'asc' }] });
const brief = (ms: any[]) => ms.map((m) => `${m.kind}:${m.qty}${m.reversesId ? ':R' : ''}`);
const scope = (ctx: { tenantId: string; organizationId: string; userId: string }): Scope => ({ ...ctx, role: 'chief_accountant' });

beforeAll(async () => {
  await prisma.$connect();
  await s.chart.bootstrap();
});
afterAll(async () => {
  await runtime.$disconnect();
  await prisma.$disconnect();
});

describe('FP-030: журнал складских движений', () => {
  it('проведение — движения с источником, строкой, версией и стоимостью из учёта; снятие — встречные; изменение — новая версия', async () => {
    const ctx = await makeOrg(prisma);
    const t = await makeTrade(prisma, ctx, { vatPayer: true });
    const d = await s.trade.create(ctx, {
      docType: 'SUPPLY', date: '2026-10-01', counterpartyId: t.supplier.id, storeId: t.s1.id, vatIncluded: true,
      lines: [{ productId: t.goods.id, qty: '10', price: '112' }, { productId: t.service.id, qty: '1', price: '500' }, { productId: t.goods2.id, qty: '4', price: '56' }],
    });
    await s.trade.post(ctx, d.id);
    const m1 = await moves(d.id);
    // Услуга — без движения; стоимость прихода — себестоимость без НДС (как в учёте), не сумма с НДС.
    // НДС 16%: 1120 → 965.52, 224 → 193.10 — ровно дебет счёта запасов в проводках документа.
    expect(m1.map((m) => [m.kind, m.sourceLine, m.qty.toString(), m.value?.toFixed(2), m.valueBasis, m.sourceVersion, m.storeId, m.sourceType])).toEqual([
      ['RECEIPT', 1, '10', '965.52', 'ACCOUNTING', 1, t.s1.id, 'TRADE_DOCUMENT'],
      ['RECEIPT', 3, '4', '193.10', 'ACCOUNTING', 1, t.s1.id, 'TRADE_DOCUMENT'],
    ]);
    const inv = (await s.trade.get(ctx, d.id)).entry!.postings.filter((p: any) => p.side === 'D' && p.account.code === '1330').map((p: any) => new Prisma.Decimal(p.amount).toFixed(2));
    expect(inv.sort()).toEqual(['193.10', '965.52']);
    expect(m1.every((m) => m.organizationId === ctx.organizationId && m.createdBy === ctx.userId)).toBe(true);
    expect(await qtyOf(t.goods.id, t.s1.id)).toBe('10');
    expect(await prisma.stock.count({ where: { productId: t.service.id } })).toBe(0);

    await s.trade.unpost(ctx, d.id);
    const m2 = await moves(d.id);
    expect(brief(m2)).toEqual(['RECEIPT:10', 'RECEIPT:4', 'RECEIPT:-10:R', 'RECEIPT:-4:R']);
    expect(m2[2]).toMatchObject({ reversesId: m1[0].id, valueBasis: 'REVERSAL' });
    expect(m2[2].value!.toFixed(2)).toBe('-965.52');
    expect(await qtyOf(t.goods.id, t.s1.id)).toBe('0');
    // Повторное снятие — без новых движений.
    await s.trade.unpost(ctx, d.id);
    expect((await moves(d.id)).length).toBe(4);

    await s.trade.post(ctx, d.id);
    const doc = await s.trade.get(ctx, d.id);
    await s.trade.update(ctx, d.id, { expectedVersion: doc.version, reason: 'пересчитали', lines: [{ productId: t.goods.id, qty: '8', price: '112' }] });
    const m3 = await moves(d.id);
    expect(brief(m3.slice(4))).toEqual(['RECEIPT:10', 'RECEIPT:4', 'RECEIPT:-10:R', 'RECEIPT:-4:R', 'RECEIPT:8']);
    expect(m3[8]).toMatchObject({ sourceVersion: 2, reason: 'пересчитали' });
    expect(await qtyOf(t.goods.id, t.s1.id)).toBe('8');
    expect(await qtyOf(t.goods2.id, t.s1.id)).toBe('0');

    // Пометка на удаление проведённого — встречные движения.
    await s.trade.cancel(ctx, d.id);
    expect(brief((await moves(d.id)).slice(9))).toEqual(['RECEIPT:-8:R']);
    expect(await qtyOf(t.goods.id, t.s1.id)).toBe('0');
    expect((await ledger.check(ctx)).ok).toBe(true);

    // Другая организация того же клиента (RLS по клиенту её не отсекает) — движений документа не видит.
    const other = await makeOrg(prisma);
    expect((await ledger.movements(other, { sourceId: d.id })).items).toEqual([]);
    expect((await ledger.movements(other, {})).total).toBe(0);
  });

  it('стоимость расхода и перемещения — из себестоимости; отчёт по товару с остатком на начало', async () => {
    const ctx = await makeOrg(prisma);
    const t = await makeTrade(prisma, ctx, { vatPayer: false });
    const sup = await s.trade.create(ctx, { docType: 'SUPPLY', date: '2026-10-01', counterpartyId: t.supplier.id, storeId: t.s1.id, lines: [{ productId: t.goods.id, qty: '3', price: '100' }] });
    await s.trade.post(ctx, sup.id);
    const sup2 = await s.trade.create(ctx, { docType: 'SUPPLY', date: '2026-10-02', counterpartyId: t.supplier.id, storeId: t.s1.id, lines: [{ productId: t.goods.id, qty: '3', price: '110' }] });
    await s.trade.post(ctx, sup2.id);
    // FIFO: 3 × 100 + 1 × 110 = 410; перемещение 2 шт — 220.
    const sale = await s.trade.create(ctx, { docType: 'DEMAND', date: '2026-10-03', counterpartyId: t.customer.id, storeId: t.s1.id, lines: [{ productId: t.goods.id, qty: '1', price: '300' }, { productId: t.goods.id, qty: '3', price: '300' }] });
    await s.trade.post(ctx, sale.id);
    const mv = await s.trade.create(ctx, { docType: 'MOVE', date: '2026-10-04', storeId: t.s1.id, storeToId: t.s2.id, lines: [{ productId: t.goods.id, qty: '2' }] });
    await s.trade.post(ctx, mv.id);

    const r = await ledger.movements(ctx, { productId: t.goods.id });
    expect(r.items.map((m: any) => [m.kind, m.qty.toString(), m.value, m.valueBasis, m.source?.number === undefined ? null : !!m.source])).toEqual([
      ['RECEIPT', '3', '300.00', 'ACCOUNTING', true],
      ['RECEIPT', '3', '330.00', 'ACCOUNTING', true],
      // две строки одного товара: 410 распределено по количеству (102.50 и остаток 307.50)
      ['SHIPMENT', '-1', '-102.50', 'COST', true],
      ['SHIPMENT', '-3', '-307.50', 'COST', true],
      ['TRANSFER_OUT', '-2', '-220.00', 'COST', true],
      ['TRANSFER_IN', '2', '220.00', 'COST', true],
    ]);
    expect(r.totals.qty).toBe('2');
    const card = await ledger.movements(ctx, { productId: t.goods.id, storeId: t.s1.id, from: '2026-10-03' });
    expect([card.totals.opening, card.totals.qty, card.items.length]).toEqual(['6', '-6', 3]);
    expect(await code(ledger.movements(ctx, { from: '2026-13-01' }))).toBe('BAD_DATE');
    // Остаток округления — последней строке: 30.02 на три строки по 1 шт = 10.01 + 10.01 + 10.00 (сумма сходится).
    const g = t.goods2.id;
    for (const [qty, price, date] of [['1', '10', '2026-10-01'], ['2', '10.01', '2026-10-02']] as const) {
      const x = await s.trade.create(ctx, { docType: 'SUPPLY', date, counterpartyId: t.supplier.id, storeId: t.s1.id, lines: [{ productId: g, qty, price }] });
      await s.trade.post(ctx, x.id);
    }
    const sale3 = await s.trade.create(ctx, { docType: 'DEMAND', date: '2026-10-05', counterpartyId: t.customer.id, storeId: t.s1.id, lines: [1, 2, 3].map(() => ({ productId: g, qty: '1', price: '50' })) });
    await s.trade.post(ctx, sale3.id);
    expect((await ledger.movements(ctx, { sourceId: sale3.id })).items.map((m: any) => m.value)).toEqual(['-10.01', '-10.01', '-10.00']);
    // Снятое с проведения — стоимость расхода не выдумывается (себестоимость отменена).
    await s.trade.unpost(ctx, sale.id);
    const after = await ledger.movements(ctx, { sourceId: sale.id });
    expect(after.items.map((m: any) => [m.qty.toString(), m.value, m.reversed])).toEqual([['-1', null, true], ['-3', null, true], ['1', null, false], ['3', null, false]]);
    expect((await ledger.check(ctx)).ok).toBe(true);
  });

  it('остаток меняется только журналом: прямая запись отклоняется БД; движения неизменяемы; обслуживание — не рабочей роли', async () => {
    const ctx = await makeOrg(prisma);
    const t = await makeTrade(prisma, ctx, { vatPayer: false });
    const d = await s.trade.create(ctx, { docType: 'SUPPLY', date: '2026-10-01', counterpartyId: t.supplier.id, storeId: t.s1.id, lines: [{ productId: t.goods.id, qty: '5', price: '10' }] });
    await s.trade.post(ctx, d.id);
    const row = await prisma.stock.findFirstOrThrow({ where: { productId: t.goods.id, storeId: t.s1.id } });
    const [m] = await moves(d.id);

    // Владелец БД (роль миграций) — тоже нет без режима обслуживания.
    expect(await dbCode(prisma.stock.update({ where: { id: row.id }, data: { qty: 100 } }))).toBe('STOCK_LEDGER_ONLY');
    expect(await dbCode(prisma.stock.create({ data: { productId: t.goods2.id, storeId: t.s1.id, qty: 1 } }))).toBe('STOCK_LEDGER_ONLY');
    expect(await dbCode(prisma.stock.delete({ where: { id: row.id } }))).toBe('STOCK_LEDGER_ONLY');
    expect(await dbCode(prisma.$executeRaw`UPDATE stock SET qty = qty + 1 WHERE id = ${row.id}`)).toBe('STOCK_LEDGER_ONLY');
    expect(await dbCode(prisma.stockMovement.update({ where: { id: m.id }, data: { qty: 50 } }))).toBe('ACC_IMMUTABLE');
    expect(await dbCode(prisma.stockMovement.delete({ where: { id: m.id } }))).toBe('ACC_IMMUTABLE');
    // Резерв — не количество: меняется напрямую.
    expect((await prisma.stock.update({ where: { id: row.id }, data: { reserved: 2 } })).reserved.toString()).toBe('2');

    // Встречное — только точно встречное и одно.
    const base = { organizationId: ctx.organizationId, productId: t.goods.id, storeId: t.s1.id, kind: 'RECEIPT', sourceType: 'TRADE_DOCUMENT', sourceId: d.id, occurredAt: new Date() };
    expect(await dbCode(prisma.stockMovement.create({ data: { ...base, qty: -3, reversesId: m.id } }))).toBe('STOCK_MOVE_REVERSAL');
    expect(await dbCode(prisma.stockMovement.create({ data: { ...base, qty: 0 } }))).toBe('STOCK_MOVE_ZERO');
    await prisma.stockMovement.create({ data: { ...base, qty: -5, reversesId: m.id } });
    expect(await code(prisma.stockMovement.create({ data: { ...base, qty: -5, reversesId: m.id } }))).toBe('P2002');
    expect(await qtyOf(t.goods.id, t.s1.id)).toBe('0');
    expect(await dbCode(prisma.stockMovement.create({ data: { ...base, qty: 1, sourceType: 'BACKFILL' } }))).toBe('STOCK_MOVE_SOURCE');

    // Рабочая роль (flowpos_app): режим обслуживания ей не включить — запрет остаётся.
    const asApp = <T>(fn: (tx: any) => Promise<T>) => runtime.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('flowpos.tenant_id', ${DEFAULT_TENANT}, true), set_config('flowpos.stock_maintenance', 'on', true)`;
      return fn(tx);
    });
    expect(await dbCode(asApp((tx) => tx.$executeRaw`UPDATE stock SET qty = 999 WHERE id = ${row.id}`))).toBe('STOCK_LEDGER_ONLY');
    expect(await dbCode(asApp((tx) => tx.$executeRaw`DELETE FROM stock_movements WHERE id = ${m.id}`))).toBe('ACC_IMMUTABLE');
    expect(await dbCode(asApp((tx) => tx.stockMovement.create({ data: { ...base, qty: 1, sourceType: 'BACKFILL' } })))).toBe('STOCK_MOVE_SOURCE');
    // Обычное движение рабочей ролью — проходит и меняет остаток (через триггер).
    await asApp((tx) => tx.stockMovement.create({ data: { ...base, qty: 2, sourceType: 'TEST', sourceId: 'app' } }));
    expect(await qtyOf(t.goods.id, t.s1.id)).toBe('2');
    expect((await ledger.check(ctx)).ok).toBe(true);
  });

  it('старые модули (приёмка, перемещение) — тоже движениями с источником; одна строка остатка без ячейки', async () => {
    const ctx = await makeOrg(prisma);
    const t = await makeTrade(prisma, ctx, { vatPayer: false });
    const sc = scope(ctx);
    const r1 = await purchases.createReceipt(sc, { date: '2026-10-01', storeId: t.s1.id, counterpartyId: t.supplier.id, status: 'POSTED', items: [{ productId: t.goods.id, qty: 4, price: 25 }] });
    const r2 = await purchases.createReceipt(sc, { date: '2026-10-01', storeId: t.s1.id, counterpartyId: t.supplier.id, status: 'POSTED', items: [{ productId: t.goods.id, qty: 6, price: 25 }] });
    // Раньше вторая приёмка добавляла вторую строку остатка (NULL ячейки не совпадали в ON CONFLICT).
    expect(await prisma.stock.count({ where: { productId: t.goods.id, storeId: t.s1.id } })).toBe(1);
    expect(await qtyOf(t.goods.id, t.s1.id)).toBe('10');
    expect((await moves(r1.id)).map((m) => [m.kind, m.qty.toString(), m.value?.toString(), m.valueBasis])).toEqual([['RECEIPT', '4', '100', 'DOCUMENT']]);
    expect(brief(await moves(r2.id))).toEqual(['RECEIPT:6']);
    const tr = await stockOps.createTransfer(sc, { storeId: t.s1.id, storeToId: t.s2.id, status: 'POSTED', items: [{ productId: t.goods.id, qty: 3 }] });
    expect(brief(await moves(tr.id))).toEqual(['TRANSFER_OUT:-3', 'TRANSFER_IN:3']);
    expect([await qtyOf(t.goods.id, t.s1.id), await qtyOf(t.goods.id, t.s2.id)]).toEqual(['7', '3']);
    // Черновик — без движений.
    const draft = await purchases.createReceipt(sc, { date: '2026-10-01', storeId: t.s1.id, counterpartyId: t.supplier.id, items: [{ productId: t.goods.id, qty: 1, price: 1 }] });
    expect(await moves(draft.id)).toEqual([]);
    expect((await ledger.check(ctx)).ok).toBe(true);
  });

  it('документ, проведённый до журнала: снятие — обратными движениями к начальному остатку, повторно не отменяются', async () => {
    const ctx = await makeOrg(prisma);
    const t = await makeTrade(prisma, ctx, { vatPayer: false });
    // Как до FP-030: документ проведён, движений нет (его количество — в начальном остатке BACKFILL).
    const old = await prisma.document.create({
      data: { docType: 'SUPPLY', date: new Date('2026-09-01'), status: 'POSTED', organizationId: ctx.organizationId, storeId: t.s1.id, counterpartyId: t.supplier.id, owner: 'PLATFORM', lines: { create: [{ lineNo: 1, productId: t.goods.id, qty: 5, price: 10, amount: 50 }] } },
    });
    await s.trade.unpost(ctx, old.id);
    expect((await moves(old.id)).map((m) => [m.qty.toString(), m.valueBasis, m.reversesId])).toEqual([['-5', 'PRE_LEDGER', null]]);
    await s.trade.post(ctx, old.id);
    await s.trade.unpost(ctx, old.id);
    // Отменено только новое проведение; обратное движение «до журнала» не отменяется второй раз.
    expect(brief(await moves(old.id))).toEqual(['RECEIPT:-5', 'RECEIPT:5', 'RECEIPT:-5:R']);
    expect(await qtyOf(t.goods.id, t.s1.id)).toBe('-5');
  });
});

describe('FP-030: приёмка поступления', () => {
  it('частичная приёмка по заказу: несколько поступлений, недостача и брак, остаток заказа, сумма претензии', async () => {
    const ctx = await makeOrg(prisma);
    const t = await makeTrade(prisma, ctx, { vatPayer: false });
    const order = await s.trade.create(ctx, { docType: 'PURCHASE_ORDER', date: '2026-10-01', counterpartyId: t.supplier.id, storeId: t.s1.id, lines: [{ productId: t.goods.id, qty: '10', price: '100' }, { productId: t.goods2.id, qty: '5', price: '40' }] });
    expect((await s.trade.get(ctx, order.id)).fulfillment).toMatchObject({ state: 'OPEN' });

    // Первое поступление: ожидается весь заказ, принято 6 из 10 (недостача), товар-2 не пришёл совсем.
    const r1 = await s.trade.fromBase(ctx, order.id, 'SUPPLY', '2026-10-02');
    expect(r1.lines.map((l: any) => [l.qty.toString(), l.expectedQty?.toString()])).toEqual([['10', '10'], ['5', '5']]);
    expect(await code(s.trade.update(ctx, r1.id, { expectedVersion: r1.version, lines: [{ productId: t.goods.id, qty: '6', price: '100', expectedQty: '10' }] }))).toBe('RECEIPT_REASON_REQUIRED');
    expect(await code(s.trade.update(ctx, r1.id, { expectedVersion: r1.version, lines: [{ productId: t.goods.id, qty: '6', price: '100', expectedQty: '10', discrepancyReason: 'SURPLUS' }] }))).toBe('RECEIPT_REASON');
    const u1 = await s.trade.update(ctx, r1.id, {
      expectedVersion: r1.version,
      lines: [
        { productId: t.goods.id, qty: '6', price: '100', expectedQty: '10', discrepancyReason: 'SHORTAGE' },
        { productId: t.goods2.id, qty: '0', price: '40', expectedQty: '5', discrepancyReason: 'SHORTAGE', discrepancyNote: 'не пришло' },
      ],
    });
    await s.trade.post(ctx, r1.id, undefined, u1.version);
    const v1 = await s.trade.get(ctx, r1.id);
    // Принятое — в остаток и учёт; непришедшая строка — без движения и проводок.
    expect(brief(v1.movements)).toEqual(['RECEIPT:6']);
    expect(v1.entry!.postings.map((p: any) => `${p.side}${p.account.code}:${p.amount}`).sort()).toEqual(['C3310:600', 'D1330:600']);
    expect(v1.receipt).toMatchObject({ hasDiscrepancy: true, claimAmount: '600.00', lines: [{ lineNo: 1, shortage: '4', accepted: '6' }, { lineNo: 2, shortage: '5', accepted: '0' }] });
    const f1 = (await s.trade.get(ctx, order.id)).fulfillment!;
    expect([f1.state, f1.lines.map((l: any) => l.remaining)]).toEqual(['PARTIAL', ['4', '5']]);

    // Второе поступление по остатку: 3 принято, 1 брак; товар-2 — 6 при ожидаемых 5 (излишек).
    const r2 = await s.trade.fromBase(ctx, order.id, 'SUPPLY', '2026-10-05');
    expect(r2.lines.map((l: any) => [l.qty.toString(), l.expectedQty?.toString()])).toEqual([['4', '4'], ['5', '5']]);
    const u2 = await s.trade.update(ctx, r2.id, {
      expectedVersion: r2.version,
      lines: [
        { productId: t.goods.id, qty: '3', price: '100', expectedQty: '4', rejectedQty: '1', discrepancyReason: 'DAMAGED', discrepancyNote: 'разбита упаковка' },
        { productId: t.goods2.id, qty: '6', price: '40', expectedQty: '5', discrepancyReason: 'SURPLUS' },
      ],
    });
    await s.trade.post(ctx, r2.id, undefined, u2.version);
    expect((await s.trade.get(ctx, r2.id)).receipt).toMatchObject({ claimAmount: '100.00', surplusAmount: '40.00' });
    const f2 = (await s.trade.get(ctx, order.id)).fulfillment!;
    expect([f2.state, f2.lines.map((l: any) => [l.fulfilled, l.remaining]), f2.overDelivered, f2.rejected, f2.documents.length])
      .toEqual(['PARTIAL', [['9', '1'], ['5', '0']], [{ productId: t.goods2.id, qty: '1' }], [{ productId: t.goods.id, qty: '1' }], 2]);
    expect([await qtyOf(t.goods.id, t.s1.id), await qtyOf(t.goods2.id, t.s1.id)]).toEqual(['9', '6']);

    const rep = await ledger.discrepancies(ctx, { from: '2026-10-01', to: '2026-10-31' });
    expect(rep.items.map((d: any) => [d.number, d.claimAmount, d.baseId])).toEqual([[v1.number, '600.00', order.id], [u2.number, '100.00', order.id]]);
    expect(rep.claimAmount).toBe('700.00');
    expect(rep.items[1].lines[0]).toMatchObject({ reason: 'DAMAGED', rejected: '1', product: { id: t.goods.id } });
    expect((await ledger.discrepancies(ctx, { from: '2026-10-03', to: '2026-10-31' })).items.length).toBe(1);

    // Третье поступление закрывает заказ.
    const r3 = await s.trade.fromBase(ctx, order.id, 'SUPPLY', '2026-10-06');
    expect(r3.lines.map((l: any) => [l.productId, l.qty.toString()])).toEqual([[t.goods.id, '1']]);
    await s.trade.post(ctx, r3.id);
    expect((await s.trade.get(ctx, order.id)).fulfillment!.state).toBe('FULFILLED');
    expect(await code(s.trade.fromBase(ctx, order.id, 'SUPPLY'))).toBe('BASE_FULFILLED');
  });

  it('проверки приёмки: поля только у поступления, ничего не принято, ноль без ожидаемого, причина «другое» с пояснением', async () => {
    const ctx = await makeOrg(prisma);
    const t = await makeTrade(prisma, ctx, { vatPayer: false });
    const sup = (lines: any[]) => s.trade.create(ctx, { docType: 'SUPPLY', date: '2026-10-01', counterpartyId: t.supplier.id, storeId: t.s1.id, lines });
    expect(await code(s.trade.create(ctx, { docType: 'DEMAND', date: '2026-10-01', counterpartyId: t.customer.id, storeId: t.s1.id, lines: [{ productId: t.goods.id, qty: '1', price: '1', expectedQty: '2' }] }))).toBe('RECEIPT_FIELDS');
    expect(await code(s.trade.create(ctx, { docType: 'DEMAND', date: '2026-10-01', counterpartyId: t.customer.id, storeId: t.s1.id, lines: [{ productId: t.goods.id, qty: '0', price: '1' }] }))).toBe('BAD_QTY');
    expect(await code(sup([{ productId: t.goods.id, qty: '0', price: '1' }]))).toBe('BAD_QTY');
    expect(await code(sup([{ productId: t.goods.id, qty: '0', price: '1', expectedQty: '3', discrepancyReason: 'SHORTAGE' }]))).toBe('NOTHING_ACCEPTED');
    expect(await code(sup([{ productId: t.goods.id, qty: '-1', price: '1' }]))).toBe('BAD_QTY');
    expect(await code(sup([{ productId: t.goods.id, qty: '1', price: '1', rejectedQty: '1', discrepancyReason: 'DAMAGED' }]))).toBe('RECEIPT_EXPECTED_REQUIRED');
    expect(await code(sup([{ productId: t.goods.id, qty: '2', price: '1', expectedQty: '2', discrepancyReason: 'SHORTAGE' }]))).toBe('RECEIPT_REASON');
    expect(await code(sup([{ productId: t.goods.id, qty: '1', price: '1', expectedQty: '2', discrepancyReason: 'OTHER' }]))).toBe('RECEIPT_REASON');
    expect(await code(sup([{ productId: t.goods.id, qty: '2', price: '1', expectedQty: '2', rejectedQty: '1', discrepancyReason: 'SHORTAGE' }]))).toBe('RECEIPT_REASON');
    expect(await code(sup([{ productId: t.goods.id, qty: '1', price: '1', expectedQty: '2', discrepancyReason: 'LOST' }]))).toBe('RECEIPT_REASON');
    const ok = await sup([{ productId: t.goods.id, qty: '1', price: '1', expectedQty: '2', discrepancyReason: 'OTHER', discrepancyNote: ' пересчёт ' }]);
    expect(ok.lines[0]).toMatchObject({ discrepancyReason: 'OTHER', discrepancyNote: 'пересчёт' });
    // Совпало с ожидаемым — расхождения нет.
    const exact = await sup([{ productId: t.goods.id, qty: '2', price: '1', expectedQty: '2' }]);
    expect((await s.trade.get(ctx, exact.id)).receipt).toMatchObject({ hasDiscrepancy: false, claimAmount: '0.00' });
  });

  it('поля приёмки входят в хэш версии: изменение причины — новая версия; документ без них хэшируется как раньше', async () => {
    const ctx = await makeOrg(prisma);
    const t = await makeTrade(prisma, ctx, { vatPayer: false });
    const d = await s.trade.create(ctx, { docType: 'SUPPLY', date: '2026-10-01', counterpartyId: t.supplier.id, storeId: t.s1.id, lines: [{ productId: t.goods.id, qty: '1', price: '5', expectedQty: '2', discrepancyReason: 'SHORTAGE' }] });
    const same = await s.trade.update(ctx, d.id, { expectedVersion: 1, lines: [{ productId: t.goods.id, qty: '1', price: '5', expectedQty: '2', discrepancyReason: 'SHORTAGE' }] });
    expect(same.version).toBe(1);
    const changed = await s.trade.update(ctx, d.id, { expectedVersion: 1, lines: [{ productId: t.goods.id, qty: '1', price: '5', expectedQty: '2', discrepancyReason: 'OTHER', discrepancyNote: 'уточнили' }] });
    expect(changed.version).toBe(2);
    const vs = await s.trade.versions(ctx, d.id);
    expect(new Set(vs.map((v) => v.hash)).size).toBe(2);
    expect((vs[1].snapshot as any).lines[0]).toMatchObject({ discrepancyReason: 'OTHER', expectedQty: '2' });
    const plain = await s.trade.create(ctx, { docType: 'SUPPLY', date: '2026-10-01', counterpartyId: t.supplier.id, storeId: t.s1.id, lines: [{ productId: t.goods.id, qty: '1', price: '5' }] });
    expect(Object.keys(((await s.trade.versions(ctx, plain.id))[0].snapshot as any).lines[0]).sort()).toEqual(['amount', 'discount', 'lineNo', 'price', 'productId', 'qty', 'vatRate']);
  });

  it('пробное проведение показывает движение остатка и ничего не пишет в журнал', async () => {
    const ctx = await makeOrg(prisma);
    const t = await makeTrade(prisma, ctx, { vatPayer: false });
    const d = await s.trade.create(ctx, { docType: 'SUPPLY', date: '2026-10-01', counterpartyId: t.supplier.id, storeId: t.s1.id, lines: [{ productId: t.goods.id, qty: '7', price: '3', expectedQty: '8', discrepancyReason: 'SHORTAGE' }] });
    const sim = await s.trade.simulate(ctx, d.id);
    expect(sim.stock).toEqual([{ storeId: t.s1.id, productId: t.goods.id, before: '0', after: '7', change: '7' }]);
    expect(await moves(d.id)).toEqual([]);
  });
});
