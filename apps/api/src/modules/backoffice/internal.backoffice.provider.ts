/**
 * FP-004: Internal Backoffice Provider
 * Local-only provider for testing and isolated organizations
 * No external effects; documents accepted without sync
 */

import { Injectable, Logger } from '@nestjs/common';
import { BackofficeProvider, BackofficeCapability, BackofficeCapabilities, BackofficeDocument, AccountBalance, BackofficeReconciliation } from './backoffice.provider';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class InternalBackofficeProvider implements BackofficeProvider {
  readonly name = 'internal';
  private readonly logger = new Logger(InternalBackofficeProvider.name);

  async capabilities(): Promise<BackofficeCapabilities> {
    return {
      capabilities: new Set([
        BackofficeCapability.CREATE_RECEIPT,
        BackofficeCapability.CREATE_SHIPMENT,
        BackofficeCapability.CREATE_GOODS_RECEIPT,
        BackofficeCapability.CREATE_RETURN,
        BackofficeCapability.SYNC_PRODUCTS,
        BackofficeCapability.SYNC_STOCK,
        BackofficeCapability.REPORT_INVENTORY,
        BackofficeCapability.POST_JOURNAL_ENTRY,
        BackofficeCapability.GET_ACCOUNT_BALANCE,
        BackofficeCapability.RECORD_PAYMENT,
        BackofficeCapability.REPORT_CASH_FLOW,
        BackofficeCapability.GET_REPORT,
        BackofficeCapability.EXPORT_DATA,
      ]),
      version: '1.0',
      description: 'Internal FlowPOS storage (no external sync)',
    };
  }

  /**
   * FP-004: Accept all documents without external sync
   * Generate synthetic remoteId for local tracking
   */
  async sendDocument(document: BackofficeDocument): Promise<{
    remoteId: string;
    status: 'ACCEPTED' | 'PENDING' | 'REJECTED';
    message?: string;
  }> {
    const remoteId = `internal-${document.operationId}`;
    this.logger.log(`Document ${document.operationId} accepted locally as ${remoteId}`);

    return {
      remoteId,
      status: 'ACCEPTED',
      message: 'Document accepted (internal storage)',
    };
  }

  /**
   * FP-004: Return ACCEPTED for all documents
   */
  async getDocumentStatus(
    operationId: string,
    remoteId?: string,
  ): Promise<{
    status: 'ACCEPTED' | 'PENDING' | 'REJECTED' | 'POSTED' | 'UNKNOWN';
    message?: string;
  }> {
    return {
      status: 'ACCEPTED',
      message: 'Local document',
    };
  }

  /**
   * FP-004: Reconciliation always matches (no variance)
   */
  async reconcileAccount(accountCode: string, asOf: Date): Promise<BackofficeReconciliation> {
    const balance: AccountBalance = {
      accountCode,
      accountName: accountCode,
      balance: { amountMinor: '0', currency: 'KZT' },
      asOf,
      currency: 'KZT',
    };

    return {
      remoteBalance: balance,
      localBalance: balance,
      reconciled: true,
      lastReconciledAt: new Date(),
    };
  }

  async requireCapability(cap: BackofficeCapability): Promise<void> {
    // Internal provider supports everything
  }

  /**
   * FP-004: Always healthy (no external dependencies)
   */
  async healthCheck(): Promise<boolean> {
    return true;
  }
}
