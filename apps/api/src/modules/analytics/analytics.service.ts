import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Scope, orgDocument } from '../../common/scope';

@Injectable()
export class AnalyticsService {
  constructor(private prisma: PrismaService) {}

  async getDashboard(s: Scope, period: { from: string; to: string }) {
    const from = new Date(period.from);
    const to = new Date(period.to);

    const [
      totalDemands,
      totalRetail,
      activeShifts,
      lowStockCount,
      totalEmployees,
      salesByDay,
      topItems,
    ] = await Promise.all([
      this.prisma.document.aggregate({
        where: { ...orgDocument(s), docType: 'DEMAND', date: { gte: from, lte: to }, status: 'POSTED' },
        _sum: { total: true },
        _count: true,
      }),
      this.prisma.document.aggregate({
        where: { ...orgDocument(s), docType: 'RETAIL_DEMAND', createdAt: { gte: from, lte: to }, status: 'POSTED' },
        _sum: { total: true },
        _count: true,
      }),
      this.prisma.pOSShift.count({ where: { status: 'OPEN', terminal: { organizationId: s.organizationId } } }),
      this.prisma.stock.count({ where: { qty: { lt: 5, gt: 0 }, store: { organizationId: s.organizationId } } }),
      this.prisma.employee.count({ where: { isActive: true, organizationId: s.organizationId } }),
      this.getSalesByDay(s, from, to),
      this.getTopItems(s, from, to),
    ]);

    return {
      kpi: {
        totalSalesAmount: Number(totalDemands._sum.total || 0) + Number(totalRetail._sum.total || 0),
        totalSalesCount: totalDemands._count + totalRetail._count,
        activeShifts,
        lowStockCount,
        totalEmployees,
      },
      salesByDay,
      topItems,
    };
  }

  private async getSalesByDay(s: Scope, from: Date, to: Date) {
    const docs = await this.prisma.document.findMany({
      where: { ...orgDocument(s), docType: 'RETAIL_DEMAND', createdAt: { gte: from, lte: to }, status: 'POSTED' },
      select: { createdAt: true, total: true },
    });

    const byDay: Record<string, number> = {};
    for (const r of docs) {
      const day = r.createdAt.toISOString().substring(0, 10);
      byDay[day] = (byDay[day] || 0) + Number(r.total || 0);
    }

    return Object.entries(byDay)
      .map(([date, amount]) => ({ date, amount }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  private async getTopItems(s: Scope, from: Date, to: Date) {
    const lines = await this.prisma.documentLine.groupBy({
      by: ['productId'],
      where: { document: { ...orgDocument(s), docType: 'RETAIL_DEMAND', createdAt: { gte: from, lte: to }, status: 'POSTED' } },
      _sum: { qty: true, amount: true },
      orderBy: { _sum: { amount: 'desc' } },
      take: 10,
    });

    const productIds = lines.map((i) => i.productId);
    const products = await this.prisma.product.findMany({
      where: { id: { in: productIds }, tenantId: s.tenantId },
      select: { id: true, name: true, code: true },
    });

    return lines.map((i) => ({
      item: products.find((d) => d.id === i.productId),
      totalQty: i._sum.qty,
      totalAmount: i._sum.amount,
    }));
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
