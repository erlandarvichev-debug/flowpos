import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class ItemsService {
  constructor(private prisma: PrismaService) {}

  async findAll(query: { search?: string; groupId?: string; page?: number; limit?: number }) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 50;
    const skip = (page - 1) * limit;

    const where: any = { deleted: false };
    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { code: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    if (query.groupId) where.groupId = query.groupId;

    const [items, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        skip,
        take: limit,
        include: { uom: true, group: true, barcodes: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.product.count({ where }),
    ]);

    return { items, total, page, limit, pages: Math.ceil(total / limit) };
  }

  async findOne(id: string) {
    const item = await this.prisma.product.findUnique({
      where: { id },
      include: {
        uom: true,
        group: true,
        barcodes: true,
        prices: { include: { priceType: true } },
      },
    });
    if (!item) throw new NotFoundException('Товар не найден');
    return item;
  }

  async create(data: any) {
    const { barcodes, ...rest } = data;
    return this.prisma.product.create({
      data: {
        ...rest,
        barcodes: barcodes ? { create: barcodes } : undefined,
      },
      include: { uom: true, group: true, barcodes: true },
    });
  }

  async update(id: string, data: any) {
    await this.findOne(id);
    const { barcodes, ...rest } = data;
    return this.prisma.product.update({
      where: { id },
      data: rest,
      include: { uom: true, group: true, barcodes: true },
    });
  }

  async archive(id: string) {
    await this.findOne(id);
    return this.prisma.product.update({ where: { id }, data: { deleted: true } });
  }

  async getStock(id: string) {
    return this.prisma.stock.findMany({
      where: { productId: id },
      include: { store: true },
    });
  }

  async findGroups() {
    return this.prisma.productGroup.findMany({ orderBy: { name: 'asc' } });
  }

  async findUnits() {
    return this.prisma.uom.findMany({ orderBy: { name: 'asc' } });
  }
}
