import { Injectable, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { v4 as uuidv4 } from 'uuid';
import * as crypto from 'crypto';

/**
 * FP-002: Atomic POS Sale Service
 * One Prisma transaction per sale:
 * - Insert sale, lines, payments, recovery job
 * - All succeed or all rollback
 * - Idempotent: operation_id UNIQUE
 */
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

  /**
   * FP-002: Atomic sale command
   * One transaction: BEGIN → INSERT sale/lines/payments/recovery → COMMIT
   * 
   * Contract:
   * - operation_id UNIQUE: same operation → same result (idempotent)
   * - All inserts succeed or all rollback
   * - payload_hash immutable (cannot change after commit)
   * - Recovery job created BEFORE external effects
   */
  async atomicSale(data: {
    tenantId: string;
    organizationId: string;
    operationId: string;
    deviceId: string;
    terminalId: string;
    shiftId: string;
    saleNumber: string;
    saleDate: Date;
    totalAmount: number; // in minor units
    items: Array<{ productId: string; qty: number; unitPrice: number; discount: number; lineTotal: number }>;
    payments: Array<{ paymentId: string; type: string; amount: number }>;
  }) {
    // FP-002: Calculate payload hash for idempotency
    const payloadHash = crypto
      .createHash('sha256')
      .update(JSON.stringify({
        operationId: data.operationId,
        items: data.items,
        payments: data.payments,
        totalAmount: data.totalAmount,
      }))
      .digest('hex');

    try {
      // FP-002: Atomic transaction
      const sale = await this.prisma.$transaction(async (tx) => {
        const saleId = uuidv4();

        // Insert sale (UNIQUE operation_id prevents duplicates)
        const createdSale = await tx.posSales.create({
          data: {
            id: saleId,
            operationId: data.operationId,
            deviceId: data.deviceId,
            terminalId: data.terminalId,
            shiftId: data.shiftId,
            saleNumber: data.saleNumber,
            saleDate: data.saleDate,
            totalAmount: data.totalAmount,
            payloadHash,
            status: 'DRAFT',
            tenantId: data.tenantId,
            organizationId: data.organizationId,
          },
        });

        // Insert receipt lines
        for (const [idx, item] of data.items.entries()) {
          await tx.posReceiptLines.create({
            data: {
              id: uuidv4(),
              saleId,
              productId: item.productId,
              qty: item.qty,
              unitPrice: item.unitPrice,
              discount: item.discount,
              lineTotal: item.lineTotal,
              sequence: idx + 1,
            },
          });
        }

        // Insert expected payments (for recovery)
        for (const payment of data.payments) {
          await tx.posPayments.create({
            data: {
              id: uuidv4(),
              saleId,
              paymentId: payment.paymentId,
              type: payment.type,
              amount: payment.amount,
              status: 'CREATED',
            },
          });
        }

        // FP-002: Insert recovery job BEFORE external effects
        // This ensures we can retry payment/fiscal if process crashes
        await tx.recoveryJobs.create({
          data: {
            id: uuidv4(),
            saleId,
            status: 'PENDING_PAYMENT',
            retryCount: 0,
            nextRetryAt: new Date(),
          },
        });

        return createdSale;
      });

      return {
        saleId: sale.id,
        receiptNumber: sale.saleNumber,
        status: 'INTENT_STORED',
        // FP-002: Return here, external effects called by caller
      };
    } catch (error: any) {
      // FP-002: UNIQUE constraint → idempotent return existing sale
      if (error.code === 'P2002' && error.meta?.target?.includes('operationId')) {
        // Operation already exists, return it
        const existingSale = await this.prisma.posSales.findUnique({
          where: { operationId: data.operationId },
        });
        if (existingSale) {
          return {
            saleId: existingSale.id,
            receiptNumber: existingSale.saleNumber,
            status: 'IDEMPOTENT',
          };
        }
      }
      throw error;
    }
  }

  /**
   * FP-002: Read sale by operation_id (after external effect failure)
   * Used to recover from payment provider crash
   */
  async getSaleByOperationId(operationId: string) {
    return this.prisma.posSales.findUnique({
      where: { operationId },
      include: {
        lines: true,
        payments: true,
        recovery: true,
      },
    });
  }

  /**
   * FP-002: External effect: Process payment (idempotent)
   * Called AFTER atomicSale() returns successfully
   */
  async processPayment(saleId: string, paymentId: string, amount: number) {
    // TODO: Call payment provider with paymentId (idempotency key)
    // Should return: CONFIRMED | REJECTED | TIMEOUT
    // On success: update pos_payments status = CONFIRMED
    // On failure: update recovery_jobs status = PENDING_FISCAL and log error
    throw new Error('FP-002: Payment provider not implemented');
  }

  /**
   * FP-002: External effect: Register fiscal (idempotent)
   * Called AFTER payment is confirmed
   */
  async registerFiscal(saleId: string, receiptNumber: string, payloadHash: string) {
    // TODO: Call fiscal printer with receiptNumber + payloadHash (idempotency key)
    // Should return: fiscal_number or error
    // On success: update pos_sales fiscal_number, update recovery_jobs status = COMPLETED
    // On failure: log to fiscal_attempts, update recovery_jobs for retry
    throw new Error('FP-002: Fiscal printer not implemented');
  }
}
