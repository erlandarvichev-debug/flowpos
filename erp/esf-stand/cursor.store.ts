/**
 * FP-012 Phase 3: Cursor Persistence
 * Stores polling cursor in PostgreSQL for crash recovery
 *
 * Flow:
 * 1. Start polling (get cursor from DB)
 * 2. Poll documents (batch from gateway)
 * 3. Ingest documents (atomic with cursor update)
 * 4. Crash happens → restart
 * 5. Get cursor from DB → continue from where we left off
 *
 * Database Schema:
 * ┌─────────────────────────────────┐
 * │ esf_poll_cursor                 │
 * ├─────────────────────────────────┤
 * │ id (UUID primary key)           │
 * │ tenant_id (UUID)                │
 * │ organization_id (UUID)          │
 * │ cursor (TEXT nullable)          │
 * │ last_polled_at (TIMESTAMP)      │
 * │ last_document_count (INT)       │
 * │ created_at (TIMESTAMP)          │
 * │ updated_at (TIMESTAMP)          │
 * │ UNIQUE(tenant_id, organization) │
 * └─────────────────────────────────┘
 */

export interface CursorRecord {
  id: string; // UUID
  tenantId: string;
  organizationId: string;
  cursor: string | null; // null = first poll
  lastPolledAt: Date | null;
  lastDocumentCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CursorStoreConfig {
  // Database connection pool
  pool?: any; // pg.Pool

  // Table name (default: esf_poll_cursor)
  tableName?: string;

  // Whether to auto-create table
  autoMigrate?: boolean;
}

/**
 * FP-012: Cursor Store (PostgreSQL)
 * Persistent cursor storage for crash recovery
 */
export class CursorStore {
  private pool: any;
  private tableName: string;
  private autoMigrate: boolean;

  constructor(config: CursorStoreConfig) {
    this.pool = config.pool;
    this.tableName = config.tableName || 'esf_poll_cursor';
    this.autoMigrate = config.autoMigrate !== false;

    if (!this.pool) {
      throw new Error('CursorStore requires a database pool');
    }
  }

  /**
   * FP-012: Initialize schema (create table if not exists)
   */
  async initialize(): Promise<void> {
    if (!this.autoMigrate) {
      return;
    }

    const createTableSQL = `
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
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
        ON ${this.tableName}(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_esf_cursor_org
        ON ${this.tableName}(tenant_id, organization_id);
    `;

    try {
      await this.pool.query(createTableSQL);
      console.log(`Initialized ${this.tableName}`);
    } catch (error: any) {
      if (!error.message.includes('already exists')) {
        throw error;
      }
    }
  }

  /**
   * FP-012: Get cursor for tenant+org
   * Returns null if no record exists (first poll)
   */
  async getCursor(tenantId: string, organizationId: string): Promise<string | null> {
    const query = `
      SELECT cursor FROM ${this.tableName}
      WHERE tenant_id = $1 AND organization_id = $2
      LIMIT 1
    `;

    try {
      const result = await this.pool.query(query, [tenantId, organizationId]);

      if (result.rows.length === 0) {
        return null; // First poll
      }

      return result.rows[0].cursor;
    } catch (error: any) {
      console.error(`Failed to get cursor: ${error.message}`);
      return null; // Fallback to first poll on error
    }
  }

  /**
   * FP-012: Set cursor (atomically updates with timestamp)
   * Creates record if not exists, updates if exists
   */
  async setCursor(
    tenantId: string,
    organizationId: string,
    cursor: string | null,
    documentCount: number = 0,
  ): Promise<void> {
    const query = `
      INSERT INTO ${this.tableName}
      (tenant_id, organization_id, cursor, last_polled_at, last_document_count, updated_at)
      VALUES ($1, $2, $3, CURRENT_TIMESTAMP, $4, CURRENT_TIMESTAMP)
      ON CONFLICT (tenant_id, organization_id)
      DO UPDATE SET
        cursor = EXCLUDED.cursor,
        last_polled_at = EXCLUDED.last_polled_at,
        last_document_count = EXCLUDED.last_document_count,
        updated_at = CURRENT_TIMESTAMP
    `;

    try {
      await this.pool.query(query, [tenantId, organizationId, cursor, documentCount]);
    } catch (error: any) {
      throw new Error(`Failed to set cursor: ${error.message}`);
    }
  }

  /**
   * FP-012: Get full cursor record (for monitoring)
   */
  async getRecord(tenantId: string, organizationId: string): Promise<CursorRecord | null> {
    const query = `
      SELECT
        id,
        tenant_id,
        organization_id,
        cursor,
        last_polled_at,
        last_document_count,
        created_at,
        updated_at
      FROM ${this.tableName}
      WHERE tenant_id = $1 AND organization_id = $2
      LIMIT 1
    `;

    try {
      const result = await this.pool.query(query, [tenantId, organizationId]);

      if (result.rows.length === 0) {
        return null;
      }

      const row = result.rows[0];
      return {
        id: row.id,
        tenantId: row.tenant_id,
        organizationId: row.organization_id,
        cursor: row.cursor,
        lastPolledAt: row.last_polled_at,
        lastDocumentCount: row.last_document_count,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    } catch (error: any) {
      console.error(`Failed to get record: ${error.message}`);
      return null;
    }
  }

  /**
   * FP-012: Delete cursor (for testing/reset)
   */
  async deleteCursor(tenantId: string, organizationId: string): Promise<void> {
    const query = `
      DELETE FROM ${this.tableName}
      WHERE tenant_id = $1 AND organization_id = $2
    `;

    try {
      await this.pool.query(query, [tenantId, organizationId]);
    } catch (error: any) {
      throw new Error(`Failed to delete cursor: ${error.message}`);
    }
  }

  /**
   * FP-012: Get all cursors for tenant (monitoring)
   */
  async getAllForTenant(tenantId: string): Promise<CursorRecord[]> {
    const query = `
      SELECT
        id,
        tenant_id,
        organization_id,
        cursor,
        last_polled_at,
        last_document_count,
        created_at,
        updated_at
      FROM ${this.tableName}
      WHERE tenant_id = $1
      ORDER BY updated_at DESC
    `;

    try {
      const result = await this.pool.query(query, [tenantId]);

      return result.rows.map((row: any) => ({
        id: row.id,
        tenantId: row.tenant_id,
        organizationId: row.organization_id,
        cursor: row.cursor,
        lastPolledAt: row.last_polled_at,
        lastDocumentCount: row.last_document_count,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    } catch (error: any) {
      console.error(`Failed to get cursors for tenant: ${error.message}`);
      return [];
    }
  }

  /**
   * FP-012: Clear all cursors (for testing)
   */
  async clear(): Promise<void> {
    const query = `TRUNCATE TABLE ${this.tableName}`;

    try {
      await this.pool.query(query);
    } catch (error: any) {
      throw new Error(`Failed to clear cursors: ${error.message}`);
    }
  }
}

/**
 * FP-012: Mock Cursor Store (for testing without DB)
 */
export class MockCursorStore {
  private cursors: Map<string, CursorRecord> = new Map();
  private counter = 0;

  async initialize(): Promise<void> {
    // no-op
  }

  async getCursor(tenantId: string, organizationId: string): Promise<string | null> {
    const key = `${tenantId}:${organizationId}`;
    const record = this.cursors.get(key);
    return record?.cursor || null;
  }

  async setCursor(
    tenantId: string,
    organizationId: string,
    cursor: string | null,
    documentCount: number = 0,
  ): Promise<void> {
    const key = `${tenantId}:${organizationId}`;
    const now = new Date();

    const record: CursorRecord = {
      id: `mock-${++this.counter}`,
      tenantId,
      organizationId,
      cursor,
      lastPolledAt: now,
      lastDocumentCount: documentCount,
      createdAt: this.cursors.has(key)
        ? this.cursors.get(key)!.createdAt
        : now,
      updatedAt: now,
    };

    this.cursors.set(key, record);
  }

  async getRecord(tenantId: string, organizationId: string): Promise<CursorRecord | null> {
    const key = `${tenantId}:${organizationId}`;
    return this.cursors.get(key) || null;
  }

  async deleteCursor(tenantId: string, organizationId: string): Promise<void> {
    const key = `${tenantId}:${organizationId}`;
    this.cursors.delete(key);
  }

  async getAllForTenant(tenantId: string): Promise<CursorRecord[]> {
    return Array.from(this.cursors.values()).filter(
      (r) => r.tenantId === tenantId,
    );
  }

  async clear(): Promise<void> {
    this.cursors.clear();
  }
}
