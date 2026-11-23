import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { Scope, orgDocument } from '../../common/scope';

@Injectable()
export class AnalyticsService {
  constructor(private prisma: PrismaService) {}

  /**
   * Показатели за период (даты Казахстана, обе включительно): выручка = реализации + розница − возвраты, число продаж,
   * средний чек, сравнение с прошлым периодом той же длины; продажи по дням; лучшие товары и покупатели; что требует
   * внимания (открытые заказы, товары ниже минимума и в минусе, открытые смены).
   */
  async getDashboard(s: Scope, period: { from?: string; to?: string }) {
    const today = new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10);
    const fromS = period.from || today.slice(0, 8) + '01';
    const toS = period.to || today;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fromS) || !/^\d{4}-\d{2}-\d{2}$/.test(toS) || fromS > toS) throw new BadRequestException('Период: даты ГГГГ-ММ-ДД, начало не позже конца');
    const from = new Date(`${fromS}T00:00:00+05:00`);
    const to = new Date(new Date(`${toS}T00:00:00+05:00`).getTime() + 24 * 3600e3);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new BadRequestException('Неверная дата');
    const days = Math.round((to.getTime() - from.getTime()) / (24 * 3600e3));
    if (days > 731) throw new BadRequestException('Период — не больше двух лет');
    const prevFrom = new Date(from.getTime() - days * 24 * 3600e3);
    const org = Prisma.sql`d.tenant_id = ${s.tenantId} AND d.deleted = false AND d.status = 'POSTED'
      AND (d.organization_id = ${s.organizationId} OR (d.organization_id IS NULL AND d.store_id IN (SELECT id FROM stores WHERE organization_id = ${s.organizationId})))`;
    const kinds = Prisma.sql`d.doc_type::text IN ('DEMAND', 'RETAIL_DEMAND', 'SALES_RETURN', 'RETAIL_RETURN')`;
    const sales = Prisma.sql`d.doc_type::text IN ('DEMAND', 'RETAIL_DEMAND')`;

    const [totals, byDay, topItems, topCustomers, orders, stock, activeShifts] = await Promise.all([
      this.prisma.$queryRaw<any[]>`
        SELECT (d.date >= ${from}) AS cur,
               coalesce(sum(d.total) FILTER (WHERE d.doc_type::text = 'DEMAND'), 0)::text AS wholesale,
               coalesce(sum(d.total) FILTER (WHERE d.doc_type::text = 'RETAIL_DEMAND'), 0)::text AS retail,
               coalesce(sum(d.total) FILTER (WHERE d.doc_type::text IN ('SALES_RETURN', 'RETAIL_RETURN')), 0)::text AS returns,
               (count(*) FILTER (WHERE ${sales}))::int AS sales
        FROM documents d
        WHERE ${org} AND d.date >= ${prevFrom} AND d.date < ${to} AND ${kinds}
        GROUP BY 1`,
      this.prisma.$queryRaw<any[]>`
        SELECT to_char(d.date + interval '5 hours', 'YYYY-MM-DD') AS day,
               coalesce(sum(d.total) FILTER (WHERE d.doc_type::text = 'DEMAND'), 0)::text AS wholesale,
               coalesce(sum(d.total) FILTER (WHERE d.doc_type::text = 'RETAIL_DEMAND'), 0)::text AS retail,
               coalesce(sum(d.total) FILTER (WHERE d.doc_type::text IN ('SALES_RETURN', 'RETAIL_RETURN')), 0)::text AS returns,
               (count(*) FILTER (WHERE ${sales}))::int AS sales
        FROM documents d
        WHERE ${org} AND d.date >= ${from} AND d.date < ${to} AND ${kinds}
        GROUP BY 1 ORDER BY 1`,
      this.prisma.$queryRaw<any[]>`
        SELECT l.product_id, p.name, p.code, sum(l.qty)::text AS qty, sum(l.amount)::text AS amount
        FROM document_lines l JOIN documents d ON d.id = l.document_id JOIN products p ON p.id = l.product_id
        WHERE ${org} AND d.date >= ${from} AND d.date < ${to} AND ${sales}
        GROUP BY l.product_id, p.name, p.code ORDER BY sum(l.amount) DESC NULLS LAST LIMIT 8`,
      this.prisma.$queryRaw<any[]>`
        SELECT d.counterparty_id, c.name, sum(d.total)::text AS amount, count(*)::int AS docs
        FROM documents d JOIN counterparties c ON c.id = d.counterparty_id
        WHERE ${org} AND d.date >= ${from} AND d.date < ${to} AND d.doc_type::text = 'DEMAND'
        GROUP BY d.counterparty_id, c.name ORDER BY sum(d.total) DESC NULLS LAST LIMIT 5`,
      this.prisma.$queryRaw<any[]>`
        SELECT count(*)::int AS n, coalesce(sum(d.total), 0)::text AS amount FROM documents d
        WHERE ${org} AND d.doc_type::text = 'CUSTOMER_ORDER' AND coalesce(d.attributes->>'closed', 'false') <> 'true'`,
      this.prisma.$queryRaw<any[]>`
        SELECT
          (SELECT count(*)::int FROM replenishment_rules rr JOIN stores st ON st.id = rr.store_id AND st.organization_id = ${s.organizationId} AND st.deleted = false
            WHERE (SELECT coalesce(sum(x.qty - x.reserved), 0) FROM stock x WHERE x.product_id = rr.product_id AND x.store_id = rr.store_id) < rr.min_qty) AS below,
          (SELECT count(*)::int FROM (SELECT 1 FROM stock x JOIN stores st ON st.id = x.store_id AND st.organization_id = ${s.organizationId} AND st.deleted = false
            GROUP BY x.product_id, x.store_id HAVING sum(x.qty) < 0) n) AS negative`,
      this.prisma.pOSShift.count({ where: { status: 'OPEN', terminal: { organizationId: s.organizationId } } }),
    ]);

    const num = (v: unknown) => Number(v ?? 0);
    const pick = (cur: boolean) => {
      const r = totals.find((t) => t.cur === cur) ?? { wholesale: 0, retail: 0, returns: 0, sales: 0 };
      const gross = num(r.wholesale) + num(r.retail);
      return { revenue: gross - num(r.returns), wholesale: num(r.wholesale), retail: num(r.retail), returns: num(r.returns), sales: num(r.sales), avgCheck: r.sales ? Math.round((gross / r.sales) * 100) / 100 : 0 };
    };
    return {
      period: { from: fromS, to: toS, prevFrom: new Date(prevFrom.getTime() + 5 * 3600e3).toISOString().slice(0, 10) },
      kpi: pick(true),
      prev: pick(false),
      byDay: byDay.map((d) => ({ date: d.day, wholesale: num(d.wholesale), retail: num(d.retail), returns: num(d.returns), sales: d.sales })),
      topItems: topItems.map((r) => ({ productId: r.product_id, name: r.name, code: r.code, qty: num(r.qty), amount: num(r.amount) })),
      topCustomers: topCustomers.map((r) => ({ counterpartyId: r.counterparty_id, name: r.name, amount: num(r.amount), docs: r.docs })),
      attention: { openOrders: orders[0]?.n ?? 0, openOrdersSum: num(orders[0]?.amount), belowMin: stock[0]?.below ?? 0, negativeStock: stock[0]?.negative ?? 0, activeShifts },
    };
  }

  async getStockReport(s: Scope, storeId?: string) {
    const where: any = { store: { organizationId: s.organizationId } };
    if (storeId) where.storeId = storeId;
    return this.prisma.stock.findMany({
      where,
      include: { product: { include: { uom: true } }, store: true },
      orderBy: { product: { name: 'asc' } },
    });
  }

  async getSalesTurnover(s: Scope, period: { from: string; to: string }) {
    const from = new Date(period.from);
    const to = new Date(period.to);

    return this.prisma.documentLine.groupBy({
      by: ['productId'],
      where: { document: { ...orgDocument(s), docType: 'DEMAND', date: { gte: from, lte: to }, status: 'POSTED' } },
      _sum: { qty: true, amount: true },
      orderBy: { _sum: { amount: 'desc' } },
    });
  }

  async getHrDashboard(s: Scope, period: { from: string; to: string }) {
    const from = new Date(period.from);
    const to = new Date(period.to);

    const [totalEmployees, avgHours] = await Promise.all([
      this.prisma.employee.count({ where: { isActive: true, organizationId: s.organizationId } }),
      this.prisma.timeSheetRow.aggregate({
        where: { organizationId: s.organizationId, timeSheet: { year: from.getFullYear(), month: from.getMonth() + 1 } },
        _avg: { hoursWorked: true },
      }),
    ]);

    return {
      totalEmployees,
      avgHoursPerEmployee: Math.round((avgHours._avg.hoursWorked || 0) * 10) / 10,
    };
  }
}
