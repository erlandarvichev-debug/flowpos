/**
 * FP-004: Canonical BackofficeProvider Contract
 * Unified interface for ERP backoffice systems (1C, MoySklad, FlowPOS internal, etc.)
 *
 * Key principles:
 * - No oneCGUID or accountHref in domain (legacy mapping only)
 * - Capabilities declare what this provider supports
 * - Each entity has one writer; no double-write
 * - All operations are idempotent (operation_id based)
 * - Errors typed; retry semantics explicit
 */

export enum BackofficeCapability {
  // Core document operations
  CREATE_RECEIPT = 'CREATE_RECEIPT',
  CREATE_SHIPMENT = 'CREATE_SHIPMENT',
  CREATE_GOODS_RECEIPT = 'CREATE_GOODS_RECEIPT',
  CREATE_RETURN = 'CREATE_RETURN',

  // Inventory management
  SYNC_PRODUCTS = 'SYNC_PRODUCTS',
  SYNC_STOCK = 'SYNC_STOCK',
  REPORT_INVENTORY = 'REPORT_INVENTORY',

  // Accounting
  POST_JOURNAL_ENTRY = 'POST_JOURNAL_ENTRY',
  GET_ACCOUNT_BALANCE = 'GET_ACCOUNT_BALANCE',
  CLOSE_PERIOD = 'CLOSE_PERIOD',

  // Payments & Treasury
  RECORD_PAYMENT = 'RECORD_PAYMENT',
  REPORT_CASH_FLOW = 'REPORT_CASH_FLOW',

  // Payroll (future)
  RECORD_PAYROLL_RUN = 'RECORD_PAYROLL_RUN',

  // Reporting
  GET_REPORT = 'GET_REPORT',
  EXPORT_DATA = 'EXPORT_DATA',
}

export enum BackofficeErrorCode {
  // Validation errors (not retryable)
  VALIDATION_FAILED = 'VALIDATION_FAILED',
  UNKNOWN_ENTITY = 'UNKNOWN_ENTITY',
  DUPLICATE_OPERATION = 'DUPLICATE_OPERATION',
  STALE_VERSION = 'STALE_VERSION',

  // Transient errors (retryable)
  TIMEOUT = 'TIMEOUT',
  CONNECTION_ERROR = 'CONNECTION_ERROR',
  TEMPORARILY_UNAVAILABLE = 'TEMPORARILY_UNAVAILABLE',
  RATE_LIMITED = 'RATE_LIMITED',

  // Fatal errors (not retryable)
  AUTHENTICATION_FAILED = 'AUTHENTICATION_FAILED',
  AUTHORIZATION_FAILED = 'AUTHORIZATION_FAILED',
  RESOURCE_NOT_FOUND = 'RESOURCE_NOT_FOUND',
  UNSUPPORTED_OPERATION = 'UNSUPPORTED_OPERATION',

  // Unknown
  UNKNOWN = 'UNKNOWN',
}

export interface BackofficeError {
  code: BackofficeErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export interface BackofficeCapabilities {
  capabilities: Set<BackofficeCapability>;
  version: string;
  description: string;
}

/**
 * FP-004: Canonical money representation (minor units + currency)
 * Never use float; always decimal string or integer minor units
 */
export interface Money {
  amountMinor: string | number; // cents, kopecks, etc.
  currency: string; // ISO 4217: KZT, USD, EUR
}

/**
 * FP-004: Common document structure for all document types
 * Canonical product_id, party_id; legacy mappings separate
 */
export interface BackofficeDocument {
  operationId: string; // idempotency key (tenant+org+operation scope)
  documentType: string; // RECEIPT | SHIPMENT | GOODS_RECEIPT | RETURN | PAYMENT
  documentNumber: string; // local number
  documentDate: Date;

  // Core parties & items
  parties: BackofficeParty[];
  items: BackofficeLineItem[];

  // Money (no float)
  totalWithoutTax: Money;
  totalTax: Money;
  totalWithTax: Money;

  // Versioning & idempotency
  expectedVersion?: number;
  idempotencyKey: string; // operationId + payload_hash

  // Metadata
  metadata?: Record<string, unknown>;
}

export interface BackofficeParty {
  kind: 'SUPPLIER' | 'CUSTOMER' | 'CARRIER' | 'OTHER';
  canonicalId: string; // internal product_id (NOT oneCGUID)
  externalId?: string; // legacy system ID (if different)
  name: string;
  taxId?: string;
  address?: string;
}

export interface BackofficeLineItem {
  productId: string; // canonical ID (NOT oneCGUID)
  productName: string;
  quantity: number;
  unitPrice: Money;
  discount?: Money;
  taxRate?: number;
  amount: Money;

  // Batch/lot tracking
  lotNumber?: string;
  expiryDate?: Date;

  // Legacy mapping
  externalProductId?: string;
}

/**
 * FP-004: Reconciliation struct for accounts/balances
 */
export interface AccountBalance {
  accountCode: string;
  accountName: string;
  balance: Money;
  asOf: Date;
  currency: string;
  dimensions?: Record<string, string>; // cost center, project, etc.
}

export interface BackofficeReconciliation {
  remoteBalance: AccountBalance;
  localBalance: AccountBalance;
  variance?: Money;
  reconciled: boolean;
  lastReconciledAt?: Date;
}

/**
 * FP-004: Main provider interface
 * Implementations: OnecBackofficeProvider, MoyskladBackofficeProvider, InternalBackofficeProvider
 */
export interface BackofficeProvider {
  name: string;
  capabilities(): Promise<BackofficeCapabilities>;

  /**
   * FP-004: Send document to backoffice
   * @param document Canonical document (no oneCGUID/accountHref in fields)
   * @returns remoteId for reconciliation
   * @throws BackofficeError with code and retryable flag
   */
  sendDocument(document: BackofficeDocument): Promise<{
    remoteId: string;
    status: 'ACCEPTED' | 'PENDING' | 'REJECTED';
    message?: string;
  }>;

  /**
   * FP-004: Check document status in backoffice
   * @param operationId idempotency key
   * @param remoteId for provider-specific status lookup
   * @returns current status
   */
  getDocumentStatus(
    operationId: string,
    remoteId?: string,
  ): Promise<{
    status: 'ACCEPTED' | 'PENDING' | 'REJECTED' | 'POSTED' | 'UNKNOWN';
    message?: string;
  }>;

  /**
   * FP-004: Reconcile account balance
   * @param accountCode canonical account
   * @param asOf date
   * @returns variance if any
   */
  reconcileAccount(accountCode: string, asOf: Date): Promise<BackofficeReconciliation>;

  /**
   * FP-004: Check capability before operation
   * @throws BackofficeError if not supported
   */
  requireCapability(cap: BackofficeCapability): Promise<void>;

  /**
   * FP-004: Health check
   * @returns true if provider is reachable and authenticated
   */
  healthCheck(): Promise<boolean>;
}

/**
 * FP-004: Legacy mapping storage (separate from domain)
 * Keeps old IDs without polluting business logic
 */
export interface LegacyMapping {
  canonicalId: string; // our ID
  externalSystem: string; // 'onec' | 'moysklad' | etc.
  externalId: string; // their ID (oneCGUID, accountHref, etc.)
  mappedAt: Date;
  syncedAt: Date;
}

/**
 * FP-004: Provider registry (dependency injection container)
 * Selects appropriate provider per organization + feature flag
 */
export interface BackofficeProviderRegistry {
  getProvider(organizationId: string, system: string): Promise<BackofficeProvider>;
  listAvailable(organizationId: string): Promise<string[]>;
  setActive(organizationId: string, system: string): Promise<void>;
}
