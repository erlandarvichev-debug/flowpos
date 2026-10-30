import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Scope, scopeError, tenantCatalog, writable } from '../../common/scope';

/** Номенклатура: справочник клиента — общий для его организаций или личный для одной (FP-007). */
@Injectable()
export class ItemsService {
  constructor(private prisma: PrismaService) {}

  async findAll(s: Scope, query: { search?: string; groupId?: string; page?: number; limit?: number }) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 50;
    const skip = (page - 1) * limit;

    const where: any = { ...tenantCatalog(s), deleted: false };
    if (query.search) {
      where.AND = [{ OR: [
        { name: { contains: query.search, mode: 'insensitive' } },
        { code: { contains: query.search, mode: 'insensitive' } },
      ] }];
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

  async findOne(s: Scope, id: string) {
    const item = await this.prisma.product.findFirst({
      where: { id, ...tenantCatalog(s) },
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

  async create(s: Scope, body: any) {
    const { data, private: own } = writable(body, s, { privateAllowed: true });
    const { barcodes, ...rest } = data as any;
    return this.prisma.product.create({
      data: {
        ...rest,
        tenantId: s.tenantId,
        organizationId: own ? s.organizationId : null,
        barcodes: barcodes ? { create: barcodes.map(({ id, tenantId, productId, ...b }: any) => b) } : undefined,
      },
      include: { uom: true, group: true, barcodes: true },
    }).catch(scopeError);
  }

  async update(s: Scope, id: string, body: any) {
    await this.findOne(s, id);
    const { data } = writable(body, s);
    const { barcodes, ...rest } = data as any;
    return this.prisma.product.update({
      where: { id },
      data: rest,
      include: { uom: true, group: true, barcodes: true },
    }).catch(scopeError);
  }

  async archive(s: Scope, id: string) {
    await this.findOne(s, id);
    return this.prisma.product.update({ where: { id }, data: { deleted: true } });
  }

  /** Остатки товара — только по складам своей организации. */
  async getStock(s: Scope, id: string) {
    await this.findOne(s, id);
    return this.prisma.stock.findMany({
      where: { productId: id, store: { organizationId: s.organizationId } },
      include: { store: true },
    });
  }

  async findGroups(s: Scope) {
    return this.prisma.productGroup.findMany({ where: { tenantId: s.tenantId }, orderBy: { name: 'asc' } });
  }

  async findUnits(s: Scope) {
    return this.prisma.uom.findMany({ where: { tenantId: s.tenantId }, orderBy: { name: 'asc' } });
  }
}
