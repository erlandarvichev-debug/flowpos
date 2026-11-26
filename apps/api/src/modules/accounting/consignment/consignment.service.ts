import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AccError } from '../common/acc-error';
import { D } from '../common/money';
import { OrgContext } from '../access/org-context';
import { TradeDocumentsService } from '../autopilot/trade-documents.service';
import { DocumentsService } from '../documents/documents.service';
import { AutopilotService } from '../autopilot/autopilot.service';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Товары на реализации (комиссия): у покупателя-комиссионера свой склад; товар туда передаётся перемещением и остаётся
 * нашим. Отчёт комиссионера о продажах проводит реализацию с его склада (выручка, долг комиссионера); вознаграждение
 * комиссионера (если есть) — расход по реализации в счёт его долга. Возврат — перемещение обратно.
 */
@Injectable()
export class ConsignmentService {
  constructor(private prisma: PrismaService, private trade: TradeDocumentsService, private docs: DocumentsService, private autopilot: AutopilotService) {}

  /** Комиссионеры: склад, контрагент, товар у них (количество и себестоимость), продано за 30 дней. */
  async list(ctx: OrgContext) {
    const stores = await this.prisma.store.findMany({ where: { organizationId: ctx.organizationId, consigneeId: { not: null }, isActive: true }, orderBy: { name: 'asc' } });
    if (!stores.length) return [];
    const ids = stores.map((s) => s.id);
    const [stock, cps, sold] = await Promise.all([
      this.prisma.$queryRaw<{ store_id: string; q: string; s: string; n: number }[]>`
        SELECT x.store_id, SUM(x.q)::text AS q, SUM(x.s)::text AS s, COUNT(*) FILTER (WHERE x.q <> 0)::int AS n FROM (
          SELECT p.store_id, p.product_id, SUM(CASE WHEN p.side = 'D' THEN 1 ELSE -1 END * coalesce(p.quantity, 0)) AS q, SUM(CASE WHEN p.side = 'D' THEN p.amount ELSE -p.amount END) AS s
          FROM acc_postings p JOIN acc_accounts a ON a.id = p.account_id
          WHERE p.organization_id = ${ctx.organizationId} AND p.is_active AND p.ledger = 'BU' AND a.code LIKE '13%' AND p.store_id = ANY(${ids}::text[])
          GROUP BY p.store_id, p.product_id) x GROUP BY x.store_id`,
      this.prisma.counterparty.findMany({ where: { id: { in: stores.map((s) => s.consigneeId!) } }, select: { id: true, name: true, phone: true } }),
      this.prisma.document.groupBy({ by: ['storeId'], where: { storeId: { in: ids }, docType: 'DEMAND', status: 'POSTED', deleted: false, date: { gte: new Date(Date.now() - 30 * 86400e3) } }, _sum: { total: true } }),
    ]);
    return stores.map((s) => {
      const st = stock.find((x) => x.store_id === s.id);
      return {
        storeId: s.id, storeName: s.name, counterparty: cps.find((c) => c.id === s.consigneeId) ?? { id: s.consigneeId, name: s.consigneeId },
        qty: new D(st?.q ?? 0).toString(), cost: new D(st?.s ?? 0).toFixed(2), products: st?.n ?? 0,
        sold30: new D(sold.find((x) => x.storeId === s.id)?._sum.total ?? 0).toFixed(2),
      };
    });
  }

  /** Новый комиссионер: склад «На реализации: <контрагент>», привязанный к покупателю. */
  async addConsignee(ctx: OrgContext, b: { counterpartyId?: string }) {
    const cp = await this.prisma.counterparty.findFirst({ where: { id: b?.counterpartyId ?? '', tenantId: ctx.tenantId, OR: [{ organizationId: null }, { organizationId: ctx.organizationId }] }, select: { id: true, name: true } });
    if (!cp) throw new AccError('REF_FOREIGN', 'Выберите покупателя');
    const exists = await this.prisma.store.findFirst({ where: { organizationId: ctx.organizationId, consigneeId: cp.id, isActive: true } });
    if (exists) return { storeId: exists.id, storeName: exists.name };
    const s = await this.prisma.store.create({ data: { name: `На реализации: ${cp.name}`, organizationId: ctx.organizationId, consigneeId: cp.id, owner: 'PLATFORM' as any } });
    await this.prisma.auditLog.create({ data: { userId: ctx.userId, organizationId: ctx.organizationId, action: 'CONSIGNEE_ADD', entity: 'store', entityId: s.id, after: { counterpartyId: cp.id } } });
    return { storeId: s.id, storeName: s.name };
  }

  private async store(ctx: OrgContext, storeId: string) {
    const s = await this.prisma.store.findFirst({ where: { id: storeId, organizationId: ctx.organizationId, consigneeId: { not: null } } });
    if (!s) throw new AccError('NOT_FOUND', 'Склад комиссионера не найден', { status: 404 });
    return s;
  }

  /** Товар у комиссионера: количество, себестоимость; цена — последняя цена продажи ему (подсказка для отчёта). */
  async stock(ctx: OrgContext, storeId: string) {
    const s = await this.store(ctx, storeId);
    const rows = await this.prisma.$queryRaw<{ product_id: string; q: string; s: string }[]>`
      SELECT p.product_id, SUM(CASE WHEN p.side = 'D' THEN 1 ELSE -1 END * coalesce(p.quantity, 0))::text AS q, SUM(CASE WHEN p.side = 'D' THEN p.amount ELSE -p.amount END)::text AS s
      FROM acc_postings p JOIN acc_accounts a ON a.id = p.account_id
      WHERE p.organization_id = ${ctx.organizationId} AND p.is_active AND p.ledger = 'BU' AND a.code LIKE '13%' AND p.store_id = ${storeId} AND p.product_id IS NOT NULL
      GROUP BY p.product_id HAVING SUM(CASE WHEN p.side = 'D' THEN 1 ELSE -1 END * coalesce(p.quantity, 0)) <> 0`;
    const ids = rows.map((r) => r.product_id);
    const [products, lastPrices] = await Promise.all([
      ids.length ? this.prisma.product.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, uom: { select: { shortName: true } } } }) : [],
      ids.length ? this.prisma.$queryRaw<{ product_id: string; price: string }[]>`
        SELECT DISTINCT ON (l.product_id) l.product_id, l.price::text AS price FROM document_lines l JOIN documents d ON d.id = l.document_id
        WHERE d.counterparty_id = ${s.consigneeId} AND d.doc_type IN ('DEMAND','CUSTOMER_ORDER') AND d.deleted = false AND l.product_id = ANY(${ids}::text[]) AND l.price IS NOT NULL
        ORDER BY l.product_id, d.date DESC` : Promise.resolve([] as { product_id: string; price: string }[]),
    ]);
    return {
      storeId, storeName: s.name, counterpartyId: s.consigneeId,
      lines: rows.map((r) => {
        const p = (products as any[]).find((x) => x.id === r.product_id);
        const q = new D(r.q);
        return { productId: r.product_id, name: p?.name ?? r.product_id, unit: p?.uom?.shortName ?? '', qty: q.toString(), cost: new D(r.s).toFixed(2), unitCost: q.isZero() ? '0' : new D(r.s).div(q).toFixed(2), lastPrice: lastPrices.find((x) => x.product_id === r.product_id)?.price ?? null };
      }).sort((a, b) => a.name.localeCompare(b.name, 'ru')),
    };
  }

  /** Отчёт комиссионера: проданное — реализация с его склада; вознаграждение % — расход по реализации в счёт его долга. */
  async report(ctx: OrgContext, b: { storeId?: string; date?: string; lines?: { productId: string; qty: any; price: any }[]; feePercent?: any; comment?: string }) {
    const s = await this.store(ctx, b?.storeId ?? '');
    const date = b?.date && DAY.test(b.date) ? b.date : new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10);
    const lines = (b?.lines ?? []).filter((l) => Number(String(l.qty).replace(',', '.')) > 0);
    if (!lines.length) throw new AccError('LINES_REQUIRED', 'Укажите, что продано (количество больше нуля)');
    for (const l of lines) if (!(Number(String(l.price ?? '').replace(',', '.')) > 0)) throw new AccError('PRICE_REQUIRED', 'Укажите цену продажи для каждой проданной позиции');
    const fee = new D(String(b?.feePercent ?? '0').replace(',', '.') || '0');
    if (fee.lt(0) || fee.gt(100)) throw new AccError('BAD_PERCENT', 'Вознаграждение комиссионера: от 0 до 100%');
    const demand: any = await this.trade.create(ctx, {
      docType: 'DEMAND', date, storeId: s.id, counterpartyId: s.consigneeId!, status: 'POSTED', comment: b?.comment || 'Отчёт комиссионера о продажах',
      lines: lines.map((l) => ({ productId: l.productId, qty: String(l.qty).replace(',', '.'), price: String(l.price).replace(',', '.') })),
    } as any);
    let feeDoc: any = null;
    if (fee.gt(0)) {
      const amount = new D(demand.total ?? 0).times(fee).div(100).toDecimalPlaces(2);
      if (amount.gt(0)) {
        const { accounts } = await this.autopilot.accountsFor(this.prisma as any, ctx.organizationId, new Date(`${date}T12:00:00+05:00`));
        try {
          feeDoc = await this.docs.create(ctx, {
            docType: 'MANUAL_OPERATION', date, comment: `Вознаграждение комиссионера ${fee.toString()}% по ${demand.number}`,
            body: { lines: [{ amount: amount.toFixed(2), memo: 'Вознаграждение комиссионера', debit: { account: accounts.sellingExpense }, credit: { account: accounts.receivable, dims: { COUNTERPARTY: s.consigneeId, SETTLEMENT_DOC: demand.id } } }] },
          } as any);
          await this.docs.post(ctx, feeDoc.id);
        } catch (e) {
          await this.trade.cancel(ctx, demand.id).catch(() => undefined);
          throw e;
        }
      }
    }
    return { demand: { id: demand.id, number: demand.number, total: demand.total }, fee: feeDoc ? { id: feeDoc.id, number: feeDoc.number } : null };
  }
}
