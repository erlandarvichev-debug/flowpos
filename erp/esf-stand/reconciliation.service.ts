/**
 * FP-012 Phase 2: Reconciliation Service
 * Automatic UNKNOWN document reconciliation
 *
 * Responsibilities:
 * - Find documents in UNKNOWN state
 * - Check if old enough (> threshold)
 * - Reconcile with gateway (get final status)
 * - Update local state
 * - Log reconciliation attempts
 */

import { InboundPoller, type ReconciliationResult } from './inbound-poller.ts';

export interface ReconcileMetrics {
  total: number; // UNKNOWN documents found
  reconciled: number; // Successfully moved to terminal state
  failed: number; // Reconciliation attempts failed
  skipped: number; // Too young (< threshold)
  errors: Array<{
    externalId: string;
    error: string;
  }>;
  duration: number; // milliseconds
}

export interface ReconciliationConfig {
  // Age threshold (seconds) - only reconcile UNKNOWN older than this
  ageThreshold?: number; // default 5 * 60 = 300 seconds

  // Max documents to reconcile per run
  maxPerRun?: number; // default 100

  // Whether to continue on individual failures
  continueOnError?: boolean; // default true
}

/**
 * FP-012: Reconciliation Service
 * Coordinates UNKNOWN document reconciliation
 */
export class ReconciliationService {
  private poller: InboundPoller;
  private ageThreshold: number; // seconds
  private maxPerRun: number;
  private continueOnError: boolean;

  constructor(
    poller: InboundPoller,
    config?: ReconciliationConfig,
  ) {
    this.poller = poller;
    this.ageThreshold = config?.ageThreshold || 5 * 60; // 5 minutes default
    this.maxPerRun = config?.maxPerRun || 100;
    this.continueOnError = config?.continueOnError !== false;
  }

  /**
   * FP-012: Reconcile all old UNKNOWN documents
   * Returns metrics about reconciliation run
   */
  async reconcileUnknown(scope: any): Promise<ReconcileMetrics> {
    const startTime = Date.now();
    const errors: Array<{ externalId: string; error: string }> = [];
    let reconciled = 0;
    let failed = 0;
    let skipped = 0;
    let total = 0;

    try {
      // Call poller's batch reconciliation
      const result = await this.poller.reconcileUnknown(
        scope,
        this.ageThreshold,
      );

      reconciled = result.reconciled;
      failed = result.failed;
      total = reconciled + failed;

      // Build error list
      for (const error of result.errors) {
        errors.push({
          externalId: 'unknown',
          error,
        });
      }
    } catch (error: any) {
      errors.push({
        externalId: 'batch',
        error: error.message,
      });
      failed++;
    }

    const duration = Date.now() - startTime;

    return {
      total,
      reconciled,
      failed,
      skipped,
      errors,
      duration,
    };
  }

  /**
   * FP-012: Get reconciliation status
   * Check how many UNKNOWN documents are ready for reconciliation
   */
  async getStatus(scope: any): Promise<{
    unknownCount: number;
    readyCount: number; // >= ageThreshold
    pendingCount: number; // < ageThreshold
    maxPerRun: number;
  }> {
    // This would query the store for counts
    // For now, return stub
    return {
      unknownCount: 0,
      readyCount: 0,
      pendingCount: 0,
      maxPerRun: this.maxPerRun,
    };
  }

  /**
   * FP-012: Set age threshold (in seconds)
   * Only reconcile UNKNOWN documents older than this
   */
  setAgeThreshold(seconds: number): void {
    if (seconds < 0) {
      throw new Error('Age threshold must be non-negative');
    }
    this.ageThreshold = seconds;
  }

  /**
   * FP-012: Get age threshold
   */
  getAgeThreshold(): number {
    return this.ageThreshold;
  }
}

/**
 * FP-012: Polling Scheduler
 * Coordinates periodic polling and reconciliation
 */
export interface SchedulerConfig {
  // Poll interval (milliseconds)
  pollInterval?: number; // default 60 * 1000 = 60 seconds

  // Reconciliation interval
  reconcileInterval?: number; // default 5 * 60 * 1000 = 5 minutes

  // Whether to start automatically
  autoStart?: boolean; // default false
}

export class PollingScheduler {
  private poller: InboundPoller;
  private reconciler: ReconciliationService;
  private pollInterval: number;
  private reconcileInterval: number;
  private pollTimerId: NodeJS.Timeout | null = null;
  private reconcileTimerId: NodeJS.Timeout | null = null;
  private scope: any;
  private isRunning = false;

  // Metrics
  private pollCount = 0;
  private reconcileCount = 0;
  private lastPollTime: Date | null = null;
  private lastReconcileTime: Date | null = null;

  constructor(
    poller: InboundPoller,
    reconciler: ReconciliationService,
    scope: any,
    config?: SchedulerConfig,
  ) {
    this.poller = poller;
    this.reconciler = reconciler;
    this.scope = scope;
    this.pollInterval = config?.pollInterval || 60 * 1000; // 60 seconds
    this.reconcileInterval = config?.reconcileInterval || 5 * 60 * 1000; // 5 minutes

    if (config?.autoStart) {
      this.start();
    }
  }

  /**
   * FP-012: Start periodic polling and reconciliation
   */
  start(): void {
    if (this.isRunning) {
      return; // Already running
    }

    this.isRunning = true;

    // Start polling
    this.pollTimerId = setInterval(async () => {
      try {
        await this.doPoll();
      } catch (error) {
        console.error('Polling error:', error);
      }
    }, this.pollInterval);

    // Start reconciliation
    this.reconcileTimerId = setInterval(async () => {
      try {
        await this.doReconcile();
      } catch (error) {
        console.error('Reconciliation error:', error);
      }
    }, this.reconcileInterval);

    console.log(
      `PollingScheduler started: poll every ${this.pollInterval}ms, reconcile every ${this.reconcileInterval}ms`,
    );
  }

  /**
   * FP-012: Stop periodic polling and reconciliation
   */
  stop(): void {
    if (!this.isRunning) {
      return; // Already stopped
    }

    this.isRunning = false;

    if (this.pollTimerId) {
      clearInterval(this.pollTimerId);
      this.pollTimerId = null;
    }

    if (this.reconcileTimerId) {
      clearInterval(this.reconcileTimerId);
      this.reconcileTimerId = null;
    }

    console.log('PollingScheduler stopped');
  }

  /**
   * FP-012: Internal: execute poll
   */
  private async doPoll(): Promise<void> {
    const result = await this.poller.poll(this.scope);

    this.pollCount++;
    this.lastPollTime = new Date();

    const message = `[Poll #${this.pollCount}] Fetched: ${result.documentsFetched}, Saved: ${result.documentsSaved}, Dupes: ${result.duplicates}`;

    if (result.errors.length > 0) {
      console.warn(`${message}, Errors: ${result.errors.length}`);
    } else {
      console.log(message);
    }
  }

  /**
   * FP-012: Internal: execute reconciliation
   */
  private async doReconcile(): Promise<void> {
    const result = await this.reconciler.reconcileUnknown(this.scope);

    this.reconcileCount++;
    this.lastReconcileTime = new Date();

    const message = `[Reconcile #${this.reconcileCount}] Total: ${result.total}, Reconciled: ${result.reconciled}, Failed: ${result.failed} (${result.duration}ms)`;

    if (result.errors.length > 0) {
      console.warn(`${message}, Errors: ${result.errors.length}`);
    } else {
      console.log(message);
    }
  }

  /**
   * FP-012: Get scheduler metrics
   */
  getMetrics(): {
    isRunning: boolean;
    pollCount: number;
    reconcileCount: number;
    lastPollTime: Date | null;
    lastReconcileTime: Date | null;
    pollInterval: number;
    reconcileInterval: number;
  } {
    return {
      isRunning: this.isRunning,
      pollCount: this.pollCount,
      reconcileCount: this.reconcileCount,
      lastPollTime: this.lastPollTime,
      lastReconcileTime: this.lastReconcileTime,
      pollInterval: this.pollInterval,
      reconcileInterval: this.reconcileInterval,
    };
  }

  /**
   * FP-012: Check if running
   */
  isActive(): boolean {
    return this.isRunning;
  }
}

/**
 * FP-012: Mock Reconciliation Service (for testing)
 */
export class MockReconciliationService {
  private reconcileCount = 0;

  async reconcileUnknown(scope: any): Promise<ReconcileMetrics> {
    this.reconcileCount++;

    return {
      total: 5,
      reconciled: 5,
      failed: 0,
      skipped: 0,
      errors: [],
      duration: 150,
    };
  }

  async getStatus(scope: any): Promise<any> {
    return {
      unknownCount: 5,
      readyCount: 5,
      pendingCount: 0,
      maxPerRun: 100,
    };
  }

  getReconcileCount(): number {
    return this.reconcileCount;
  }
}

/**
 * FP-012: Mock Polling Scheduler (for testing)
 */
export class MockPollingScheduler {
  private isRunning = false;
  private startTime: Date | null = null;

  start(): void {
    this.isRunning = true;
    this.startTime = new Date();
  }

  stop(): void {
    this.isRunning = false;
  }

  isActive(): boolean {
    return this.isRunning;
  }

  getMetrics(): any {
    return {
      isRunning: this.isRunning,
      pollCount: 0,
      reconcileCount: 0,
      lastPollTime: null,
      lastReconcileTime: null,
    };
  }
}
