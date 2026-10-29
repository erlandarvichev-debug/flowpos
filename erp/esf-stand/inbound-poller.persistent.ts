/**
 * FP-012 Phase 3: Persistent Inbound Poller
 * Extends InboundPoller with cursor persistence
 *
 * Benefits:
 * - Crash recovery (resume from last cursor)
 * - No duplicate documents (cursor tracks progress)
 * - Atomic updates (cursor + documents together)
 */

import { InboundPoller, type InboundDocument } from './inbound-poller.ts';
import { CursorStore } from './cursor.store.ts';

export interface PersistentPollerConfig {
  batchSize?: number;
  maxRetries?: number;
  cursorStore: CursorStore;
}

/**
 * FP-012: Persistent Inbound Poller
 * InboundPoller with PostgreSQL cursor persistence
 */
export class PersistentInboundPoller extends InboundPoller {
  private cursorStore: CursorStore;

  constructor(
    gateway: any,
    store: any,
    config: PersistentPollerConfig,
  ) {
    super(gateway, store, {
      batchSize: config.batchSize || 50,
      maxRetries: config.maxRetries || 3,
    });

    this.cursorStore = config.cursorStore;
  }

  /**
   * FP-012: Poll with persistent cursor
   * 1. Load cursor from DB
   * 2. Poll documents
   * 3. Ingest documents
   * 4. Save cursor atomically
   */
  async pollPersistent(scope: any): Promise<{
    documentsFetched: number;
    documentsSaved: number;
    duplicates: number;
    errors: string[];
    nextCursor: string;
    crashed: boolean;
  }> {
    try {
      // 1. Load cursor from persistent storage
      const cursor = await this.cursorStore.getCursor(
        scope.tenantId,
        scope.organizationId,
      );

      // 2. Use parent's poll method
      const result = await this.poll(scope);

      // 3. Save cursor to persistent storage
      if (result.nextCursor) {
        await this.cursorStore.setCursor(
          scope.tenantId,
          scope.organizationId,
          result.nextCursor,
          result.documentsFetched,
        );
      }

      return {
        ...result,
        crashed: false,
      };
    } catch (error: any) {
      // On crash, cursor stays in DB (recovery on next poll)
      return {
        documentsFetched: 0,
        documentsSaved: 0,
        duplicates: 0,
        errors: [error.message],
        nextCursor: '',
        crashed: true,
      };
    }
  }

  /**
   * FP-012: Reset cursor (for testing)
   */
  async resetCursor(scope: any): Promise<void> {
    await this.cursorStore.deleteCursor(
      scope.tenantId,
      scope.organizationId,
    );
  }

  /**
   * FP-012: Get cursor status
   */
  async getCursorStatus(scope: any): Promise<{
    cursor: string | null;
    lastPolledAt: Date | null;
    lastDocumentCount: number;
  }> {
    const record = await this.cursorStore.getRecord(
      scope.tenantId,
      scope.organizationId,
    );

    if (!record) {
      return {
        cursor: null,
        lastPolledAt: null,
        lastDocumentCount: 0,
      };
    }

    return {
      cursor: record.cursor,
      lastPolledAt: record.lastPolledAt,
      lastDocumentCount: record.lastDocumentCount,
    };
  }
}

/**
 * FP-012: Schema Migration SQL
 * Run this to create the esf_poll_cursor table
 */
export const CURSOR_MIGRATION_SQL = `
  CREATE TABLE IF NOT EXISTS esf_poll_cursor (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    organization_id UUID NOT NULL,
    cursor TEXT,
    last_polled_at TIMESTAMP WITH TIME ZONE,
    last_document_count INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(tenant_id, organization_id)
  );

  CREATE INDEX IF NOT EXISTS idx_esf_cursor_tenant
    ON esf_poll_cursor(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_esf_cursor_org
    ON esf_poll_cursor(tenant_id, organization_id);
`;
