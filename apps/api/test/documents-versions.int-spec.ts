// FP-028: общие документы — ожидаемая версия, неизменяемая проведённая версия, конфликт повторного проведения,
// граф «основание / сторно / ЭСФ / исправление» на настоящей БД.
import { PrismaService } from '../src/prisma/prisma.service';
import { DocumentGraphService } from '../src/modules/accounting/documents/graph.service';
import { makeServices, makeOrg, makeTrade } from './accounting-helpers';

const prisma = new PrismaService();
const s = makeServices(prisma);
const graph = new DocumentGraphService(prisma);
const manual = (rows: { amount: string; dr: string; cr: string }[]) => ({ lines: rows.map((r) => ({ amount: r.amount, debit: { account: r.dr }, credit: { account: r.cr } })) });
async function code(p: Promise<unknown>) {
  try { await p; return 'OK'; } catch (e: any) { return e?.response?.code ?? e?.status ?? String(e?.message ?? e).match(/DOC_POSTED_IMMUTABLE|ACC_IMMUTABLE/)?.[0] ?? e?.message; }
}

beforeAll(async () => {
  await prisma.$connect();
  await s.chart.bootstrap();
});
afterAll(() => prisma.$disconnect());

describe('FP-028: торговые документы — версии', () => {
  it('изменение только с ожидаемой версией; устаревшая — 409; история версий с хэшем', async () => {
    const ctx = await makeOrg(prisma);
    const t = await makeTrade(prisma, ctx, { vatPayer: false });
    const d = await s.trade.create(ctx, { docType: 'SUPPLY', date: '2026-10-01', counterpartyId: t.supplier.id, storeId: t.s1.id, lines: [{ productId: t.goods.id, qty: '5', price: '100' }] });
    expect(d).toMatchObject({ version: 1, postedVersion: null });
    expect(await code(s.trade.update(ctx, d.id, { lines: [{ productId: t.goods.id, qty: '6', price: '100' }] }))).toBe('VERSION_REQUIRED');
    const v2 = await s.trade.update(ctx, d.id, { expectedVersion: 1, lines: [{ productId: t.goods.id, qty: '6', price: '100' }] });
    expect(v2.version).toBe(2);
    expect(await code(s.trade.update(ctx, d.id, { expectedVersion: 1, comment: 'устаревшая вкладка' }))).toBe('VERSION_CONFLICT');
    const h = await s.trade.versions(ctx, d.id);
    expect(h.map((x) => [x.version, x.action])).toEqual([[1, 'CREATE'], [2, 'UPDATE']]);
    expect(h[0].hash).toMatch(/^[0-9a-f]{64}$/);
    expect(h[0].hash).not.toBe(h[1].hash);
    expect((h[1].snapshot as any).lines[0].qty).toBe('6');
  });

  it('проведение: одно из параллельных, остальные 409; склад один раз; повтор — 409 с проведённой версией', async () => {
    const ctx = await makeOrg(prisma);
    const t = await makeTrade(prisma, ctx, { vatPayer: false });
    const d = await s.trade.create(ctx, { docType: 'SUPPLY', date: '2026-10-01', counterpartyId: t.supplier.id, storeId: t.s1.id, lines: [{ productId: t.goods.id, qty: '10', price: '100' }] });
    const r = await Promise.allSettled(Array.from({ length: 5 }, () => s.trade.post(ctx, d.id)));
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(r.filter((x) => x.status === 'rejected').map((x: any) => x.reason?.response?.code)).toEqual(Array(4).fill('DOC_ALREADY_POSTED'));
    expect((await prisma.stock.findFirst({ where: { productId: t.goods.id, storeId: t.s1.id } }))!.qty.toString()).toBe('10');
    expect(await prisma.accEntry.count({ where: { organizationId: ctx.organizationId, sourceId: d.id, status: 'ACTIVE' } })).toBe(1);
    const again: any = await s.trade.post(ctx, d.id).catch((e) => e.response);
    expect(again).toMatchObject({ code: 'DOC_ALREADY_POSTED', details: { postedVersion: 1 } });
    expect(await code(s.trade.post(ctx, d.id, undefined, 7))).toBe('VERSION_CONFLICT');
  });

  it('проведённая версия неизменяема: правка — новой версией с причиной; БД не даёт изменить «на месте»', async () => {
    const ctx = await makeOrg(prisma);
    const t = await makeTrade(prisma, ctx, { vatPayer: false });
    const d = await s.trade.create(ctx, { docType: 'SUPPLY', date: '2026-10-01', counterpartyId: t.supplier.id, storeId: t.s1.id, lines: [{ productId: t.goods.id, qty: '4', price: '100' }], status: 'POSTED' });
    expect(d).toMatchObject({ status: 'POSTED', version: 1, postedVersion: 1 });
    // Прямая правка проведённого — отказ БД (шапка, строки: вставка, изменение, удаление).
    expect(await code(prisma.document.update({ where: { id: d.id }, data: { total: 1 } }))).toBe('DOC_POSTED_IMMUTABLE');
    expect(await code(prisma.documentLine.updateMany({ where: { documentId: d.id }, data: { qty: 99 } }))).toBe('DOC_POSTED_IMMUTABLE');
    expect(await code(prisma.documentLine.deleteMany({ where: { documentId: d.id } }))).toBe('DOC_POSTED_IMMUTABLE');
    expect(await code(prisma.documentLine.create({ data: { documentId: d.id, lineNo: 9, productId: t.goods.id, qty: 1 } }))).toBe('DOC_POSTED_IMMUTABLE');
    // Служебные поля (статус обмена) — можно.
    await prisma.document.update({ where: { id: d.id }, data: { syncStatus: 'DIRTY' } });

    expect(await code(s.trade.update(ctx, d.id, { expectedVersion: 1, lines: [{ productId: t.goods.id, qty: '3', price: '100' }] }))).toBe('REASON_REQUIRED');
    const v2 = await s.trade.update(ctx, d.id, { expectedVersion: 1, reason: 'Пересчитали поставку', lines: [{ productId: t.goods.id, qty: '3', price: '100' }] });
    expect(v2).toMatchObject({ status: 'POSTED', version: 2, postedVersion: 2 });
    expect((await prisma.stock.findFirst({ where: { productId: t.goods.id, storeId: t.s1.id } }))!.qty.toString()).toBe('3');
    const h = await s.trade.versions(ctx, d.id);
    expect(h.map((x) => [x.version, x.action])).toEqual([[1, 'CREATE'], [1, 'POST'], [2, 'UPDATE'], [2, 'POST']]);
    expect((h[1].snapshot as any).lines[0].qty).toBe('4'); // прежняя проведённая версия — как была
    expect(h[1].hash).toBe(h[0].hash); // проведение не меняет содержимое
    // История неизменяема.
    expect(await code(prisma.documentVersion.update({ where: { id: h[1].id }, data: { reason: 'подмена' } }))).toBe('ACC_IMMUTABLE');
    expect(await code(prisma.documentVersion.delete({ where: { id: h[1].id } }))).toBe('ACC_IMMUTABLE');
    // Снятие проведения: версия без изменений, проведённой больше нет.
    const un = await s.trade.unpost(ctx, d.id, undefined, 2);
    expect(un).toMatchObject({ status: 'DRAFT', version: 2, postedVersion: null });
  });
});

describe('FP-028: бухгалтерские документы — версии', () => {
  it('проведённая версия, перепроведение новой версией, хэш, запрет правки «на месте»', async () => {
    const ctx = await makeOrg(prisma);
    const d = await s.docs.create(ctx, { docType: 'MANUAL_OPERATION', date: '2026-10-03', body: manual([{ amount: '100', dr: '7170', cr: '5030' }]) });
    const p = await s.docs.post(ctx, d.id, { expectedVersion: 1 });
    expect(p).toMatchObject({ status: 'POSTED', postedVersion: 1 });
    expect(await code(prisma.accDocument.update({ where: { id: d.id }, data: { amount: 5 } }))).toBe('DOC_POSTED_IMMUTABLE');
    expect(await code(s.docs.update(ctx, d.id, { body: manual([{ amount: '200', dr: '7170', cr: '5030' }]) } as any))).toBe('VERSION_REQUIRED');
    const u = await s.docs.update(ctx, d.id, { expectedVersion: 1, reason: 'Исправили сумму', body: manual([{ amount: '200', dr: '7170', cr: '5030' }]) });
    expect(u).toMatchObject({ version: 2, postedVersion: 2, status: 'POSTED' });
    const v = await prisma.accDocumentVersion.findMany({ where: { documentId: d.id }, orderBy: { createdAt: 'asc' } });
    expect(v.map((x) => [x.version, x.action])).toEqual([[1, 'CREATE'], [1, 'POST'], [2, 'UPDATE']]);
    expect(v.every((x) => /^[0-9a-f]{64}$/.test(x.hash!))).toBe(true);
    expect(v[1].hash).toBe(v[0].hash);
    expect(v[2].hash).not.toBe(v[1].hash);
    expect(await code(s.docs.unpost(ctx, d.id, { expectedVersion: 1 }))).toBe('VERSION_CONFLICT');
  });
});

describe('FP-028: граф документов', () => {
  it('заказ → отгрузка → ЭСФ → исправленный ЭСФ; сторно; в обе стороны; без чужих связей', async () => {
    const ctx = await makeOrg(prisma);
    const t = await makeTrade(prisma, ctx, { vatPayer: false });
    await s.trade.create(ctx, { docType: 'SUPPLY', date: '2026-10-01', counterpartyId: t.supplier.id, storeId: t.s1.id, lines: [{ productId: t.goods.id, qty: '10', price: '100' }], status: 'POSTED' });
    const order = await s.trade.create(ctx, { docType: 'CUSTOMER_ORDER', date: '2026-10-02', counterpartyId: t.customer.id, storeId: t.s1.id, lines: [{ productId: t.goods.id, qty: '2', price: '300' }], status: 'POSTED' });
    const demand = await s.trade.fromBase(ctx, order.id, 'DEMAND', '2026-10-03');
    const esf = await prisma.esfInvoice.create({ data: { organizationId: ctx.organizationId, direction: 'OUTBOUND', num: `G${Date.now()}`, date: new Date('2026-10-03'), turnoverDate: new Date('2026-10-03'), body: '<x/>', bodyHash: 'x', sourceDocId: demand.id } });
    const fix = await prisma.esfInvoice.create({ data: { organizationId: ctx.organizationId, direction: 'OUTBOUND', invoiceType: 'ADDITIONAL_INVOICE', num: `G${Date.now()}A`, date: new Date('2026-10-04'), turnoverDate: new Date('2026-10-04'), body: '<x/>', bodyHash: 'x', relatedInvoiceId: esf.id } });

    const g = await graph.graph(ctx, 'ESF', fix.id);
    expect(g.root).toBe(`ESF:${fix.id}`);
    expect(new Set(g.nodes.map((n) => n.key))).toEqual(new Set([`TRADE:${order.id}`, `TRADE:${demand.id}`, `ESF:${esf.id}`, `ESF:${fix.id}`]));
    expect(g.edges).toEqual(expect.arrayContaining([
      { from: `TRADE:${demand.id}`, to: `TRADE:${order.id}`, kind: 'BASED_ON' },
      { from: `ESF:${esf.id}`, to: `TRADE:${demand.id}`, kind: 'ESF_FOR' },
      { from: `ESF:${fix.id}`, to: `ESF:${esf.id}`, kind: 'CORRECTION_OF' },
    ]));
    expect((await graph.graph(ctx, 'ESF', fix.id, 1)).nodes.map((n) => n.key).sort()).toEqual([`ESF:${esf.id}`, `ESF:${fix.id}`].sort());

    // Сторно бухгалтерского документа — связь REVERSAL_OF.
    const m = await s.docs.create(ctx, { docType: 'MANUAL_OPERATION', date: '2026-10-05', body: manual([{ amount: '50', dr: '7170', cr: '5030' }]) });
    await s.docs.post(ctx, m.id);
    const st = await s.docs.storno(ctx, m.id, { date: '2026-10-06', reason: 'Ошибка в сумме' });
    expect((await graph.graph(ctx, 'ACC', m.id)).edges).toEqual([{ from: `ACC:${st.id}`, to: `ACC:${m.id}`, kind: 'REVERSAL_OF' }]);

    // Чужая организация: основание другой организации — отказ сервиса; прямой записью — связь не появляется; граф — 404.
    const other = await makeOrg(prisma);
    const ot = await makeTrade(prisma, other, { vatPayer: false });
    const foreign = await s.trade.create(other, { docType: 'CUSTOMER_ORDER', date: '2026-10-02', counterpartyId: ot.customer.id, storeId: ot.s1.id, lines: [{ productId: ot.goods.id, qty: '1', price: '1' }] });
    expect(await code(s.trade.create(ctx, { docType: 'DEMAND', date: '2026-10-03', counterpartyId: t.customer.id, storeId: t.s1.id, baseId: foreign.id, lines: [{ productId: t.goods.id, qty: '1', price: '1' }] }))).toBe('REF_FOREIGN');
    await prisma.document.update({ where: { id: demand.id }, data: { attributes: { baseId: foreign.id } } });
    expect(await prisma.documentLink.count({ where: { fromId: demand.id, kind: 'BASED_ON' } })).toBe(0);
    expect(await code(graph.graph(ctx, 'TRADE', foreign.id))).toBe('DOC_NOT_FOUND');
    // Связи чужой организации (например, записанные в обход триггеров) обход не использует: свой X и свой Y,
    // связанные только через чужой F, связанными не показываются.
    await prisma.documentLink.createMany({ data: [
      { organizationId: other.organizationId, fromType: 'TRADE', fromId: foreign.id, toType: 'TRADE', toId: order.id, kind: 'BASED_ON' },
      { organizationId: other.organizationId, fromType: 'TRADE', fromId: foreign.id, toType: 'ACC', toId: m.id, kind: 'BASED_ON' },
    ] });
    const isolated = await graph.graph(ctx, 'ACC', m.id);
    expect(isolated.nodes.map((n) => n.key).sort()).toEqual([`ACC:${m.id}`, `ACC:${st.id}`].sort());
    expect(await code(graph.graph(ctx, 'NOPE', demand.id))).toBe('BAD_TYPE');
  });
});
