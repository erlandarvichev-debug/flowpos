import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AccError } from '../common/acc-error';
import { D, round } from '../common/money';
import { OrgContext } from '../access/org-context';
import { COST_SOURCE } from './cost.service';
import { LEDGER_SOURCE } from '../../inventory/stock-ledger';
import { receiptSummary } from '../../inventory/receipt';

type Dec = Prisma.Decimal;

const day = (v: string | undefined, what: string) => {
  if (!v) return undefined;
  const d = new Date(v + 'T00:00:00.000Z');
  if (isNaN(d.getTime())) throw new AccError('BAD_DATE', `Некорректная дата: ${what}`);
  return d;
};
const nextDay = (d: Date) => new Date(d.getTime() + 86_400_000);

/**
 * FP-030: журнал складских движений — отчёт (с источником, количеством и стоимостью), сверка остатка с журналом и
 * расхождения приёмки. Стоимость прихода записана при движении; стоимость расхода (и приходов без известной цены —
 * возврат покупателя, перемещение) — из записей себестоимости документа по товару и складу.
 */
@Injectable()
export class StockLedgerService {
  constructor(private prisma: PrismaService) {}

  async movements(ctx: OrgContext, q: { productId?: string; storeId?: string; from?: string; to?: string; sourceId?: string; kind?: string; page?: number; limit?: number }, withValue = true) {
    const from = day(q.from, 'from'), to = day(q.to, 'to');
    const where: Prisma.StockMovementWhereInput = { organizationId: ctx.organizationId };
    if (q.productId) where.productId = q.productId;
    if (q.storeId) where.storeId = q.storeId;
    if (q.sourceId) where.sourceId = q.sourceId;
    if (q.kind) where.kind = q.kind;
    if (from || to) where.occurredAt = { ...(from ? { gte: from } : {}), ...(to ? { lt: nextDay(to) } : {}) };
    const limit = Math.min(500, Number(q.limit) || 100);
    const page = Math.max(1, Number(q.page) || 1);
    const [rows, total, sums] = await Promise.all([
      this.prisma.stockMovement.findMany({ where, orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }, { sourceLine: 'asc' }, { qty: 'asc' }], skip: (page - 1) * limit, take: limit }),
      this.prisma.stockMovement.count({ where }),
      this.prisma.stockMovement.aggregate({ where, _sum: { qty: true } }),
    ]);
    const reversedIds = new Set((await this.prisma.stockMovement.findMany({ where: { reversesId: { in: rows.map((r) => r.id) } }, select: { reversesId: true } })).map((r) => r.reversesId!));
    const derived = !withValue ? new Map<string, Dec>() : await this.derivedValues(ctx, rows.filter((r) => r.value == null && !r.reversesId && !reversedIds.has(r.id) && r.sourceType === LEDGER_SOURCE));
    // Остаток на начало периода по фильтру товара/склада (для карточки товара).
    const opening = from && (q.productId || q.storeId)
      ? (await this.prisma.stockMovement.aggregate({ where: { ...where, occurredAt: { lt: from } }, _sum: { qty: true } }))._sum.qty ?? new D(0)
      : null;

    const bins = await this.prisma.bin.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.binId).filter(Boolean) as string[])] } }, select: { id: true, name: true, code: true } });
    const [products, stores, docs] = await Promise.all([
      this.prisma.product.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.productId))] } }, select: { id: true, name: true, code: true } }),
      this.prisma.store.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.storeId))] } }, select: { id: true, name: true } }),
      this.prisma.document.findMany({ where: { id: { in: [...new Set(rows.filter((r) => r.sourceType === LEDGER_SOURCE).map((r) => r.sourceId))] } }, select: { id: true, number: true, docType: true, date: true } }),
    ]);
    return {
      items: rows.map((r) => {
        const d = derived.get(r.id);
        return {
          ...r,
          value: !withValue ? undefined : r.value != null ? r.value.toFixed(2) : d ? d.toFixed(2) : null,
          valueBasis: !withValue ? undefined : r.value != null ? r.valueBasis : d ? 'COST' : r.valueBasis,
          reversed: reversedIds.has(r.id),
          product: products.find((p) => p.id === r.productId) ?? null,
          store: stores.find((s) => s.id === r.storeId) ?? null,
          bin: bins.find((b) => b.id === r.binId) ?? null,
          source: r.sourceType === LEDGER_SOURCE ? docs.find((x) => x.id === r.sourceId) ?? null : null,
        };
      }),
      total, page, limit,
      totals: { qty: (sums._sum.qty ?? new D(0)).toString(), opening: opening?.toString() ?? null },
    };
  }

  /**
   * Стоимость движений без записанной стоимости — из записей себестоимости источника (COST «документ:товар»):
   * сумма проводок по счёту запасов этого склада (расход — кредит, приход — дебет), распределённая по строкам
   * пропорционально количеству; остаток округления — последней строке (детерминированно).
   */
  private async derivedValues(ctx: OrgContext, rows: { id: string; sourceId: string; productId: string; storeId: string; qty: Dec; sourceLine: number | null }[]) {
    const out = new Map<string, Dec>();
    if (!rows.length) return out;
    const keys = [...new Set(rows.map((r) => `${LEDGER_SOURCE}:${r.sourceId}:${r.productId}`))];
    const entries = await this.prisma.accEntry.findMany({
      where: { organizationId: ctx.organizationId, sourceType: COST_SOURCE, sourceId: { in: keys }, status: 'ACTIVE' },
      include: { postings: { where: { isActive: true, quantity: { not: null } } } },
    });
    const groups = new Map<string, typeof rows>();
    for (const r of rows) {
      const g = `${r.sourceId}|${r.productId}|${r.storeId}|${r.qty.isNegative() ? 'C' : 'D'}`;
      groups.set(g, [...(groups.get(g) ?? []), r]);
    }
    for (const [g, list] of groups) {
      const [sourceId, productId, storeId, side] = g.split('|');
      const e = entries.find((x) => x.sourceId === `${LEDGER_SOURCE}:${sourceId}:${productId}`);
      if (!e) continue;
      const amount = e.postings.filter((p) => p.side === side && p.productId === productId && p.storeId === storeId).reduce((a, p) => a.plus(p.amount), new D(0));
      if (amount.isZero()) continue;
      const qtyAll = list.reduce((a, r) => a.plus(r.qty.abs()), new D(0));
      let left = amount;
      list.sort((a, b) => (a.sourceLine ?? 0) - (b.sourceLine ?? 0)).forEach((r, i) => {
        const part = i === list.length - 1 ? left : round(amount.times(r.qty.abs()).div(qtyAll));
        left = left.minus(part);
        out.set(r.id, side === 'C' ? part.neg() : part);
      });
    }
    return out;
  }

  /** Сверка: остаток каждой строки stock равен сумме движений журнала. Расхождений быть не должно. */
  async check(ctx: OrgContext) {
    const rows = await this.prisma.$queryRaw<{ product_id: string; store_id: string; bin_id: string | null; stock_qty: string; ledger_qty: string }[]>`
      SELECT coalesce(s.product_id, m.product_id) AS product_id, coalesce(s.store_id, m.store_id) AS store_id, coalesce(s.bin_id, m.bin_id) AS bin_id,
             coalesce(s.qty, 0)::text AS stock_qty, coalesce(m.qty, 0)::text AS ledger_qty
      FROM (SELECT st.* FROM stock st JOIN stores so ON so.id = st.store_id WHERE so.organization_id = ${ctx.organizationId}) s
      FULL JOIN (SELECT product_id, store_id, bin_id, sum(qty) AS qty FROM stock_movements WHERE organization_id = ${ctx.organizationId} GROUP BY 1, 2, 3) m
        ON m.product_id = s.product_id AND m.store_id = s.store_id AND m.bin_id IS NOT DISTINCT FROM s.bin_id
      WHERE coalesce(s.qty, 0) <> coalesce(m.qty, 0)`;
    const checked = await this.prisma.stock.count({ where: { store: { organizationId: ctx.organizationId } } });
    return { ok: rows.length === 0, checked, mismatches: rows.map((r) => ({ productId: r.product_id, storeId: r.store_id, binId: r.bin_id, stockQty: r.stock_qty, ledgerQty: r.ledger_qty })) };
  }

  /** Расхождения приёмки: проведённые поступления периода со строками, где принято не столько, сколько ожидалось. */
  async discrepancies(ctx: OrgContext, q: { from?: string; to?: string; counterpartyId?: string }, withValue = true) {
    const from = day(q.from, 'from'), to = day(q.to, 'to');
    const docs = await this.prisma.document.findMany({
      where: {
        organizationId: ctx.organizationId, docType: 'SUPPLY', status: 'POSTED', deleted: false,
        ...(q.counterpartyId ? { counterpartyId: q.counterpartyId } : {}),
        ...(from || to ? { date: { ...(from ? { gte: from } : {}), ...(to ? { lt: nextDay(to) } : {}) } } : {}),
        lines: { some: { OR: [{ expectedQty: { not: null } }, { rejectedQty: { not: null } }] } },
      },
      include: { lines: { include: { product: { select: { id: true, name: true } } }, orderBy: { lineNo: 'asc' } }, counterparty: { select: { id: true, name: true } } },
      orderBy: { date: 'asc' },
    });
    const items = docs
      .map((d) => ({ id: d.id, number: d.number, date: d.date, counterparty: d.counterparty, baseId: (d.attributes as any)?.baseId ?? null, ...receiptSummary(d.lines) }))
      .filter((d) => d.hasDiscrepancy)
      .map((d) => ({ ...d, lines: d.lines.map((l) => ({ ...l, product: docs.find((x) => x.id === d.id)!.lines.find((x) => x.lineNo === l.lineNo)?.product ?? null })) }));
    if (!withValue) {
      // Без права на отчёты — только количества (без сумм претензии).
      return { items: items.map(({ claimAmount, surplusAmount, ...d }) => ({ ...d, lines: d.lines.map(({ claimAmount: _c, surplusAmount: _s, ...l }) => l) })), claimAmount: undefined };
    }
    return { items, claimAmount: items.reduce((a, x) => a.plus(x.claimAmount), new D(0)).toFixed(2) };
  }
}
