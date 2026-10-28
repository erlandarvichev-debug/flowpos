/**
 * FP-004: MoySklad Backoffice Provider
 * Adapts legacy MoySklad integration to canonical interface
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { BackofficeProvider, BackofficeCapability, BackofficeCapabilities, BackofficeDocument, BackofficeError, BackofficeErrorCode, AccountBalance, BackofficeReconciliation } from './backoffice.provider';

@Injectable()
export class MoyskladBackofficeProvider implements BackofficeProvider {
  readonly name = 'moysklad';
  private readonly logger = new Logger(MoyskladBackofficeProvider.name);
  private connection: any = null;

  constructor(private prisma: PrismaService) {}

  async initialize(connectionId: string) {
    this.connection = await this.prisma.moyskladConnection.findUnique({
      where: { id: connectionId },
    });
    if (!this.connection) throw new Error('MoySklad connection not found');
    if (!this.connection.isActive) throw new Error('MoySklad connection is inactive');
  }

  async capabilities(): Promise<BackofficeCapabilities> {
    return {
      capabilities: new Set([
        BackofficeCapability.SYNC_PRODUCTS,
        BackofficeCapability.SYNC_STOCK,
        BackofficeCapability.CREATE_RECEIPT,
        BackofficeCapability.REPORT_INVENTORY,
      ]),
      version: '1.0',
      description: 'MoySklad REST API',
    };
  }

  async sendDocument(document: BackofficeDocument): Promise<{
    remoteId: string;
    status: 'ACCEPTED' | 'PENDING' | 'REJECTED';
    message?: string;
  }> {
    // TODO: Implement MoySklad document sending
    throw new Error('FP-004: MoySklad provider not yet implemented');
  }

  async getDocumentStatus(
    operationId: string,
    remoteId?: string,
  ): Promise<{
    status: 'ACCEPTED' | 'PENDING' | 'REJECTED' | 'POSTED' | 'UNKNOWN';
    message?: string;
  }> {
    // TODO: Implement MoySklad status lookup
    throw new Error('FP-004: MoySklad provider not yet implemented');
  }

  async reconcileAccount(accountCode: string, asOf: Date): Promise<BackofficeReconciliation> {
    // TODO: Implement MoySklad reconciliation
    throw new Error('FP-004: MoySklad provider not yet implemented');
  }

  async requireCapability(cap: BackofficeCapability): Promise<void> {
    const caps = await this.capabilities();
    if (!caps.capabilities.has(cap)) {
      throw new Error(`MoySklad does not support ${cap}`);
    }
  }

  async healthCheck(): Promise<boolean> {
    // TODO: Implement MoySklad health check
    return false;
  }
}
