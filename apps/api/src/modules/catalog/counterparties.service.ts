import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class CounterpartiesService {
  constructor(private prisma: PrismaService) {}

  async findAll(query: { search?: string; type?: string; page?: number; limit?: number }) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 50;
    const skip = (page - 1) * limit;

    const where: any = { deleted: false };
    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { inn: { contains: query.search } },
        { phone: { contains: query.search } },
      ];
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

  async findOne(id: string) {
    const cp = await this.prisma.counterparty.findUnique({
      where: { id },
      include: { group: true, contracts: true },
    });
    if (!cp) throw new NotFoundException('Контрагент не найден');
    return cp;
  }

  async create(data: any) {
    return this.prisma.counterparty.create({ data });
  }

  async update(id: string, data: any) {
    await this.findOne(id);
    return this.prisma.counterparty.update({ where: { id }, data });
  }

  async archive(id: string) {
    await this.findOne(id);
    return this.prisma.counterparty.update({ where: { id }, data: { deleted: true } });
  }

  async findGroups() {
    return this.prisma.counterpartyGroup.findMany({ orderBy: { name: 'asc' } });
  }
}
