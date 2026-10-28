import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class WarehousesService {
  constructor(private prisma: PrismaService) {}

  async findAll(organizationId: string) {
    return this.prisma.store.findMany({
      where: { organizationId, isActive: true },
      orderBy: { name: 'asc' },
    });
  }

  async findOne(id: string) {
    const w = await this.prisma.store.findUnique({
      where: { id },
      include: { bins: true },
    });
    if (!w) throw new NotFoundException('Склад не найден');
    return w;
  }

  async create(data: any) {
    return this.prisma.store.create({ data });
  }

  async update(id: string, data: any) {
    await this.findOne(id);
    return this.prisma.store.update({ where: { id }, data });
  }

  async getStocks(id: string, query: { search?: string; page?: number; limit?: number }) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 50;
    const skip = (page - 1) * limit;

    const where: any = { storeId: id, qty: { gt: 0 } };
    if (query.search) {
      where.product = { name: { contains: query.search, mode: 'insensitive' } };
    }

    const [stocks, total] = await Promise.all([
      this.prisma.stock.findMany({
        where,
        skip,
        take: limit,
        include: { product: { include: { uom: true } }, bin: true },
        orderBy: { product: { name: 'asc' } },
      }),
      this.prisma.stock.count({ where }),
    ]);

    return { stocks, total, page, limit };
  }
}
