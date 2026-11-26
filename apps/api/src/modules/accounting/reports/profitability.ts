import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AccError } from '../common/acc-error';
import { D } from '../common/money';
import { OrgContext } from '../access/org-context';
import { DEFAULT_ACCOUNTS } from '../autopilot/accounts';

/** Разрезы отчёта «Прибыльность». */
export const PROFIT_GROUPS = ['product', 'group', 'counterparty', 'employee', 'store', 'document'] as const;
export type ProfitGroup = (typeof PROFIT_GROUPS)[number];

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const kzStart = (d: string) => new Date(`${d}T00:00:00+05:00`);

interface Row { doc_id: string; product_id: string; revenue: string; returns: string; cost: string }

/**
 * Прибыльность по данным учёта: выручка без НДС (счёт выручки), возвраты (счёт возвратов), себестоимость
 * (счёт себестоимости, записи пересчёта себестоимости по документу). Только проведённые торговые документы
 * (реализации, чеки, возвраты); разрез — товар, группа, покупатель, сотрудник, склад или документ.
 */
async function collect(prisma: PrismaService, ctx: OrgContext, from: string, to: string) {
  const policy = await prisma.accPolicy.findFirst({ where: { organizationId: ctx.organizationId, validFrom: { lte: kzStart(to) } }, orderBy: { validFrom: 'desc' } });
  const acc = { ...DEFAULT_ACCOUNTS, ...(((policy?.params as any) ?? {}).accounts ?? {}) } as typeof DEFAULT_ACCOUNTS;
  const start = kzStart(from).toISOString();
  const end = new Date(kzStart(to).getTime() + 86400000).toISOString();
  const rows = await prisma.$queryRaw<Row[]>`
    WITH src AS (
      SELECT CASE WHEN e.source_type = 'TRADE_DOCUMENT' THEN e.source_id ELSE split_part(e.source_id, ':', 2) END AS doc_id,
             p.product_id, a.code, p.side, p.amount
      FROM acc_postings p
      JOIN acc_entries e ON e.id = p.entry_id
      JOIN acc_accounts a ON a.id = p.account_id
      WHERE p.organization_id = ${ctx.organizationId} AND p.is_active AND p.ledger = 'BU' AND e.status = 'ACTIVE'
        AND p.date >= ${start}::timestamp AND p.date < ${end}::timestamp AND p.product_id IS NOT NULL
        AND a.code IN (${acc.revenue}, ${acc.salesReturn}, ${acc.cogs})
        AND (e.source_type = 'TRADE_DOCUMENT' OR (e.source_type = 'COST' AND e.source_id LIKE 'TRADE_DOCUMENT:%'))
    )
    SELECT doc_id, product_id,
      SUM(CASE WHEN code = ${acc.revenue} THEN (CASE WHEN side = 'C' THEN amount ELSE -amount END) ELSE 0 END)::text AS revenue,
      SUM(CASE WHEN code = ${acc.salesReturn} THEN (CASE WHEN side = 'D' THEN amount ELSE -amount END) ELSE 0 END)::text AS returns,
      SUM(CASE WHEN code = ${acc.cogs} THEN (CASE WHEN side = 'D' THEN amount ELSE -amount END) ELSE 0 END)::text AS cost
    FROM src GROUP BY doc_id, product_id`;
  const docIds = [...new Set(rows.map((r) => r.doc_id))];
  const docs = docIds.length ? await prisma.document.findMany({
    where: { id: { in: docIds } },
    select: { id: true, number: true, date: true, docType: true, counterpartyId: true, storeId: true, updatedBy: true, attributes: true, lines: { select: { productId: true, qty: true } } },
  }) : [];
  // Сотрудник продажи: ответственный документа, иначе ответственный заказа-основания, иначе кто провёл.
  const orderIds = [...new Set(docs.map((d) => (d.attributes as any)?.orderId ?? (d.attributes as any)?.baseId).filter(Boolean))] as string[];
  const orders = orderIds.length ? await prisma.document.findMany({ where: { id: { in: orderIds } }, select: { id: true, attributes: true } }) : [];
  const respOf = (d: (typeof docs)[number]) => {
    const a = (d.attributes ?? {}) as any;
    const o = orders.find((x) => x.id === (a.orderId ?? a.baseId));
    return a.responsibleId ?? (o?.attributes as any)?.responsibleId ?? d.updatedBy ?? null;
  };
  return { rows, docs, respOf };
}

export async function profitability(prisma: PrismaService, ctx: OrgContext, q: { from?: string; to?: string; groupBy?: string; compare?: string | boolean; search?: string }) {
  const to = q.to ?? new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10);
  const from = q.from ?? `${to.slice(0, 8)}01`;
  if (!DAY.test(from) || !DAY.test(to)) throw new AccError('BAD_DATE', 'Период: даты ГГГГ-ММ-ДД');
  if (from > to) throw new AccError('BAD_PERIOD', 'Начало периода позже конца');
  const groupBy = (PROFIT_GROUPS as readonly string[]).includes(String(q.groupBy)) ? (q.groupBy as ProfitGroup) : 'product';

  const build = async (f: string, t: string) => {
    const { rows, docs, respOf } = await collect(prisma, ctx, f, t);
    const products = rows.length ? await prisma.product.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.product_id))] } }, select: { id: true, name: true, code: true, article: true, groupId: true } }) : [];
    const keyOf = (r: Row) => {
      const d = docs.find((x) => x.id === r.doc_id);
      switch (groupBy) {
        case 'product': return r.product_id;
        case 'group': return products.find((p) => p.id === r.product_id)?.groupId ?? '-';
        case 'counterparty': return d?.counterpartyId ?? '-';
        case 'employee': return (d && respOf(d)) ?? '-';
        case 'store': return d?.storeId ?? '-';
        case 'document': return r.doc_id;
      }
    };
    const by = new Map<string, { revenue: Prisma.Decimal; returns: Prisma.Decimal; cost: Prisma.Decimal; qty: Prisma.Decimal; retQty: Prisma.Decimal; docs: Set<string> }>();
    for (const r of rows) {
      const k = keyOf(r);
      const o = by.get(k) ?? { revenue: new D(0), returns: new D(0), cost: new D(0), qty: new D(0), retQty: new D(0), docs: new Set<string>() };
      o.revenue = o.revenue.plus(r.revenue); o.returns = o.returns.plus(r.returns); o.cost = o.cost.plus(r.cost);
      const d = docs.find((x) => x.id === r.doc_id);
      const qty = (d?.lines ?? []).filter((l) => l.productId === r.product_id).reduce((s, l) => s.plus(l.qty), new D(0));
      if (d && d.docType.endsWith('RETURN')) o.retQty = o.retQty.plus(qty); else o.qty = o.qty.plus(qty);
      o.docs.add(r.doc_id);
      by.set(k, o);
    }
    return { by, docs, products };
  };

  const cur = await build(from, to);
  // Сравнение с предыдущим периодом такой же длины.
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
  const prevTo = new Date(Date.parse(from) - 86400000).toISOString().slice(0, 10);
  // Целые месяцы — с теми же месяцами раньше (октябрь → сентябрь), иначе — столько же дней перед периодом.
  const lastDay = (d: string) => new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7), 0)).toISOString().slice(0, 10);
  const months = (+to.slice(0, 4) - +from.slice(0, 4)) * 12 + (+to.slice(5, 7) - +from.slice(5, 7)) + 1;
  const wholeMonths = from.endsWith('-01') && to === lastDay(to);
  const prevFrom = wholeMonths
    ? new Date(Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1 - months, 1)).toISOString().slice(0, 10)
    : new Date(Date.parse(prevTo) - (days - 1) * 86400000).toISOString().slice(0, 10);
  const prev = q.compare === true || q.compare === '1' || q.compare === 'true' ? await build(prevFrom, prevTo) : null;

  const keys = [...cur.by.keys()];
  const name = await namer(prisma, ctx, groupBy, keys, cur);
  const pct = (a: Prisma.Decimal, b: Prisma.Decimal) => (b.isZero() ? null : a.div(b).times(100).toDecimalPlaces(1).toNumber());
  const total = { revenue: new D(0), returns: new D(0), cost: new D(0) };
  let lines = keys.map((k) => {
    const o = cur.by.get(k)!;
    const net = o.revenue.minus(o.returns);
    const profit = net.minus(o.cost);
    total.revenue = total.revenue.plus(o.revenue); total.returns = total.returns.plus(o.returns); total.cost = total.cost.plus(o.cost);
    const p = prev?.by.get(k);
    const prevProfit = p ? p.revenue.minus(p.returns).minus(p.cost) : null;
    return {
      key: k, ...name(k), documents: o.docs.size, qty: o.qty.toString(), returnsQty: o.retQty.toString(),
      revenue: o.revenue.toFixed(2), returns: o.returns.toFixed(2), netRevenue: net.toFixed(2), cost: o.cost.toFixed(2), profit: profit.toFixed(2),
      margin: pct(profit, net), markup: pct(profit, o.cost),
      avgPrice: o.qty.isZero() ? null : o.revenue.div(o.qty).toFixed(2),
      prevProfit: prevProfit ? prevProfit.toFixed(2) : prev ? '0.00' : null,
      lossMaking: profit.isNegative(),
    };
  });
  const s = String(q.search ?? '').trim().toLowerCase();
  if (s) lines = lines.filter((l) => `${l.name ?? ''} ${l.code ?? ''}`.toLowerCase().includes(s));
  lines.sort((a, b) => new D(b.profit).cmp(new D(a.profit)));
  const net = total.revenue.minus(total.returns);
  const profit = net.minus(total.cost);
  let prevTotal: any = null;
  if (prev) {
    const t = [...prev.by.values()].reduce((s2, o) => ({ revenue: s2.revenue.plus(o.revenue), returns: s2.returns.plus(o.returns), cost: s2.cost.plus(o.cost) }), { revenue: new D(0), returns: new D(0), cost: new D(0) });
    const pn = t.revenue.minus(t.returns);
    prevTotal = { from: prevFrom, to: prevTo, netRevenue: pn.toFixed(2), profit: pn.minus(t.cost).toFixed(2), margin: pct(pn.minus(t.cost), pn) };
  }
  // Доля прибыли строки — для «кто приносит деньги» (ABC по прибыли).
  let acc = new D(0);
  const withAbc = lines.map((l) => {
    const p = new D(l.profit);
    acc = acc.plus(D.max(p, new D(0)));
    const share = profit.gt(0) ? acc.div(profit).times(100).toNumber() : 100;
    return { ...l, share: profit.gt(0) ? p.div(profit).times(100).toDecimalPlaces(1).toNumber() : null, abc: p.lte(0) ? 'C' : share <= 80 ? 'A' : share <= 95 ? 'B' : 'C' };
  });
  return {
    from, to, groupBy,
    totals: { revenue: total.revenue.toFixed(2), returns: total.returns.toFixed(2), netRevenue: net.toFixed(2), cost: total.cost.toFixed(2), profit: profit.toFixed(2), margin: pct(profit, net), markup: pct(profit, total.cost) },
    previous: prevTotal, lines: withAbc,
  };
}

/** Подписи строк по разрезу. */
async function namer(prisma: PrismaService, ctx: OrgContext, g: ProfitGroup, keys: string[], cur: { docs: any[]; products: any[] }) {
  const ids = keys.filter((k) => k !== '-');
  const none = (k: string) => (k === '-' ? { name: g === 'group' ? 'Без группы' : g === 'counterparty' ? 'Розничный покупатель' : 'Не указан', code: null } : null);
  if (g === 'product') return (k: string) => { const p = cur.products.find((x) => x.id === k); return { name: p?.name ?? k, code: p?.article ?? p?.code ?? null }; };
  if (g === 'document') {
    const T: Record<string, string> = { DEMAND: 'Реализация', RETAIL_DEMAND: 'Чек', SALES_RETURN: 'Возврат покупателя', RETAIL_RETURN: 'Возврат по чеку' };
    return (k: string) => { const d = cur.docs.find((x) => x.id === k); return { name: d ? `${T[d.docType] ?? d.docType} ${d.number ?? ''}` : k, code: d ? d.date.toISOString().slice(0, 10) : null }; };
  }
  const rows: { id: string; name: string; code?: string | null }[] =
    g === 'group' ? await prisma.productGroup.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
      : g === 'counterparty' ? (await prisma.counterparty.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, inn: true } })).map((c) => ({ id: c.id, name: c.name, code: c.inn }))
        : g === 'store' ? await prisma.store.findMany({ where: { id: { in: ids }, organizationId: ctx.organizationId }, select: { id: true, name: true } })
          : (await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, email: true, firstName: true, lastName: true } })).map((u) => ({ id: u.id, name: [u.lastName, u.firstName].filter(Boolean).join(' ') || u.email }));
  return (k: string) => none(k) ?? { name: rows.find((r) => r.id === k)?.name ?? k, code: rows.find((r) => r.id === k)?.code ?? null };
}
