import type { DatabaseSync } from 'node:sqlite';

/** Local synthetic schema only. Migration is atomic and serialized across connections. */
export function migrateLocal(db: DatabaseSync) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
    if (version > 2) throw new Error('LOCAL_SCHEMA_TOO_NEW');
    if (version < 2) {
      db.exec(`ALTER TABLE documents ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK(version>0);
        ALTER TABLE documents ADD COLUMN schemaVersion TEXT NOT NULL DEFAULT 'synthetic-v1';
        ALTER TABLE documents ADD COLUMN leaseToken TEXT;
        ALTER TABLE documents ADD COLUMN leaseUntil INTEGER;
        UPDATE documents SET schemaVersion='legacy-unrecorded' WHERE direction='IN';
        ALTER TABLE audit ADD COLUMN actorId TEXT NOT NULL DEFAULT 'system-fixture';
        CREATE UNIQUE INDEX scoped_document_id ON documents(tenantId,orgId,id);
        ALTER TABLE approvals RENAME TO approvals_v1;
        CREATE TABLE approvals (documentId TEXT PRIMARY KEY, tenantId TEXT NOT NULL, orgId TEXT NOT NULL,
          hash TEXT NOT NULL, expiresAt INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0 CHECK(consumed IN (0,1)),
          documentVersion INTEGER NOT NULL, approvedBy TEXT NOT NULL,
          FOREIGN KEY(tenantId,orgId,documentId) REFERENCES documents(tenantId,orgId,id));
        INSERT INTO approvals SELECT a.documentId,d.tenantId,d.orgId,a.hash,a.expiresAt,a.consumed,d.version,'legacy-fixture'
          FROM approvals_v1 a JOIN documents d ON d.id=a.documentId;
        DROP TABLE approvals_v1;
        ALTER TABLE jobs RENAME TO jobs_v1;
        CREATE TABLE jobs (documentId TEXT PRIMARY KEY, tenantId TEXT NOT NULL, orgId TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 1),
          FOREIGN KEY(tenantId,orgId,documentId) REFERENCES documents(tenantId,orgId,id));
        INSERT INTO jobs SELECT j.documentId,d.tenantId,d.orgId,j.attempts FROM jobs_v1 j JOIN documents d ON d.id=j.documentId;
        DROP TABLE jobs_v1;
        PRAGMA user_version=2;`);
    }
    db.exec('COMMIT');
  } catch(error) { db.exec('ROLLBACK'); throw error; }
}
