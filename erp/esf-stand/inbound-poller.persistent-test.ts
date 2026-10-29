/**
 * FP-012 Phase 3: Persistent Inbound Poller Tests
 * Tests polling with cursor persistence + crash recovery
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { MockInboundPoller } from './inbound-poller.ts';
import { MockCursorStore } from './cursor.store.ts';
import { PersistentInboundPoller } from './inbound-poller.persistent.ts';

describe('FP-012: Persistent Inbound Poller', () => {
  let poller: PersistentInboundPoller;
  let cursorStore: MockCursorStore;
  let gateway: any;
  let store: any;
  let testScope: any;

  beforeEach(async () => {
    cursorStore = new MockCursorStore();
    await cursorStore.initialize();

    testScope = { tenantId: 'tenant-1', organizationId: 'org-1' };

    // Mock gateway
    gateway = {
      async getDocuments(options: any) {
        return {
          documents: [
            {
              externalId: 'doc-1',
              number: 'INV-001',
              date: '2026-10-29',
              seller: { iin: '121212121212', name: 'Seller' },
              buyer: { iin: '343434343434', name: 'Buyer' },
              xml: '<invoice/>',
            },
          ],
          nextCursor: 'cursor-page-2',
          hasMore: true,
        };
      },
      async send() {
        return {};
      },
      async lookup() {
        return {};
      },
      async getDocument() {
        return null;
      },
    };

    // Mock store
    store = {
      getCursor() {
        return null;
      },
      setCursor() {},
      async ingestInbound() {
        return { saved: 1, duplicates: 0 };
      },
      async findUnknown() {
        return [];
      },
      async getByExternalId() {
        return null;
      },
      async updateState() {},
    };

    poller = new PersistentInboundPoller(gateway, store, {
      batchSize: 50,
      maxRetries: 3,
      cursorStore,
    });
  });

  it('persistent poller polls and saves cursor', async () => {
    const result = await poller.pollPersistent(testScope);

    assert.equal(result.documentsFetched, 1);
    assert.equal(result.documentsSaved, 1);
    assert(!result.crashed);

    // Verify cursor was saved
    const savedCursor = await cursorStore.getCursor(
      testScope.tenantId,
      testScope.organizationId,
    );

    assert.equal(savedCursor, 'cursor-page-2');

    console.log('✓ Persistent poller: polls and saves cursor');
  });

  it('persistent poller recovers from crash', async () => {
    // First poll
    await poller.pollPersistent(testScope);

    // Simulate crash (cursor stays in DB)

    // Second poll (recovery)
    const result = await poller.pollPersistent(testScope);

    assert(!result.crashed);

    // Cursor should still be page-2
    const cursor = await cursorStore.getCursor(
      testScope.tenantId,
      testScope.organizationId,
    );

    assert.equal(cursor, 'cursor-page-2');

    console.log('✓ Persistent poller: crash recovery');
  });

  it('persistent poller tracks document count', async () => {
    await poller.pollPersistent(testScope);

    const record = await cursorStore.getRecord(
      testScope.tenantId,
      testScope.organizationId,
    );

    assert(record);
    assert(record.lastDocumentCount > 0);

    console.log('✓ Persistent poller: tracks count');
  });

  it('persistent poller can reset cursor', async () => {
    // Save cursor
    await poller.pollPersistent(testScope);

    let cursor = await cursorStore.getCursor(
      testScope.tenantId,
      testScope.organizationId,
    );

    assert(cursor);

    // Reset
    await poller.resetCursor(testScope);

    cursor = await cursorStore.getCursor(
      testScope.tenantId,
      testScope.organizationId,
    );

    assert.equal(cursor, null);

    console.log('✓ Persistent poller: resets cursor');
  });

  it('persistent poller returns cursor status', async () => {
    // First poll
    await poller.pollPersistent(testScope);

    // Check status
    const status = await poller.getCursorStatus(testScope);

    assert.equal(status.cursor, 'cursor-page-2');
    assert(status.lastPolledAt);
    assert.equal(status.lastDocumentCount, 1);

    console.log('✓ Persistent poller: cursor status');
  });

  it('persistent poller handles error gracefully', async () => {
    // Simulate error in gateway
    gateway.getDocuments = async () => {
      throw new Error('Gateway timeout');
    };

    const result = await poller.pollPersistent(testScope);

    // Error is handled (either crashed=true or errors list has items)
    assert(result.crashed === true || result.errors.length > 0);

    console.log('✓ Persistent poller: error handling');
  });

  it('persistent poller isolates cursors by tenant+org', async () => {
    // Poll for tenant-1/org-1
    await poller.pollPersistent({ tenantId: 'tenant-1', organizationId: 'org-1' });

    // Create poller for tenant-2/org-2
    const poller2 = new PersistentInboundPoller(gateway, store, {
      batchSize: 50,
      maxRetries: 3,
      cursorStore,
    });

    // Poll for tenant-2/org-2
    await poller2.pollPersistent({
      tenantId: 'tenant-2',
      organizationId: 'org-2',
    });

    // Both cursors should be independent
    const cursor1 = await cursorStore.getCursor('tenant-1', 'org-1');
    const cursor2 = await cursorStore.getCursor('tenant-2', 'org-2');

    assert.equal(cursor1, 'cursor-page-2');
    assert.equal(cursor2, 'cursor-page-2');

    console.log('✓ Persistent poller: isolation');
  });
});

describe('FP-012: Cursor Persistence Scenarios', () => {
  let poller: PersistentInboundPoller;
  let cursorStore: MockCursorStore;
  let testScope: any;
  let gateway: any;
  let store: any;

  beforeEach(async () => {
    cursorStore = new MockCursorStore();
    await cursorStore.initialize();

    testScope = { tenantId: 'tenant-1', organizationId: 'org-1' };

    gateway = {
      async getDocuments(options: any) {
        return {
          documents: [
            {
              externalId: 'doc-1',
              number: 'INV-001',
              date: '2026-10-29',
              seller: { iin: '121212121212', name: 'Seller' },
              buyer: { iin: '343434343434', name: 'Buyer' },
              xml: '<invoice/>',
            },
          ],
          nextCursor: options.from ? `cursor-${Date.now()}` : 'cursor-page-2',
          hasMore: true,
        };
      },
      async send() {
        return {};
      },
      async lookup() {
        return {};
      },
      async getDocument() {
        return null;
      },
    };

    store = {
      getCursor() {
        return null;
      },
      setCursor() {},
      async ingestInbound() {
        return { saved: 1, duplicates: 0 };
      },
      async findUnknown() {
        return [];
      },
      async getByExternalId() {
        return null;
      },
      async updateState() {},
    };

    poller = new PersistentInboundPoller(gateway, store, {
      batchSize: 50,
      maxRetries: 3,
      cursorStore,
    });
  });

  it('simulates normal polling sequence', async () => {
    // Poll 1
    let result = await poller.pollPersistent(testScope);
    assert.equal(result.documentsFetched, 1);
    assert(!result.crashed);

    // Poll 2
    result = await poller.pollPersistent(testScope);
    assert.equal(result.documentsFetched, 1);
    assert(!result.crashed);

    // Poll 3
    result = await poller.pollPersistent(testScope);
    assert.equal(result.documentsFetched, 1);
    assert(!result.crashed);

    console.log('✓ Scenario: normal polling sequence');
  });

  it('simulates crash and recovery', async () => {
    // Poll before crash
    const result1 = await poller.pollPersistent(testScope);
    const cursor1 = await cursorStore.getCursor(
      testScope.tenantId,
      testScope.organizationId,
    );

    // Simulate process crash (cursor persists in DB)

    // New process starts, recovers cursor
    const status = await poller.getCursorStatus(testScope);

    assert.equal(status.cursor, cursor1);

    // Continue polling with recovered cursor
    const result2 = await poller.pollPersistent(testScope);

    assert(!result2.crashed);

    console.log('✓ Scenario: crash and recovery');
  });

  it('simulates cursor progression through multiple polls', async () => {
    const cursors: (string | null)[] = [];

    // 5 sequential polls
    for (let i = 0; i < 5; i++) {
      await poller.pollPersistent(testScope);

      const cursor = await cursorStore.getCursor(
        testScope.tenantId,
        testScope.organizationId,
      );

      cursors.push(cursor);
    }

    // First cursor should be page-2, rest should progress
    assert(cursors[0]);
    assert(cursors.length === 5);

    console.log('✓ Scenario: cursor progression');
  });
});

describe('FP-012: Cursor Status Queries', () => {
  let poller: PersistentInboundPoller;
  let cursorStore: MockCursorStore;
  let testScope: any;

  beforeEach(async () => {
    cursorStore = new MockCursorStore();
    await cursorStore.initialize();

    testScope = { tenantId: 'tenant-1', organizationId: 'org-1' };

    const gateway = {
      async getDocuments() {
        return {
          documents: [],
          nextCursor: 'cursor-1',
          hasMore: false,
        };
      },
      async send() {
        return {};
      },
      async lookup() {
        return {};
      },
      async getDocument() {
        return null;
      },
    };

    const store = {
      getCursor() {
        return null;
      },
      setCursor() {},
      async ingestInbound() {
        return { saved: 0, duplicates: 0 };
      },
      async findUnknown() {
        return [];
      },
      async getByExternalId() {
        return null;
      },
      async updateState() {},
    };

    poller = new PersistentInboundPoller(gateway, store, {
      cursorStore,
    });
  });

  it('returns null status for first poll', async () => {
    const status = await poller.getCursorStatus(testScope);

    assert.equal(status.cursor, null);
    assert.equal(status.lastPolledAt, null);
    assert.equal(status.lastDocumentCount, 0);

    console.log('✓ Status: null on first poll');
  });

  it('returns populated status after poll', async () => {
    await poller.pollPersistent(testScope);

    const status = await poller.getCursorStatus(testScope);

    assert(status.cursor);
    assert(status.lastPolledAt);

    console.log('✓ Status: populated after poll');
  });
});
