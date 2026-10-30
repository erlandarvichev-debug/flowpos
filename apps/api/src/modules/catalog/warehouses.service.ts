import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Scope, ownOrg, scopeError, writable } from '../../common/scope';

/** Склады — объекты организации (FP-007). */
@Injectable()
export class WarehousesService {
  constructor(private prisma: PrismaService) {}

  async findAll(s: Scope) {
    return this.prisma.store.findMany({
      where: { ...ownOrg(s), isActive: true },
      orderBy: { name: 'asc' },
    });
  }

  async findOne(s: Scope, id: string) {
    const w = await this.prisma.store.findFirst({
      where: { id, ...ownOrg(s) },
      include: { bins: true },
    });
    if (!w) throw new NotFoundException('Склад не найден');
    return w;
  }

  async create(s: Scope, body: any) {
    const { data } = writable(body, s);
    return this.prisma.store.create({ data: { ...(data as any), tenantId: s.tenantId, organizationId: s.organizationId } }).catch(scopeError);
  }

  async update(s: Scope, id: string, body: any) {
    await this.findOne(s, id);
    const { data } = writable(body, s);
    return this.prisma.store.update({ where: { id }, data: data as any }).catch(scopeError);
  }

  async getStocks(s: Scope, id: string, query: { search?: string; page?: number; limit?: number }) {
    await this.findOne(s, id);
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
