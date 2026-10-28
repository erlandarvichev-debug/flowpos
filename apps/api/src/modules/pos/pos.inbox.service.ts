/**
 * FP-005: POS Operation Inbox Service
 * Server-side durable inbox for point-of-sale operations
 *
 * Key guarantees:
 * - UNIQUE(tenant_id, org_id, operation_id) prevents duplicates
 * - Device migration preserves operation identity
 * - ACK is sent only after commit (idempotent)
 */

import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { v4 as uuidv4 } from 'uuid';
import * as crypto from 'crypto';

export interface PosOperationInboxEntry {
  operationId: string;
  deviceId: string;
  terminalId?: string;
  shiftId?: string;
  operationType: string; // SALE, RETURN, REFUND, MIXED_PAYMENT
  payloadHash: string;
}

@Injectable()
export class PosInboxService {
  constructor(private prisma: PrismaService) {}

  /**
   * FP-005: Receive operation from device (idempotent)
   * UNIQUE(tenant_id, org_id, operation_id) ensures duplicate suppression
   */
  async receiveOperation(
    tenantId: string,
    organizationId: string,
    entry: PosOperationInboxEntry,
  ) {
    // FP-005: Check for existing operation (device retry protection)
    const existing = await this.prisma.posOperationInbox.findUnique({
      where: {
        tenantId_organizationId_operationId: {
          tenantId,
          organizationId,
          operationId: entry.operationId,
        },
      },
    });

    if (existing) {
      // FP-005: Idempotent: same operation_id + payload_hash = return existing
      if (existing.payloadHash === entry.payloadHash) {
        return existing;
      }
      // Different payload = conflict (prevent silent corruption)
      throw new ConflictException(
        `Operation ${entry.operationId} already exists with different payload`,
      );
    }

    // FP-005: Create new inbox entry
    const inboxEntry = await this.prisma.posOperationInbox.create({
      data: {
        id: uuidv4(),
        tenantId,
        organizationId,
        operationId: entry.operationId,
        deviceId: entry.deviceId,
        terminalId: entry.terminalId,
        shiftId: entry.shiftId,
        operationType: entry.operationType,
        payloadHash: entry.payloadHash,
        status: 'RECEIVED',
      },
    });

    return inboxEntry;
  }

  /**
   * FP-005: Mark operation as processing (atomic claim)
   * Only one server process can transition RECEIVED → PROCESSING
   */
  async claimForProcessing(inboxId: string) {
    const updated = await this.prisma.posOperationInbox.updateMany({
      where: {
        id: inboxId,
        status: 'RECEIVED',
      },
      data: {
        status: 'PROCESSING',
      },
    });

    if (updated.count === 0) {
      throw new ConflictException('Operation not available for processing (already claimed)');
    }

    return this.prisma.posOperationInbox.findUnique({ where: { id: inboxId } });
  }

  /**
   * FP-005: Mark operation as confirmed (processing complete)
   */
  async confirmProcessing(inboxId: string, saleId?: string) {
    const confirmed = await this.prisma.posOperationInbox.update({
      where: { id: inboxId },
      data: {
        status: 'CONFIRMED',
        processedAt: new Date(),
      },
    });

    // FP-005: Link sale to inbox (if created successfully)
    if (saleId) {
      await this.prisma.posSales.update({
        where: { id: saleId },
        data: { inboxId },
      });
    }

    return confirmed;
  }

  /**
   * FP-005: Mark operation as failed
   */
  async failProcessing(inboxId: string, error: string) {
    return this.prisma.posOperationInbox.update({
      where: { id: inboxId },
      data: {
        status: 'FAILED',
        processingError: error,
        processedAt: new Date(),
      },
    });
  }

  /**
   * FP-005: Send ACK back to device (idempotent)
   * ACK sent only after successful commit
   */
  async sendAck(inboxId: string): Promise<{
    ackToken: string;
    shouldSendToDevice: boolean;
  }> {
    const entry = await this.prisma.posOperationInbox.findUnique({
      where: { id: inboxId },
    });

    if (!entry) throw new NotFoundException('Inbox entry not found');

    // FP-005: Already sent ACK
    if (entry.ackSentAt) {
      return { ackToken: entry.ackToken!, shouldSendToDevice: false };
    }

    // FP-005: Generate ACK token (idempotency key for device)
    const ackToken = uuidv4();
    await this.prisma.posOperationInbox.update({
      where: { id: inboxId },
      data: {
        ackSentAt: new Date(),
        ackToken,
      },
    });

    return { ackToken, shouldSendToDevice: true };
  }

  /**
   * FP-005: Device migration (old_device → new_device, operation preserved)
   * Ensures replaced/relocated device doesn't create duplicate sales
   */
  async recordDeviceMigration(
    tenantId: string,
    organizationId: string,
    oldDeviceId: string,
    newDeviceId: string,
    reason?: string,
  ) {
    const migration = await this.prisma.deviceMigration.upsert({
      where: {
        tenantId_organizationId_oldDeviceId: {
          tenantId,
          organizationId,
          oldDeviceId,
        },
      },
      create: {
        id: uuidv4(),
        tenantId,
        organizationId,
        oldDeviceId,
        newDeviceId,
        migrationReason: reason,
      },
      update: {
        newDeviceId, // Allow updating target device
      },
    });

    return migration;
  }

  /**
   * FP-005: Look up operation by ID (after device migration)
   */
  async lookupOperation(tenantId: string, organizationId: string, operationId: string) {
    return this.prisma.posOperationInbox.findUnique({
      where: {
        tenantId_organizationId_operationId: {
          tenantId,
          organizationId,
          operationId,
        },
      },
    });
  }

  /**
   * FP-005: Get pending operations for processing
   */
  async getPendingOperations(tenantId: string, limit = 100) {
    return this.prisma.posOperationInbox.findMany({
      where: {
        tenantId,
        status: 'RECEIVED',
      },
      orderBy: { receivedAt: 'asc' },
      take: limit,
    });
  }
}
