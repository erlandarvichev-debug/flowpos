import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class AnalyticsService {
  constructor(private prisma: PrismaService) {}

  async getDashboard(organizationId: string, period: { from: string; to: string }) {
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
        where: { docType: 'DEMAND', date: { gte: from, lte: to }, status: 'POSTED' },
        _sum: { total: true },
        _count: true,
      }),
      this.prisma.document.aggregate({
        where: { docType: 'RETAIL_DEMAND', createdAt: { gte: from, lte: to }, status: 'POSTED' },
        _sum: { total: true },
        _count: true,
      }),
      this.prisma.pOSShift.count({ where: { status: 'OPEN' } }),
      this.prisma.stock.count({ where: { qty: { lt: 5, gt: 0 } } }),
      this.prisma.employee.count({ where: { isActive: true } }),
      this.getSalesByDay(from, to),
      this.getTopItems(from, to),
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

  private async getSalesByDay(from: Date, to: Date) {
    const docs = await this.prisma.document.findMany({
      where: { docType: 'RETAIL_DEMAND', createdAt: { gte: from, lte: to }, status: 'POSTED' },
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

  private async getTopItems(from: Date, to: Date) {
    const lines = await this.prisma.documentLine.groupBy({
      by: ['productId'],
      where: { document: { docType: 'RETAIL_DEMAND', createdAt: { gte: from, lte: to }, status: 'POSTED' } },
      _sum: { qty: true, amount: true },
      orderBy: { _sum: { amount: 'desc' } },
      take: 10,
    });

    const productIds = lines.map((i) => i.productId);
    const products = await this.prisma.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, name: true, code: true },
    });

    return lines.map((i) => ({
      item: products.find((d) => d.id === i.productId),
      totalQty: i._sum.qty,
      totalAmount: i._sum.amount,
    }));
  }

  async getStockReport(storeId?: string) {
    const where: any = {};
    if (storeId) where.storeId = storeId;
    return this.prisma.stock.findMany({
      where,
      include: { product: { include: { uom: true } }, store: true },
      orderBy: { product: { name: 'asc' } },
    });
  }

  async getSalesTurnover(period: { from: string; to: string }) {
    const from = new Date(period.from);
    const to = new Date(period.to);

    return this.prisma.documentLine.groupBy({
      by: ['productId'],
      where: { document: { docType: 'DEMAND', date: { gte: from, lte: to }, status: 'POSTED' } },
      _sum: { qty: true, amount: true },
      orderBy: { _sum: { amount: 'desc' } },
    });
  }

  async getHrDashboard(period: { from: string; to: string }) {
    const from = new Date(period.from);
    const to = new Date(period.to);

    const [totalEmployees, avgHours] = await Promise.all([
      this.prisma.employee.count({ where: { isActive: true } }),
      this.prisma.timeSheetRow.aggregate({
        where: { timeSheet: { year: from.getFullYear(), month: from.getMonth() + 1 } },
        _avg: { hoursWorked: true },
      }),
    ]);

    return {
      totalEmployees,
      avgHoursPerEmployee: Math.round((avgHours._avg.hoursWorked || 0) * 10) / 10,
    };
  }
}
