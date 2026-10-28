import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class PosService {
  constructor(private prisma: PrismaService) {}

  async findTerminals(organizationId: string) {
    return this.prisma.pOSTerminal.findMany({
      where: { organizationId, isActive: true },
      include: { store: true },
      orderBy: { name: 'asc' },
    });
  }

  async createTerminal(data: any) {
    return this.prisma.pOSTerminal.create({ data });
  }

  async getActiveShift(terminalId: string) {
    return this.prisma.pOSShift.findFirst({
      where: { terminalId, status: 'OPEN' },
    });
  }

  async openShift(terminalId: string, data: { openBalance?: number }) {
    const terminal = await this.prisma.pOSTerminal.findUnique({ where: { id: terminalId } });
    if (!terminal) throw new NotFoundException('Касса не найдена');

    const openShift = await this.prisma.pOSShift.findFirst({
      where: { terminalId, status: 'OPEN' },
    });
    if (openShift) throw new BadRequestException('Смена уже открыта');

    const count = await this.prisma.pOSShift.count();
    return this.prisma.pOSShift.create({
      data: {
        terminalId,
        number: `CM-${String(count + 1).padStart(6, '0')}`,
        openedAt: new Date(),
        openBalance: data.openBalance || 0,
        status: 'OPEN',
      },
    });
  }

  async closeShift(shiftId: string) {
    const shift = await this.prisma.pOSShift.findUnique({ where: { id: shiftId } });
    if (!shift) throw new NotFoundException('Смена не найдена');
    if (shift.status === 'CLOSED') throw new BadRequestException('Смена уже закрыта');

    const totals = await this.prisma.document.aggregate({
      where: { docType: 'RETAIL_DEMAND', status: 'POSTED' },
      _sum: { total: true },
    });

    return this.prisma.pOSShift.update({
      where: { id: shiftId },
      data: {
        status: 'CLOSED',
        closedAt: new Date(),
        totalSales: totals._sum.total || 0,
      },
    });
  }

  async cashIn(shiftId: string, amount: number, comment?: string) {
    const shift = await this.prisma.pOSShift.findUnique({ where: { id: shiftId } });
    if (!shift) throw new NotFoundException('Смена не найдена');
    if (shift.status === 'CLOSED') throw new BadRequestException('Смена закрыта');

    await this.prisma.pOSShift.update({ where: { id: shiftId }, data: { cashIn: { increment: amount } } });
    return this.prisma.pOSCashOp.create({
      data: { shiftId, type: 'IN', amount, comment },
    });
  }

  async cashOut(shiftId: string, amount: number, comment?: string) {
    const shift = await this.prisma.pOSShift.findUnique({ where: { id: shiftId } });
    if (!shift) throw new NotFoundException('Смена не найдена');
    if (shift.status === 'CLOSED') throw new BadRequestException('Смена закрыта');

    await this.prisma.pOSShift.update({ where: { id: shiftId }, data: { cashOut: { increment: amount } } });
    return this.prisma.pOSCashOp.create({
      data: { shiftId, type: 'OUT', amount, comment },
    });
  }

  async findShifts(query: any) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 20;
    const where: any = {};
    if (query.terminalId) where.terminalId = query.terminalId;
    if (query.status) where.status = query.status;

    const [shifts, total] = await Promise.all([
      this.prisma.pOSShift.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { openedAt: 'desc' },
      }),
      this.prisma.pOSShift.count({ where }),
    ]);
    return { shifts, total, page, limit };
  }

  async getShifts(terminalId: string, query: { page?: number; limit?: number }) {
    return this.findShifts({ ...query, terminalId });
  }

  async findReceipts(query: any) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 20;
    const where: any = { docType: 'RETAIL_DEMAND' };

    const [receipts, total] = await Promise.all([
      this.prisma.document.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.document.count({ where }),
    ]);
    return { receipts, total, page, limit };
  }

  async createReceipt(data: any) {
    const { items, ...rest } = data;
    const count = await this.prisma.document.count({ where: { docType: 'RETAIL_DEMAND' } });
    const number = `ЧЕК-${String(count + 1).padStart(8, '0')}`;
    const total = items?.reduce((s: number, i: any) => s + i.qty * i.price, 0) || 0;

    return this.prisma.document.create({
      data: {
        docType: 'RETAIL_DEMAND',
        date: new Date(),
        number,
        total,
        ...rest,
        lines: items
          ? {
              create: items.map((i: any, idx: number) => ({
                lineNo: idx + 1,
                productId: i.productId,
                qty: i.qty,
                price: i.price,
                amount: i.qty * i.price,
              })),
            }
          : undefined,
      },
    });
  }
}
