import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { Scope, scopeError, writable } from '../../common/scope';
import { assertTradeRefs, docHeader, nextNumber, orgDocs } from '../trade/trade-scope';

/** Кассы, смены и чеки — только своей организации (FP-007). */
@Injectable()
export class PosService {
  constructor(private prisma: PrismaService) {}

  async findTerminals(s: Scope) {
    return this.prisma.pOSTerminal.findMany({
      where: { organizationId: s.organizationId, isActive: true },
      include: { store: true },
      orderBy: { name: 'asc' },
    });
  }

  async createTerminal(s: Scope, body: any) {
    const { data } = writable(body, s);
    const { apiKey, ...rest } = data as any; // ключ кассы выдаёт сервер
    if (rest.storeId) await assertTradeRefs(this.prisma, s, { storeIds: [rest.storeId] });
    return this.prisma.pOSTerminal.create({ data: { ...rest, tenantId: s.tenantId, organizationId: s.organizationId } }).catch(scopeError);
  }

  private async terminal(s: Scope, id: string) {
    const terminal = await this.prisma.pOSTerminal.findFirst({ where: { id, organizationId: s.organizationId } });
    if (!terminal) throw new NotFoundException('Касса не найдена');
    return terminal;
  }

  private async shift(s: Scope, id: string) {
    const shift = await this.prisma.pOSShift.findFirst({ where: { id, terminal: { organizationId: s.organizationId } }, include: { terminal: true } });
    if (!shift) throw new NotFoundException('Смена не найдена');
    return shift;
  }

  async getActiveShift(s: Scope, terminalId: string) {
    await this.terminal(s, terminalId);
    return this.prisma.pOSShift.findFirst({
      where: { terminalId, status: 'OPEN' },
    });
  }

  async openShift(s: Scope, terminalId: string, data: { openBalance?: number }) {
    await this.terminal(s, terminalId);

    const openShift = await this.prisma.pOSShift.findFirst({
      where: { terminalId, status: 'OPEN' },
    });
    if (openShift) throw new BadRequestException('Смена уже открыта');

    const count = await this.prisma.pOSShift.count({ where: { terminal: { organizationId: s.organizationId } } });
    return this.prisma.pOSShift.create({
      data: {
        terminalId,
        number: `CM-${String(count + 1).padStart(6, '0')}`,
        openedAt: new Date(),
        openBalance: data?.openBalance || 0,
        status: 'OPEN',
      },
    });
  }

  async closeShift(s: Scope, shiftId: string) {
    const shift = await this.shift(s, shiftId);
    if (shift.status === 'CLOSED') throw new BadRequestException('Смена уже закрыта');

    // Продажи смены: чеки своей организации со склада кассы с момента открытия смены
    // (раньше суммировались все чеки базы за всё время).
    const closedAt = new Date();
    const totals = await this.prisma.document.aggregate({
      where: orgDocs(s, {
        docType: 'RETAIL_DEMAND',
        status: 'POSTED',
        createdAt: { gte: shift.openedAt, lte: closedAt },
        ...(shift.terminal.storeId ? { storeId: shift.terminal.storeId } : {}),
      }),
      _sum: { total: true },
    });

    return this.prisma.pOSShift.update({
      where: { id: shiftId },
      data: {
        status: 'CLOSED',
        closedAt,
        totalSales: totals._sum.total || 0,
      },
    });
  }

  async cashIn(s: Scope, shiftId: string, amount: number, comment?: string) {
    const shift = await this.shift(s, shiftId);
    if (shift.status === 'CLOSED') throw new BadRequestException('Смена закрыта');

    await this.prisma.pOSShift.update({ where: { id: shiftId }, data: { cashIn: { increment: amount } } });
    return this.prisma.pOSCashOp.create({
      data: { shiftId, type: 'IN', amount, comment },
    });
  }

  async cashOut(s: Scope, shiftId: string, amount: number, comment?: string) {
    const shift = await this.shift(s, shiftId);
    if (shift.status === 'CLOSED') throw new BadRequestException('Смена закрыта');

    await this.prisma.pOSShift.update({ where: { id: shiftId }, data: { cashOut: { increment: amount } } });
    return this.prisma.pOSCashOp.create({
      data: { shiftId, type: 'OUT', amount, comment },
    });
  }

  async findShifts(s: Scope, query: any) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 20;
    const where: Prisma.POSShiftWhereInput = { terminal: { organizationId: s.organizationId } };
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

  async getShifts(s: Scope, terminalId: string, query: { page?: number; limit?: number }) {
    return this.findShifts(s, { ...query, terminalId });
  }

  async findReceipts(s: Scope, query: any) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 20;
    const where = orgDocs(s, { docType: 'RETAIL_DEMAND' });

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

  async createReceipt(s: Scope, data: any) {
    const items: any[] | undefined = data?.items;
    const rest = docHeader(s, { ...data, date: undefined });
    const total = items?.reduce((sum: number, i: any) => sum + i.qty * i.price, 0) || 0;

    return this.prisma.$transaction(async (tx) => {
      await assertTradeRefs(tx, s, { counterpartyId: rest.counterpartyId, storeIds: [rest.storeId], productIds: items?.map((i) => i.productId) });
      return tx.document.create({
        data: {
          docType: 'RETAIL_DEMAND',
          date: new Date(),
          number: await nextNumber(tx, s, 'RETAIL_DEMAND', 'ЧЕК', 8),
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
        } as Prisma.DocumentUncheckedCreateInput,
      });
    });
  }
}
