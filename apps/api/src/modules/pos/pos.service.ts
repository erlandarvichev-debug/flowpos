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
   * FP-003: Payment State Machine
   * States: CREATED → PENDING → CONFIRMED | REJECTED | UNKNOWN
   * UNKNOWN is stable (prevents blind retry); manual reconciliation required
   */
  async processPayment(saleId: string, paymentId: string, amount: number, timeoutMs = 30000) {
    const now = new Date();
    const timeoutAt = new Date(Date.now() + timeoutMs);

    // FP-003: Create payment attempt (durable before external effect)
    const attempt = await this.prisma.paymentAttempt.create({
      data: {
        id: uuidv4(),
        saleId,
        paymentId, // idempotency key for payment provider
        status: 'CREATED',
        amount,
        paymentMethod: 'UNKNOWN', // will be determined by caller
        timeoutAt,
      },
    });

    try {
      // FP-003: Transition to PENDING
      await this.prisma.paymentAttempt.update({
        where: { id: attempt.id },
        data: {
          status: 'PENDING',
          lastAttemptAt: now,
        },
      });

      // FP-003: Call payment provider with idempotency key
      // Provider must be idempotent: same paymentId → same result
      const providerResult = await this.callPaymentProvider(paymentId, amount);

      // FP-003: Handle provider response
      if (providerResult.status === 'CONFIRMED') {
        await this.prisma.paymentAttempt.update({
          where: { id: attempt.id },
          data: {
            status: 'CONFIRMED',
            confirmedAt: now,
            providerId: providerResult.providerId,
          },
        });
        return { status: 'CONFIRMED', attempt };
      } else if (providerResult.status === 'REJECTED') {
        await this.prisma.paymentAttempt.update({
          where: { id: attempt.id },
          data: {
            status: 'REJECTED',
            errorCode: providerResult.errorCode,
            errorMessage: providerResult.errorMessage,
          },
        });
        return { status: 'REJECTED', attempt };
      } else {
        // FP-003: UNKNOWN — timeout or no response
        // Do NOT automatically retry; requires manual reconciliation
        await this.prisma.paymentAttempt.update({
          where: { id: attempt.id },
          data: {
            status: 'UNKNOWN',
            errorCode: 'TIMEOUT_OR_UNKNOWN_RESPONSE',
          },
        });
        return { status: 'UNKNOWN', attempt };
      }
    } catch (error: any) {
      // FP-003: Error during payment processing
      await this.prisma.paymentAttempt.update({
        where: { id: attempt.id },
        data: {
          status: 'UNKNOWN',
          errorCode: 'PAYMENT_PROVIDER_ERROR',
          errorMessage: error.message,
        },
      });
      return { status: 'UNKNOWN', attempt };
    }
  }

  /**
   * FP-003: Fiscal State Machine
   * States: CREATED → SENT → REGISTERED | FAILED | UNKNOWN
   * UNKNOWN is stable; manual reconciliation required
   */
  async registerFiscal(
    saleId: string,
    receiptNumber: string,
    payloadHash: string,
    timeoutMs = 15000,
  ) {
    const now = new Date();
    const timeoutAt = new Date(Date.now() + timeoutMs);

    // FP-003: Create fiscal attempt (durable before external effect)
    const attempt = await this.prisma.fiscalAttempt.create({
      data: {
        id: uuidv4(),
        saleId,
        receiptNumber, // idempotency key for fiscal printer
        payloadHash, // immutable proof of payload
        status: 'CREATED',
        timeoutAt,
      },
    });

    try {
      // FP-003: Transition to SENT
      await this.prisma.fiscalAttempt.update({
        where: { id: attempt.id },
        data: {
          status: 'SENT',
          lastAttemptAt: now,
        },
      });

      // FP-003: Call fiscal printer with idempotency key
      // Printer must be idempotent: same receiptNumber + hash → same fiscal_number
      const printerResult = await this.callFiscalPrinter(receiptNumber, payloadHash);

      // FP-003: Handle printer response
      if (printerResult.status === 'REGISTERED') {
        await this.prisma.fiscalAttempt.update({
          where: { id: attempt.id },
          data: {
            status: 'REGISTERED',
            fiscalNumber: printerResult.fiscalNumber,
            fiscalDate: now,
            registeredAt: now,
            printerId: printerResult.printerId,
          },
        });
        return { status: 'REGISTERED', fiscalNumber: printerResult.fiscalNumber, attempt };
      } else if (printerResult.status === 'FAILED') {
        await this.prisma.fiscalAttempt.update({
          where: { id: attempt.id },
          data: {
            status: 'FAILED',
            errorCode: printerResult.errorCode,
            errorMessage: printerResult.errorMessage,
          },
        });
        return { status: 'FAILED', attempt };
      } else {
        // FP-003: UNKNOWN — timeout or no response
        // Do NOT automatically retry; requires manual reconciliation
        await this.prisma.fiscalAttempt.update({
          where: { id: attempt.id },
          data: {
            status: 'UNKNOWN',
            errorCode: 'TIMEOUT_OR_UNKNOWN_RESPONSE',
          },
        });
        return { status: 'UNKNOWN', attempt };
      }
    } catch (error: any) {
      // FP-003: Error during fiscal processing
      await this.prisma.fiscalAttempt.update({
        where: { id: attempt.id },
        data: {
          status: 'UNKNOWN',
          errorCode: 'FISCAL_PRINTER_ERROR',
          errorMessage: error.message,
        },
      });
      return { status: 'UNKNOWN', attempt };
    }
  }

  /**
   * FP-003: Reconciliation — lookup payment provider status
   * Used when payment is in UNKNOWN state after restart
   */
  async reconcilePayment(paymentAttemptId: string, paymentId: string) {
    const attempt = await this.prisma.paymentAttempt.findUnique({
      where: { id: paymentAttemptId },
    });

    if (!attempt) throw new NotFoundException('Payment attempt not found');
    if (attempt.status === 'CONFIRMED') return { status: 'CONFIRMED' };
    if (attempt.status === 'REJECTED') return { status: 'REJECTED' };
    if (attempt.status !== 'UNKNOWN') {
      throw new BadRequestException('Payment must be in UNKNOWN state to reconcile');
    }

    // FP-003: Look up payment status from provider (idempotent)
    const providerStatus = await this.lookupPaymentStatus(paymentId);

    const now = new Date();
    if (providerStatus === 'CONFIRMED') {
      await this.prisma.paymentAttempt.update({
        where: { id: paymentAttemptId },
        data: {
          status: 'CONFIRMED',
          confirmedAt: now,
          providerStatus,
        },
      });
      return { status: 'CONFIRMED' };
    } else if (providerStatus === 'REJECTED') {
      await this.prisma.paymentAttempt.update({
        where: { id: paymentAttemptId },
        data: {
          status: 'REJECTED',
          providerStatus,
        },
      });
      return { status: 'REJECTED' };
    } else {
      // Still UNKNOWN — provider doesn't know either
      await this.prisma.paymentAttempt.update({
        where: { id: paymentAttemptId },
        data: {
          lastLookupAt: now,
          providerStatus,
        },
      });
      return { status: 'UNKNOWN', lastLookupAt: now };
    }
  }

  /**
   * FP-003: Reconciliation — lookup fiscal printer status
   * Used when fiscal is in UNKNOWN state after restart
   */
  async reconcileFiscal(fiscalAttemptId: string, receiptNumber: string, payloadHash: string) {
    const attempt = await this.prisma.fiscalAttempt.findUnique({
      where: { id: fiscalAttemptId },
    });

    if (!attempt) throw new NotFoundException('Fiscal attempt not found');
    if (attempt.status === 'REGISTERED') return { status: 'REGISTERED', fiscalNumber: attempt.fiscalNumber };
    if (attempt.status === 'FAILED') return { status: 'FAILED' };
    if (attempt.status !== 'UNKNOWN') {
      throw new BadRequestException('Fiscal must be in UNKNOWN state to reconcile');
    }

    // FP-003: Look up fiscal status from printer (idempotent)
    const printerStatus = await this.lookupFiscalStatus(receiptNumber, payloadHash);

    const now = new Date();
    if (printerStatus.status === 'REGISTERED') {
      await this.prisma.fiscalAttempt.update({
        where: { id: fiscalAttemptId },
        data: {
          status: 'REGISTERED',
          fiscalNumber: printerStatus.fiscalNumber,
          registeredAt: now,
          printerStatus: JSON.stringify(printerStatus),
        },
      });
      return { status: 'REGISTERED', fiscalNumber: printerStatus.fiscalNumber };
    } else if (printerStatus.status === 'FAILED') {
      await this.prisma.fiscalAttempt.update({
        where: { id: fiscalAttemptId },
        data: {
          status: 'FAILED',
          printerStatus: JSON.stringify(printerStatus),
        },
      });
      return { status: 'FAILED' };
    } else {
      // Still UNKNOWN
      await this.prisma.fiscalAttempt.update({
        where: { id: fiscalAttemptId },
        data: {
          lastLookupAt: now,
          printerStatus: JSON.stringify(printerStatus),
        },
      });
      return { status: 'UNKNOWN', lastLookupAt: now };
    }
  }

  // ─── FP-003: Provider stub methods ───────────────────────────────────────────

  private async callPaymentProvider(paymentId: string, amount: number) {
    // TODO: Integrate with actual payment provider (Kaspi, Halyk, etc.)
    // Contract: must be idempotent on paymentId
    throw new Error('FP-003: Payment provider not configured');
  }

  private async lookupPaymentStatus(paymentId: string) {
    // TODO: Query payment provider for current status
    throw new Error('FP-003: Payment provider status lookup not configured');
  }

  private async callFiscalPrinter(receiptNumber: string, payloadHash: string) {
    // TODO: Integrate with actual fiscal printer
    // Contract: must be idempotent on receiptNumber + payloadHash
    throw new Error('FP-003: Fiscal printer not configured');
  }

  private async lookupFiscalStatus(receiptNumber: string, payloadHash: string) {
    // TODO: Query fiscal printer for current status
    throw new Error('FP-003: Fiscal printer status lookup not configured');
  }
}
