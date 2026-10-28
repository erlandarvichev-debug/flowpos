/**
 * FP-006: POS API Controller for Pilot Testing
 * Endpoints for device operations: sale creation, payment, fiscal status
 */

import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Headers,
  BadRequestException,
  ConflictException,
  HttpCode,
} from '@nestjs/common';
import { PosService } from './pos.service';
import { PosInboxService } from './pos.inbox.service';
import * as crypto from 'crypto';

@Controller('api/v1/pos')
export class PosController {
  constructor(
    private posService: PosService,
    private inboxService: PosInboxService,
  ) {}

  /**
   * FP-006: Receive sale intent from POS device
   */
  @Post('sales')
  @HttpCode(202) // Accepted (processing)
  async createSale(
    @Headers('x-flowpos-tenant') tenantId: string,
    @Headers('x-flowpos-organization') organizationId: string,
    @Headers('idempotency-key') idempotencyKey: string,
    @Body()
    body: {
      operationId: string;
      deviceId: string;
      terminalId?: string;
      shiftId?: string;
      saleNumber: string;
      saleDate: string;
      totalAmount: number;
      items: Array<{
        productId: string;
        qty: number;
        unitPrice: number;
        discount: number;
        lineTotal: number;
      }>;
      payments: Array<{
        paymentId: string;
        type: string;
        amount: number;
      }>;
    },
  ) {
    if (!tenantId || !organizationId || !idempotencyKey) {
      throw new BadRequestException('Missing required headers');
    }

    const payloadHash = crypto
      .createHash('sha256')
      .update(JSON.stringify({ operationId: body.operationId, items: body.items }))
      .digest('hex');

    try {
      const inboxEntry = await this.inboxService.receiveOperation(tenantId, organizationId, {
        operationId: body.operationId,
        deviceId: body.deviceId,
        terminalId: body.terminalId,
        shiftId: body.shiftId,
        operationType: 'SALE',
        payloadHash,
      });

      const claimed = await this.inboxService.claimForProcessing(inboxEntry.id);
      if (!claimed) {
        throw new ConflictException('Operation being processed by another worker');
      }

      const saleResult = await this.posService.atomicSale({
        tenantId,
        organizationId,
        operationId: body.operationId,
        deviceId: body.deviceId,
        terminalId: body.terminalId || '',
        shiftId: body.shiftId || '',
        saleNumber: body.saleNumber,
        saleDate: new Date(body.saleDate),
        totalAmount: body.totalAmount,
        items: body.items,
        payments: body.payments,
      });

      await this.inboxService.confirmProcessing(inboxEntry.id, saleResult.saleId);
      const ack = await this.inboxService.sendAck(inboxEntry.id);

      return {
        status: 'ACCEPTED',
        saleId: saleResult.saleId,
        receiptNumber: saleResult.receiptNumber,
        ackToken: ack.ackToken,
        paymentStatus: 'PENDING',
        fiscalStatus: 'PENDING',
      };
    } catch (error: any) {
      throw error;
    }
  }

  /**
   * FP-006: Get sale status
   */
  @Get('sales/:operationId/status')
  async getSaleStatus(
    @Headers('x-flowpos-tenant') tenantId: string,
    @Headers('x-flowpos-organization') organizationId: string,
    @Param('operationId') operationId: string,
  ) {
    const sale = await this.posService.getSaleByOperationId(operationId);
    if (!sale) {
      throw new BadRequestException('Sale not found');
    }

    return {
      saleId: sale.id,
      status: sale.status,
      paymentStatus: 'PENDING',
      fiscalStatus: 'PENDING',
    };
  }

  /**
   * FP-006: Health check
   */
  @Get('health')
  async health() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      version: '1.0',
    };
  }
}
