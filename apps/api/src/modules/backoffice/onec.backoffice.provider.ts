/**
 * FP-004: 1C Backoffice Provider
 * Adapts legacy OnecAdapter to canonical BackofficeProvider interface
 * Legacy oneCGUID mappings kept in idMap table, not exposed in domain
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import axios, { AxiosInstance } from 'axios';
import {
  BackofficeProvider,
  BackofficeCapability,
  BackofficeCapabilities,
  BackofficeDocument,
  BackofficeError,
  BackofficeErrorCode,
  AccountBalance,
  BackofficeReconciliation,
} from './backoffice.provider';

@Injectable()
export class OnecBackofficeProvider implements BackofficeProvider {
  readonly name = 'onec';
  private readonly logger = new Logger(OnecBackofficeProvider.name);
  private client: AxiosInstance | null = null;
  private connection: any = null;

  constructor(private prisma: PrismaService) {}

  /**
   * FP-004: Initialize with connection credentials
   */
  async initialize(connectionId: string) {
    this.connection = await this.prisma.onecConnection.findUnique({
      where: { id: connectionId },
    });
    if (!this.connection) throw new Error('1C connection not found');
    if (!this.connection.isActive) throw new Error('1C connection is inactive');

    this.client = axios.create({
      baseURL: this.connection.baseUrl,
      auth: {
        username: this.connection.username,
        password: this.connection.passwordEnc,
      },
      timeout: 30000,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  async capabilities(): Promise<BackofficeCapabilities> {
    return {
      capabilities: new Set([
        BackofficeCapability.CREATE_RECEIPT,
        BackofficeCapability.CREATE_SHIPMENT,
        BackofficeCapability.CREATE_GOODS_RECEIPT,
        BackofficeCapability.SYNC_PRODUCTS,
        BackofficeCapability.SYNC_STOCK,
        BackofficeCapability.POST_JOURNAL_ENTRY,
      ]),
      version: '1.0',
      description: '1C Enterprise 8.3+ OData API',
    };
  }

  async sendDocument(document: BackofficeDocument): Promise<{
    remoteId: string;
    status: 'ACCEPTED' | 'PENDING' | 'REJECTED';
    message?: string;
  }> {
    if (!this.client) throw this.error('NOT_INITIALIZED', 'Provider not initialized');

    try {
      // FP-004: Map canonical IDs to legacy oneCGUID using idMap
      const mappedDocument = await this.mapCanonicalToLegacy(document);

      // FP-004: Choose endpoint based on document type
      const endpoint = this.getEndpoint(document.documentType);
      const res = await this.client.post(endpoint, mappedDocument);

      // FP-004: Extract remote ID from response
      const remoteId = res.data.Ref_Key || res.data.id || res.data.uuid;
      if (!remoteId) {
        return {
          remoteId: '',
          status: 'PENDING',
          message: 'Document queued, ID pending confirmation',
        };
      }

      return {
        remoteId,
        status: 'ACCEPTED',
      };
    } catch (error: any) {
      throw this.handleError(error, document.operationId);
    }
  }

  async getDocumentStatus(
    operationId: string,
    remoteId?: string,
  ): Promise<{
    status: 'ACCEPTED' | 'PENDING' | 'REJECTED' | 'POSTED' | 'UNKNOWN';
    message?: string;
  }> {
    if (!this.client) throw this.error('NOT_INITIALIZED', 'Provider not initialized');

    try {
      if (!remoteId) {
        // FP-004: Look up remoteId from idMap using operationId
        const mapping = await this.prisma.idMap.findFirst({
          where: {
            entity: 'document',
            connectionId: this.connection?.id,
            localId: operationId,
          },
        });
        remoteId = mapping?.externalId;
      }

      if (!remoteId) {
        return { status: 'UNKNOWN', message: 'Remote ID not found' };
      }

      // FP-004: Query 1C document status
      const res = await this.client.get(`/odata/standard.odata/Document_РеализацияТоваровУслуг(guid'${remoteId}')`, {
        params: { $format: 'json' },
      });

      const posted = res.data.Posted || false;
      return {
        status: posted ? 'POSTED' : 'ACCEPTED',
      };
    } catch (error: any) {
      if (error.response?.status === 404) {
        return { status: 'UNKNOWN', message: 'Document not found in 1C' };
      }
      throw this.handleError(error, operationId);
    }
  }

  async reconcileAccount(accountCode: string, asOf: Date): Promise<BackofficeReconciliation> {
    if (!this.client) throw this.error('NOT_INITIALIZED', 'Provider not initialized');

    try {
      // FP-004: Get remote balance from 1C
      const res = await this.client.get(`/hs/flowpos/accounts/${accountCode}`, {
        params: {
          asOf: asOf.toISOString().split('T')[0],
          $format: 'json',
        },
      });

      const remoteBalance: AccountBalance = {
        accountCode,
        accountName: res.data.Name || accountCode,
        balance: {
          amountMinor: res.data.Balance || '0',
          currency: res.data.Currency || 'KZT',
        },
        asOf,
        currency: res.data.Currency || 'KZT',
      };

      // FP-004: Get local balance from our DB
      const localBalance: AccountBalance = {
        accountCode,
        accountName: accountCode,
        balance: {
          amountMinor: '0', // TODO: query from accounts table
          currency: 'KZT',
        },
        asOf,
        currency: 'KZT',
      };

      const remoteAmount = BigInt(String(remoteBalance.balance.amountMinor));
      const localAmount = BigInt(String(localBalance.balance.amountMinor));
      const variance = remoteAmount - localAmount;

      return {
        remoteBalance,
        localBalance,
        variance: variance !== 0n
          ? {
              amountMinor: String(variance),
              currency: 'KZT',
            }
          : undefined,
        reconciled: variance === 0n,
        lastReconciledAt: new Date(),
      };
    } catch (error: any) {
      throw this.handleError(error, `account-${accountCode}`);
    }
  }

  async requireCapability(cap: BackofficeCapability): Promise<void> {
    const caps = await this.capabilities();
    if (!caps.capabilities.has(cap)) {
      throw this.error('UNSUPPORTED_OPERATION', `1C does not support ${cap}`);
    }
  }

  async healthCheck(): Promise<boolean> {
    if (!this.client) return false;

    try {
      const res = await this.client.get('/odata/standard.odata/$metadata', {
        params: { $format: 'json' },
        timeout: 5000,
      });
      return res.status === 200;
    } catch {
      return false;
    }
  }

  // ─── FP-004: Private helpers ────────────────────────────────────────────────

  private async mapCanonicalToLegacy(document: BackofficeDocument): Promise<any> {
    // FP-004: Map canonical IDs to legacy oneCGUID
    const mapped = { ...document };

    for (const party of document.parties) {
      const idMapping = await this.prisma.idMap.findUnique({
        where: {
          entity_connectionId_onecGuid: {
            entity: 'party',
            connectionId: this.connection?.id,
            onecGuid: party.canonicalId,
          },
        },
      });
      // FP-004: Replace canonical ID with legacy only in API payload
      if (idMapping?.externalId) {
        party.externalId = idMapping.externalId;
      }
    }

    for (const item of document.items) {
      const idMapping = await this.prisma.idMap.findUnique({
        where: {
          entity_connectionId_onecGuid: {
            entity: 'product',
            connectionId: this.connection?.id,
            onecGuid: item.productId,
          },
        },
      });
      // FP-004: Replace canonical ID with legacy only in API payload
      if (idMapping?.externalId) {
        item.externalProductId = idMapping.externalId;
      }
    }

    return mapped;
  }

  private getEndpoint(documentType: string): string {
    const endpointMap: Record<string, string> = {
      RECEIPT: '/hs/flowpos/receipts',
      SHIPMENT: '/hs/flowpos/shipments',
      GOODS_RECEIPT: '/hs/flowpos/goods-receipts',
      RETURN: '/hs/flowpos/returns',
      PAYMENT: '/hs/flowpos/payments',
    };

    const endpoint = endpointMap[documentType];
    if (!endpoint) {
      throw this.error('UNSUPPORTED_OPERATION', `Document type ${documentType} not supported`);
    }
    return endpoint;
  }

  private handleError(error: any, operationId: string): BackofficeError {
    if (error.response?.status === 401 || error.response?.status === 403) {
      return this.error('AUTHENTICATION_FAILED', `Authentication failed for operation ${operationId}`);
    }
    if (error.response?.status === 404) {
      return this.error('RESOURCE_NOT_FOUND', `Resource not found for operation ${operationId}`);
    }
    if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
      return this.error('CONNECTION_ERROR', `Connection failed for operation ${operationId}`, true);
    }
    if (error.code === 'ECONNABORTED' || error.message?.includes('timeout')) {
      return this.error('TIMEOUT', `Timeout for operation ${operationId}`, true);
    }
    if (error.response?.status === 429) {
      return this.error('RATE_LIMITED', `Rate limited for operation ${operationId}`, true);
    }
    if (error.response?.status === 503) {
      return this.error('TEMPORARILY_UNAVAILABLE', `Service unavailable for operation ${operationId}`, true);
    }

    this.logger.error(`Unknown error for ${operationId}:`, error);
    return this.error('UNKNOWN', `Unknown error: ${error.message}`);
  }

  private error(code: BackofficeErrorCode, message: string, retryable = false): BackofficeError {
    return { code, message, retryable };
  }
}
