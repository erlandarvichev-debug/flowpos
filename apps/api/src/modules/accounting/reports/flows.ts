import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AccError } from '../common/acc-error';
import { D } from '../common/money';
import { OrgContext } from '../access/org-context';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const kz = (d: string) => new Date(`${d}T00:00:00+05:00`).toISOString();
function period(q: { from?: string; to?: string }) {
  const to = q.to ?? new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10);
  const from = q.from ?? `${to.slice(0, 8)}01`;
  if (!DAY.test(from) || !DAY.test(to)) throw new AccError('BAD_DATE', 'Период: даты ГГГГ-ММ-ДД');
  if (from > to) throw new AccError('BAD_PERIOD', 'Начало периода позже конца');
  return { from, to, start: kz(from), end: new Date(Date.parse(kz(to)) + 86400000).toISOString() };
}

/**
 * Обороты товаров: на начало, приход, расход, на конец — количество и себестоимость по данным учёта (счета запасов 13xx,
 * аналитика «товар»). Фильтр по складу. Перемещения между складами видны при выборе склада, в целом по организации — нет.
 */
export async function stockTurnover(prisma: PrismaService, ctx: OrgContext, q: { from?: string; to?: string; storeId?: string; search?: string; groupId?: string }) {
  const p = period(q);
  const store = q.storeId ? Prisma.sql`AND p.store_id = ${q.storeId}` : Prisma.empty;
  const rows = await prisma.$queryRaw<{ product_id: string; oq: string; os: string; iq: string; isum: string; xq: string; xs: string }[]>`
    SELECT p.product_id,
      SUM(CASE WHEN p.date < ${p.start}::timestamp THEN (CASE WHEN p.side = 'D' THEN 1 ELSE -1 END) * coalesce(p.quantity, 0) ELSE 0 END)::text AS oq,
      SUM(CASE WHEN p.date < ${p.start}::timestamp THEN (CASE WHEN p.side = 'D' THEN 1 ELSE -1 END) * p.amount ELSE 0 END)::text AS os,
      SUM(CASE WHEN p.date >= ${p.start}::timestamp AND p.side = 'D' THEN coalesce(p.quantity, 0) ELSE 0 END)::text AS iq,
      SUM(CASE WHEN p.date >= ${p.start}::timestamp AND p.side = 'D' THEN p.amount ELSE 0 END)::text AS isum,
      SUM(CASE WHEN p.date >= ${p.start}::timestamp AND p.side = 'C' THEN coalesce(p.quantity, 0) ELSE 0 END)::text AS xq,
      SUM(CASE WHEN p.date >= ${p.start}::timestamp AND p.side = 'C' THEN p.amount ELSE 0 END)::text AS xs
    FROM acc_postings p JOIN acc_accounts a ON a.id = p.account_id
    WHERE p.organization_id = ${ctx.organizationId} AND p.is_active AND p.ledger = 'BU' AND a.code LIKE '13%'
      AND p.product_id IS NOT NULL AND p.date < ${p.end}::timestamp ${store}
    GROUP BY p.product_id`;
  const products = rows.length ? await prisma.product.findMany({ where: { id: { in: rows.map((r) => r.product_id) } }, select: { id: true, name: true, code: true, article: true, groupId: true, uom: { select: { shortName: true } } } }) : [];
  const s = String(q.search ?? '').trim().toLowerCase();
  const tot = { os: new D(0), is: new D(0), xs: new D(0), cs: new D(0) };
  const lines = rows.map((r) => {
    const pr = products.find((x) => x.id === r.product_id);
    const cq = new D(r.oq).plus(r.iq).minus(r.xq), cs = new D(r.os).plus(r.isum).minus(r.xs);
    return {
      productId: r.product_id, name: pr?.name ?? r.product_id, code: pr?.article ?? pr?.code ?? null, unit: pr?.uom?.shortName ?? '', groupId: pr?.groupId ?? null,
      openQty: new D(r.oq).toString(), openSum: new D(r.os).toFixed(2), inQty: new D(r.iq).toString(), inSum: new D(r.isum).toFixed(2),
      outQty: new D(r.xq).toString(), outSum: new D(r.xs).toFixed(2), closeQty: cq.toString(), closeSum: cs.toFixed(2),
    };
  }).filter((l) => (!s || `${l.name} ${l.code ?? ''}`.toLowerCase().includes(s)) && (!q.groupId || l.groupId === q.groupId))
    .filter((l) => [l.openQty, l.inQty, l.outQty, l.closeQty].some((v) => !new D(v).isZero()) || !new D(l.closeSum).isZero())
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  for (const l of lines) { tot.os = tot.os.plus(l.openSum); tot.is = tot.is.plus(l.inSum); tot.xs = tot.xs.plus(l.outSum); tot.cs = tot.cs.plus(l.closeSum); }
  return { from: p.from, to: p.to, storeId: q.storeId ?? null, totals: { openSum: tot.os.toFixed(2), inSum: tot.is.toFixed(2), outSum: tot.xs.toFixed(2), closeSum: tot.cs.toFixed(2) }, lines };
}

const OPS: Record<string, string> = {
  CUSTOMER: 'Оплата от покупателей', SUPPLIER: 'Оплата поставщикам', SALARY: 'Зарплата', TAX: 'Налоги и взносы', ACCOUNTABLE: 'Выдача под отчёт',
  ACCOUNTABLE_RETURN: 'Возврат подотчётных', ACQUIRING: 'Эквайринг (оплата картой)', LOAN: 'Займы и кредиты', OTHER: 'Прочее', FROM_BANK: 'Снятие наличных',
  RETAIL: 'Розничная выручка', RETAIL_RETURN: 'Возвраты в рознице', POS: 'Касса FlowPOS',
};

/**
 * Движение денег (ДДС): поступления и выплаты по банку и кассам за период, по статьям (если указаны в платеже) или по
 * виду операции; по месяцам. Переводы между своими счетами и кассами не считаются. Остатки на начало и конец.
 */
export async function moneyFlow(prisma: PrismaService, ctx: OrgContext, q: { from?: string; to?: string; by?: string }) {
  const p = period(q);
  const money = Prisma.sql`(p.bank_account_id IS NOT NULL OR p.cashbox_id IS NOT NULL)`;
  const [bal, rows] = await Promise.all([
    prisma.$queryRaw<{ o: string; c: string }[]>`
      SELECT SUM(CASE WHEN p.date < ${p.start}::timestamp THEN (CASE WHEN p.side = 'D' THEN p.amount ELSE -p.amount END) ELSE 0 END)::text AS o,
             SUM(CASE WHEN p.side = 'D' THEN p.amount ELSE -p.amount END)::text AS c
      FROM acc_postings p WHERE p.organization_id = ${ctx.organizationId} AND p.is_active AND p.ledger = 'BU' AND ${money} AND p.date < ${p.end}::timestamp`,
    prisma.$queryRaw<{ entry_id: string; source_type: string; source_id: string; side: string; amount: string; item_id: string | null; date: Date; transfer: boolean }[]>`
      SELECT p.entry_id, e.source_type, e.source_id, p.side, p.amount::text, p.item_id, p.date,
        EXISTS (SELECT 1 FROM acc_postings x WHERE x.entry_id = p.entry_id AND x.is_active AND x.ledger = 'BU' AND x.side <> p.side
                AND (x.bank_account_id IS NOT NULL OR x.cashbox_id IS NOT NULL)) AS transfer
      FROM acc_postings p JOIN acc_entries e ON e.id = p.entry_id
      WHERE p.organization_id = ${ctx.organizationId} AND p.is_active AND p.ledger = 'BU' AND e.status = 'ACTIVE' AND ${money}
        AND p.date >= ${p.start}::timestamp AND p.date < ${p.end}::timestamp`,
  ]);
  const moves = rows.filter((r) => !r.transfer);
  const accIds = [...new Set(moves.filter((r) => r.source_type === 'ACC_DOCUMENT').map((r) => r.source_id))];
  const tradeIds = [...new Set(moves.filter((r) => r.source_type === 'TRADE_DOCUMENT').map((r) => r.source_id))];
  const [accDocs, tradeDocs, items] = await Promise.all([
    accIds.length ? prisma.accDocument.findMany({ where: { id: { in: accIds }, organizationId: ctx.organizationId }, select: { id: true, body: true } }) : [],
    tradeIds.length ? prisma.document.findMany({ where: { id: { in: tradeIds } }, select: { id: true, docType: true } }) : [],
    prisma.accItem.findMany({ where: { organizationId: ctx.organizationId }, select: { id: true, name: true } }),
  ]);
  const catOf = (r: (typeof moves)[number]) => {
    if (q.by !== 'operation' && r.item_id) return { key: `item:${r.item_id}`, name: items.find((i) => i.id === r.item_id)?.name ?? 'Статья' };
    let op = 'OTHER';
    if (r.source_type === 'ACC_DOCUMENT') op = ((accDocs as any[]).find((d) => d.id === r.source_id)?.body?.operation as string) || 'OTHER';
    else if (r.source_type === 'TRADE_DOCUMENT') op = (tradeDocs as any[]).find((d) => d.id === r.source_id)?.docType === 'RETAIL_RETURN' ? 'RETAIL_RETURN' : 'RETAIL';
    else if (r.source_type.startsWith('POS')) op = 'POS';
    return { key: `op:${op}`, name: OPS[op] ?? op };
  };
  const months = new Set<string>();
  const by = new Map<string, { name: string; inflow: Prisma.Decimal; outflow: Prisma.Decimal; months: Record<string, Prisma.Decimal> }>();
  let inflow = new D(0), outflow = new D(0);
  for (const r of moves) {
    const c = catOf(r);
    const m = new Date(r.date.getTime() + 5 * 3600e3).toISOString().slice(0, 7);
    months.add(m);
    const o = by.get(c.key) ?? { name: c.name, inflow: new D(0), outflow: new D(0), months: {} };
    const v = new D(r.amount);
    if (r.side === 'D') { o.inflow = o.inflow.plus(v); inflow = inflow.plus(v); o.months[m] = (o.months[m] ?? new D(0)).plus(v); }
    else { o.outflow = o.outflow.plus(v); outflow = outflow.plus(v); o.months[m] = (o.months[m] ?? new D(0)).minus(v); }
    by.set(c.key, o);
  }
  const lines = [...by.entries()].map(([key, o]) => ({
    key, name: o.name, inflow: o.inflow.toFixed(2), outflow: o.outflow.toFixed(2), net: o.inflow.minus(o.outflow).toFixed(2),
    months: Object.fromEntries(Object.entries(o.months).map(([k, v]) => [k, v.toFixed(2)])),
  })).sort((a, b) => new D(b.inflow).plus(b.outflow).cmp(new D(a.inflow).plus(a.outflow)));
  const opening = new D(bal[0]?.o ?? 0), closing = new D(bal[0]?.c ?? 0);
  return {
    from: p.from, to: p.to, by: q.by === 'operation' ? 'operation' : 'item', months: [...months].sort(),
    opening: opening.toFixed(2), inflow: inflow.toFixed(2), outflow: outflow.toFixed(2), net: inflow.minus(outflow).toFixed(2), closing: closing.toFixed(2), lines,
  };
}
