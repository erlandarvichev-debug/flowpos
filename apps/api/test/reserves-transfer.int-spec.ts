// FP-032: резервы (свободно = факт − резерв, нет двойного резерва при параллельных запросах, расход не забирает чужой
// резерв), перемещение в два этапа через «В пути» и адреса хранения (ячейки) — на настоящей БД.
import { Prisma } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { WarehousesService } from '../src/modules/catalog/warehouses.service';
import { StockLedgerService } from '../src/modules/accounting/inventory/stock-ledger.service';
import { OrgContext } from '../src/modules/accounting/access/org-context';
import { makeServices, makeOrg, makeTrade } from './accounting-helpers';

const prisma = new PrismaService();
const s = makeServices(prisma);
const warehouses = new WarehousesService(prisma);
const ledger = new StockLedgerService(prisma);
const D = Prisma.Decimal;

async function code(p: Promise<unknown>) {
  try { await p; return 'OK'; } catch (e: any) {
    return e?.response?.code ?? String(e?.meta?.message ?? e?.message).match(/\b(RESERVE_[A-Z_]+|STOCK_LEDGER_ONLY): /)?.[1] ?? e?.code ?? e?.message;
  }
}
const avail = async (productId: string, storeId: string) => new D((await prisma.$queryRaw<{ a: string }[]>`SELECT fp_stock_available(${productId}, ${storeId})::text AS a`)[0].a).toString();
const stockOf = async (productId: string, storeId: string, binId: string | null = null) => String((await prisma.stock.findFirst({ where: { productId, storeId, binId } }))?.qty ?? 0);
const reservedOf = async (productId: string, storeId: string) => String((await prisma.stock.findFirst({ where: { productId, storeId, binId: null } }))?.reserved ?? 0);
async function bal(ctx: OrgContext, f: { storeId: string }) {
  const rows = await prisma.accPosting.findMany({ where: { organizationId: ctx.organizationId, isActive: true, account: { code: '1330' }, ...f } });
  return rows.reduce((a, r) => (r.side === 'D' ? a.plus(r.amount) : a.minus(r.amount)), new D(0)).toFixed(2);
}

beforeAll(async () => {
  await prisma.$connect();
  await s.chart.bootstrap();
});
afterAll(() => prisma.$disconnect());

async function world() {
  const ctx = await makeOrg(prisma);
  const t = await makeTrade(prisma, ctx, { vatPayer: false });
  const sup = (qty: string, storeId = t.s1.id, productId = t.goods.id, extra: any = {}) =>
    s.trade.create(ctx, { docType: 'SUPPLY', date: '2026-10-01', counterpartyId: t.supplier.id, storeId, status: 'POSTED', lines: [{ productId, qty, price: '100', ...extra }] });
  const order = (qty: string, productId = t.goods.id) =>
    s.trade.create(ctx, { docType: 'CUSTOMER_ORDER', date: '2026-10-02', counterpartyId: t.customer.id, storeId: t.s1.id, lines: [{ productId, qty, price: '200' }] });
  const demand = (qty: string, extra: any = {}) =>
    s.trade.create(ctx, { docType: 'DEMAND', date: '2026-10-03', counterpartyId: t.customer.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty, price: '200' }], ...extra });
  return { ctx, t, sup, order, demand };
}

describe('FP-032: резервы', () => {
  it('свободно = факт − резерв; резерв — только из свободного, частично, без двойного резерва строки', async () => {
    const { ctx, t, sup, order } = await world();
    await sup('10');
    const o1 = await order('6');
    const r1 = await s.trade.reserve(ctx, o1.id);
    expect(r1.lines).toEqual([{ lineNo: 1, productId: t.goods.id, ordered: '6', shipped: '0', reserved: '6', shortfall: '0' }]);
    expect([await stockOf(t.goods.id, t.s1.id), await reservedOf(t.goods.id, t.s1.id), await avail(t.goods.id, t.s1.id)]).toEqual(['10', '6', '4']);
    // Повтор резерва того же заказа — не удваивает.
    expect((await s.trade.reserve(ctx, o1.id)).lines[0].reserved).toBe('6');
    expect(await reservedOf(t.goods.id, t.s1.id)).toBe('6');
    const o2 = await order('6');
    expect((await s.trade.reserve(ctx, o2.id)).lines[0]).toMatchObject({ reserved: '4', shortfall: '2' });
    expect(await avail(t.goods.id, t.s1.id)).toBe('0');
    const o3 = await order('1');
    expect((await s.trade.reserve(ctx, o3.id)).lines[0]).toMatchObject({ reserved: '0', shortfall: '1' });
    expect((await s.trade.get(ctx, o1.id)).reservations.map((r: any) => [r.qty.toString(), r.remaining.toString()])).toEqual([['6', '6']]);
    // Снять резерв; пометка заказа на удаление — тоже снимает.
    await s.trade.releaseReserve(ctx, o1.id);
    expect(await reservedOf(t.goods.id, t.s1.id)).toBe('4');
    await s.trade.cancel(ctx, o2.id);
    expect([await reservedOf(t.goods.id, t.s1.id), await avail(t.goods.id, t.s1.id)]).toEqual(['0', '10']);
    expect((await prisma.stockReservation.findMany({ where: { sourceId: o2.id } })).map((r) => r.closeReason)).toEqual(['ORDER_CANCELLED']);
    // Изменение строк заказа с резервом — резерв подгоняется.
    const o4 = await order('5');
    await s.trade.reserve(ctx, o4.id);
    await s.trade.update(ctx, o4.id, { expectedVersion: 1, lines: [{ productId: t.goods.id, qty: '2', price: '200' }] });
    expect(await reservedOf(t.goods.id, t.s1.id)).toBe('2');
    expect(await code(s.trade.reserve(ctx, (await sup('1')).id))).toBe('RESERVE_NOT_ORDER');
  });

  it('параллельные резервы не занимают одно и то же количество (БД под блокировкой)', async () => {
    const { ctx, t, sup, order } = await world();
    await sup('10');
    const orders = await Promise.all([1, 2, 3, 4].map(() => order('8')));
    const res = await Promise.allSettled(orders.map((o) => s.trade.reserve(ctx, o.id)));
    const reserved = res.map((r) => (r.status === 'fulfilled' ? new D(r.value.lines[0].reserved) : new D(0))).reduce((a, x) => a.plus(x), new D(0));
    expect(reserved.lte(10)).toBe(true);
    expect(await reservedOf(t.goods.id, t.s1.id)).toBe(reserved.toString());
    expect(new D(await avail(t.goods.id, t.s1.id)).gte(0)).toBe(true);
    // Одна и та же строка параллельно — один действующий резерв.
    const o = await order('3');
    await Promise.allSettled([s.trade.reserve(ctx, o.id), s.trade.reserve(ctx, o.id), s.trade.reserve(ctx, o.id)]);
    expect(await prisma.stockReservation.count({ where: { sourceId: o.id, remaining: { gt: 0 } } })).toBeLessThanOrEqual(1);
    // Прямо в БД: два резерва по 8 при свободных 10 параллельно — второй отклонён.
    const { ctx: c2, t: t2, sup: sup2, order: order2 } = await world();
    await sup2('10');
    const [a, b] = await Promise.all([order2('8'), order2('8')]);
    const ins = (src: string) => prisma.stockReservation.create({ data: { organizationId: c2.organizationId, productId: t2.goods.id, storeId: t2.s1.id, qty: 8, remaining: 8, sourceId: src, sourceLine: 1 } });
    const both = await Promise.allSettled([ins(a.id), ins(b.id)]);
    expect(both.filter((x) => x.status === 'fulfilled').length).toBe(1);
    expect(await code(ins(a.id + 'x'))).toBe('RESERVE_INSUFFICIENT');
  });

  it('расход не забирает чужой резерв; отгрузка по заказу расходует его резерв', async () => {
    const { ctx, t, sup, order, demand } = await world();
    await sup('10');
    const o = await order('6');
    await s.trade.reserve(ctx, o.id);
    expect(await code(demand('5'))).toBe('RESERVED_STOCK');
    expect(await code(s.trade.create(ctx, { docType: 'LOSS', date: '2026-10-03', storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '5' }] }))).toBe('RESERVED_STOCK');
    expect(await code(s.trade.create(ctx, { docType: 'MOVE', date: '2026-10-03', storeId: t.s1.id, storeToId: t.s2.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '5' }] }))).toBe('RESERVED_STOCK');
    expect(await stockOf(t.goods.id, t.s1.id)).toBe('10'); // отклонённое ничего не списало
    expect((await demand('4')).status).toBe('POSTED'); // свободные 4 — можно
    const ship = await s.trade.fromBase(ctx, o.id, 'DEMAND', '2026-10-04');
    await s.trade.post(ctx, ship.id);
    expect([await stockOf(t.goods.id, t.s1.id), await reservedOf(t.goods.id, t.s1.id)]).toEqual(['0', '0']);
    expect((await prisma.stockReservation.findFirstOrThrow({ where: { sourceId: o.id } })).closeReason).toBe('SHIPPED');
    // Частичная отгрузка — остаток резерва остаётся; перерезерв учитывает отгруженное.
    await sup('10');
    const o2 = await order('5');
    await s.trade.reserve(ctx, o2.id);
    const part = await s.trade.create(ctx, { docType: 'DEMAND', date: '2026-10-05', counterpartyId: t.customer.id, storeId: t.s1.id, baseId: o2.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '2', price: '200' }] });
    expect(part.status).toBe('POSTED');
    expect(await reservedOf(t.goods.id, t.s1.id)).toBe('3');
    expect((await s.trade.reserve(ctx, o2.id)).lines[0]).toMatchObject({ shipped: '2', reserved: '3', shortfall: '0' });
  });

  it('резерв в БД: не увеличить, не удалить, не записать напрямую в остаток', async () => {
    const { ctx, t, sup, order } = await world();
    await sup('5');
    const o = await order('2');
    await s.trade.reserve(ctx, o.id);
    const r = await prisma.stockReservation.findFirstOrThrow({ where: { sourceId: o.id } });
    expect(await code(prisma.stockReservation.update({ where: { id: r.id }, data: { remaining: 3 } }))).toBe('RESERVE_IMMUTABLE');
    expect(await code(prisma.stockReservation.update({ where: { id: r.id }, data: { qty: 1 } }))).toBe('RESERVE_IMMUTABLE');
    expect(await code(prisma.stockReservation.delete({ where: { id: r.id } }))).toBe('RESERVE_IMMUTABLE');
    const row = await prisma.stock.findFirstOrThrow({ where: { productId: t.goods.id, storeId: t.s1.id, binId: null } });
    expect(await code(prisma.stock.update({ where: { id: row.id }, data: { reserved: 0 } }))).toBe('STOCK_LEDGER_ONLY');
    expect(await reservedOf(t.goods.id, t.s1.id)).toBe('2');
    expect(await code(prisma.stockReservation.create({ data: { organizationId: ctx.organizationId, productId: t.goods.id, storeId: t.s1.id, qty: 4, remaining: 4, sourceId: 'x', sourceLine: 1 } }))).toBe('RESERVE_INSUFFICIENT');
  });
});

describe('FP-032: перемещение в два этапа', () => {
  it('отгрузка на «В пути», приёмка частями, остаток в пути виден; учёт по складам; зависимости', async () => {
    const { ctx, t, sup } = await world();
    await sup('10');
    const ship = await s.trade.create(ctx, { docType: 'MOVE', date: '2026-10-02', storeId: t.s1.id, storeToId: t.s2.id, twoStage: true, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '6' }] });
    const transit = await prisma.store.findFirstOrThrow({ where: { organizationId: ctx.organizationId, isTransit: true } });
    expect([ship.storeToId, (ship.attributes as any).destinationStoreId]).toEqual([transit.id, t.s2.id]);
    expect([await stockOf(t.goods.id, t.s1.id), await stockOf(t.goods.id, transit.id), await stockOf(t.goods.id, t.s2.id)]).toEqual(['4', '6', '0']);
    expect(ship.transit).toMatchObject({ state: 'IN_TRANSIT', lines: [{ shipped: '6', received: '0', inTransit: '6' }] });
    expect((await s.trade.inTransit(ctx)).map((x: any) => x.id)).toEqual([ship.id]);
    expect([await bal(ctx, { storeId: t.s1.id }), await bal(ctx, { storeId: transit.id })]).toEqual(['400.00', '600.00']);

    expect(await code(s.trade.receive(ctx, ship.id, { date: '2026-10-01' }))).toBe('RECEIVE_BEFORE_SHIP');
    expect(await code(s.trade.receive(ctx, ship.id, { date: '2026-10-03', lines: [{ productId: t.goods.id, qty: '7' }] }))).toBe('RECEIVE_TOO_MUCH');
    const r1 = await s.trade.receive(ctx, ship.id, { date: '2026-10-03', lines: [{ productId: t.goods.id, qty: '4' }] });
    expect([r1.storeId, r1.storeToId, r1.status]).toEqual([transit.id, t.s2.id, 'POSTED']);
    expect((await s.trade.get(ctx, ship.id)).transit).toMatchObject({ state: 'PARTIAL', lines: [{ received: '4', inTransit: '2' }] });
    await s.trade.receive(ctx, ship.id, { date: '2026-10-04' });
    expect((await s.trade.get(ctx, ship.id)).transit!.state).toBe('RECEIVED');
    expect(await s.trade.inTransit(ctx)).toEqual([]);
    expect([await stockOf(t.goods.id, transit.id), await stockOf(t.goods.id, t.s2.id)]).toEqual(['0', '6']);
    expect([await bal(ctx, { storeId: transit.id }), await bal(ctx, { storeId: t.s2.id })]).toEqual(['0.00', '600.00']);
    expect(await code(s.trade.receive(ctx, ship.id))).toBe('TRANSFER_RECEIVED');
    // Отгрузку с приёмками не снять; после снятия приёмок — можно.
    expect(await code(s.trade.unpost(ctx, ship.id))).toBe('TRANSFER_RECEIVED_DEPENDS');
    expect(await code(s.trade.cancel(ctx, ship.id))).toBe('TRANSFER_RECEIVED_DEPENDS');
    for (const r of (await s.trade.get(ctx, ship.id)).transit!.receipts) await s.trade.unpost(ctx, r.id);
    expect((await s.trade.unpost(ctx, ship.id)).status).toBe('DRAFT');
    expect([await stockOf(t.goods.id, t.s1.id), await stockOf(t.goods.id, transit.id), await stockOf(t.goods.id, t.s2.id)]).toEqual(['10', '0', '0']);
    expect((await ledger.check(ctx)).ok).toBe(true);
  });

  it('«В пути» — служебный: не в списке складов, вручную только списание недостачи; не в два этапа — ошибка', async () => {
    const { ctx, t, sup } = await world();
    await sup('3');
    await s.trade.create(ctx, { docType: 'MOVE', date: '2026-10-02', storeId: t.s1.id, storeToId: t.s2.id, twoStage: true, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '3' }] });
    const transit = await prisma.store.findFirstOrThrow({ where: { organizationId: ctx.organizationId, isTransit: true } });
    const scope = { tenantId: ctx.tenantId, organizationId: ctx.organizationId, userId: ctx.userId };
    expect((await warehouses.findAll(scope)).map((w) => w.id)).not.toContain(transit.id);
    expect(await code(s.trade.create(ctx, { docType: 'DEMAND', date: '2026-10-03', counterpartyId: t.customer.id, storeId: transit.id, lines: [{ productId: t.goods.id, qty: '1', price: '1' }] }))).toBe('STORE_TRANSIT');
    expect(await code(s.trade.create(ctx, { docType: 'MOVE', date: '2026-10-03', storeId: t.s1.id, storeToId: transit.id, lines: [{ productId: t.goods.id, qty: '1' }] }))).toBe('STORE_TRANSIT');
    expect(await code(s.trade.create(ctx, { docType: 'SUPPLY', date: '2026-10-03', counterpartyId: t.supplier.id, storeId: t.s1.id, twoStage: true, lines: [{ productId: t.goods.id, qty: '1', price: '1' }] }))).toBe('BAD_TWO_STAGE');
    const loss = await s.trade.create(ctx, { docType: 'LOSS', date: '2026-10-04', storeId: transit.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '1' }] });
    expect(loss.status).toBe('POSTED');
    expect(await stockOf(t.goods.id, transit.id)).toBe('2');
    // Флаг «В пути» из запроса не принимается — ни при изменении, ни при создании склада.
    await warehouses.update(scope, t.s1.id, { isTransit: true });
    expect((await prisma.store.findUniqueOrThrow({ where: { id: t.s1.id } })).isTransit).toBe(false);
    const made = await warehouses.create(scope, { name: `Склад ${Date.now()}`, isTransit: true });
    expect((await prisma.store.findUniqueOrThrow({ where: { id: made.id } })).isTransit).toBe(false);
  });
});

describe('FP-032: адреса хранения (ячейки)', () => {
  it('приход в ячейку, перемещение между ячейками склада без проводок, чужая ячейка, непустую не выключить', async () => {
    const { ctx, t, sup } = await world();
    const scope = { tenantId: ctx.tenantId, organizationId: ctx.organizationId, userId: ctx.userId };
    const a1 = await warehouses.createBin(scope, t.s1.id, { name: 'Стеллаж A, полка 1', code: 'A-1' });
    const a2 = await warehouses.createBin(scope, t.s1.id, { name: 'Стеллаж A, полка 2', code: 'A-2' });
    const b1 = await warehouses.createBin(scope, t.s2.id, { name: 'B-1', code: 'B-1' });
    expect(await code(warehouses.createBin(scope, t.s1.id, { name: 'дубль', code: 'A-1' }))).toBe('BIN_CODE_TAKEN');
    expect(await code(sup('5', t.s1.id, t.goods.id, { binId: b1.id }))).toBe('BIN_FOREIGN');
    await sup('5', t.s1.id, t.goods.id, { binId: a1.id });
    expect(await stockOf(t.goods.id, t.s1.id, a1.id)).toBe('5');
    expect(await code(s.trade.create(ctx, { docType: 'MOVE', date: '2026-10-02', storeId: t.s1.id, storeToId: t.s1.id, lines: [{ productId: t.goods.id, qty: '1' }] }))).toBe('MOVE_SAME_STORE');
    const mv = await s.trade.create(ctx, { docType: 'MOVE', date: '2026-10-02', storeId: t.s1.id, storeToId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '3', binId: a1.id, binToId: a2.id }] });
    expect([mv.status, mv.entry]).toEqual(['POSTED', null]);
    expect(mv.lines[0]).toMatchObject({ bin: { code: 'A-1' }, binTo: { code: 'A-2' } });
    expect([await stockOf(t.goods.id, t.s1.id, a1.id), await stockOf(t.goods.id, t.s1.id, a2.id)]).toEqual(['2', '3']);
    expect(await bal(ctx, { storeId: t.s1.id })).toBe('500.00');
    // Свободно по складу — по всем ячейкам.
    expect(await avail(t.goods.id, t.s1.id)).toBe('5');
    expect(await code(warehouses.updateBin(scope, t.s1.id, a2.id, { isActive: false }))).toBe('BIN_NOT_EMPTY');
    await s.trade.unpost(ctx, mv.id);
    expect((await warehouses.updateBin(scope, t.s1.id, a2.id, { isActive: false })).isActive).toBe(false);
    expect(await code(sup('1', t.s1.id, t.goods.id, { binId: a2.id }))).toBe('BIN_FOREIGN'); // выключенная — нельзя
    expect((await ledger.check(ctx)).ok).toBe(true);
  });
});
