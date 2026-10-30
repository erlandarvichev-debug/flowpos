import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Scope, scopeError, tenantCatalog, writable } from '../../common/scope';

/** Контрагенты: справочник клиента — общий для его организаций или личный для одной (FP-007). */
@Injectable()
export class CounterpartiesService {
  constructor(private prisma: PrismaService) {}

  async findAll(s: Scope, query: { search?: string; type?: string; page?: number; limit?: number }) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 50;
    const skip = (page - 1) * limit;

    const where: any = { ...tenantCatalog(s), deleted: false };
    if (query.search) {
      where.AND = [{ OR: [
        { name: { contains: query.search, mode: 'insensitive' } },
        { inn: { contains: query.search } },
        { phone: { contains: query.search } },
      ] }];
    }
    if (query.type) where.type = query.type;

    const [counterparties, total] = await Promise.all([
      this.prisma.counterparty.findMany({
        where,
        skip,
        take: limit,
        include: { group: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.counterparty.count({ where }),
    ]);

    return { counterparties, total, page, limit, pages: Math.ceil(total / limit) };
  }

  async findOne(s: Scope, id: string) {
    const cp = await this.prisma.counterparty.findFirst({
      where: { id, ...tenantCatalog(s) },
      include: { group: true, contracts: true },
    });
    if (!cp) throw new NotFoundException('Контрагент не найден');
    return cp;
  }

  async create(s: Scope, body: any) {
    const { data, private: own } = writable(body, s, { privateAllowed: true });
    return this.prisma.counterparty.create({
      data: { ...(data as any), tenantId: s.tenantId, organizationId: own ? s.organizationId : null },
    }).catch(scopeError);
  }

  async update(s: Scope, id: string, body: any) {
    await this.findOne(s, id);
    const { data } = writable(body, s);
    return this.prisma.counterparty.update({ where: { id }, data: data as any }).catch(scopeError);
  }

  async archive(s: Scope, id: string) {
    await this.findOne(s, id);
    return this.prisma.counterparty.update({ where: { id }, data: { deleted: true } });
  }

  async findGroups(s: Scope) {
    return this.prisma.counterpartyGroup.findMany({ where: { tenantId: s.tenantId }, orderBy: { name: 'asc' } });
  }
}
