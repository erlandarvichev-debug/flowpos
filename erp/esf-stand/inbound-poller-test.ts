/**
 * FP-012 Phase 1: Inbound Poller Tests
 * Tests polling, cursor management, reconciliation
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import {
  InboundPoller,
  MockInboundPoller,
  type InboundDocument,
  type GatewayWithInbound,
  type StoreWithCursor,
} from './inbound-poller.ts';

describe('FP-012: Mock Inbound Poller', () => {
  let poller: MockInboundPoller;
  let testScope: { tenantId: string; orgId: string };

  beforeEach(() => {
    poller = new MockInboundPoller();
    testScope = { tenantId: 'tenant-1', orgId: 'org-1' };
  });

  it('mock poller returns empty batch initially', async () => {
    const result = await poller.poll(testScope);

    assert.equal(result.documentsFetched, 0);
    assert.equal(result.documentsSaved, 0);
    assert.equal(result.errors.length, 0);

    console.log('✓ Mock poller: returns empty batch');
  });

  it('mock poller returns added mock documents', async () => {
    const mockDoc: InboundDocument = {
      externalId: 'doc-001',
      number: 'INV-001',
      date: '2026-10-29',
      seller: { iin: '121212121212', name: 'Seller' },
      buyer: { iin: '343434343434', name: 'Buyer' },
      xml: '<invoice/>',
    };

    poller.addMockDocument(mockDoc);

    const result = await poller.poll(testScope);

    assert.equal(result.documentsFetched, 1);
    assert.equal(result.documentsSaved, 1);
    assert(result.nextCursor);

    console.log('✓ Mock poller: returns added documents');
  });

  it('mock poller reconciles UNKNOWN documents', async () => {
    const result = await poller.reconcile(testScope, 'doc-001');

    assert.equal(result.oldState, 'UNKNOWN');
    assert.equal(result.newState, 'REGISTERED');
    assert(result.reconciled === true);

    console.log('✓ Mock poller: reconciles UNKNOWN');
  });

  it('mock poller reconciles batch of unknown documents', async () => {
    const result = await poller.reconcileUnknown(testScope, 300);

    assert.equal(result.reconciled, 1);
    assert.equal(result.failed, 0);
    assert.equal(result.errors.length, 0);

    console.log('✓ Mock poller: batch reconciliation');
  });
});

describe('FP-012: Real Inbound Poller', () => {
  let poller: InboundPoller;
  let mockGateway: GatewayWithInbound;
  let mockStore: StoreWithCursor;
  let testScope: any;

  beforeEach(() => {
    testScope = { tenantId: 'tenant-1', orgId: 'org-1' };

    // Mock gateway
    mockGateway = {
      async getDocuments(options: { from?: string; limit?: number }) {
        return {
          documents: [
            {
              externalId: 'gw-doc-001',
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
        return { state: 'REGISTERED' };
      },

      async lookup() {
        return { state: 'REGISTERED' };
      },

      async getDocument() {
        return null;
      },
    };

    // Mock store
    mockStore = {
      getCursor(): string | null {
        return null;
      },

      async setCursor() {
        // no-op
      },

      async ingestInbound() {
        return { saved: 1, duplicates: 0 };
      },

      async findUnknown() {
        return [];
      },

      async getByExternalId() {
        return null;
      },

      async updateState() {
        // no-op
      },
    };

    poller = new InboundPoller(mockGateway, mockStore, {
      batchSize: 50,
      maxRetries: 3,
    });
  });

  it('poller fetches documents from gateway', async () => {
    const result = await poller.poll(testScope);

    assert.equal(result.documentsFetched, 1);
    assert.equal(result.documentsSaved, 1);
    assert(result.nextCursor === 'cursor-page-2');

    console.log('✓ Real poller: fetches documents');
  });

  it('poller sets next cursor after poll', async () => {
    const result = await poller.poll(testScope);

    assert(result.nextCursor);
    assert(result.nextCursor.includes('cursor'));

    console.log('✓ Real poller: sets next cursor');
  });

  it('poller reports duplicates', async () => {
    // Mock store returns duplicates
    mockStore.ingestInbound = async () => ({
      saved: 5,
      duplicates: 5,
    });

    const result = await poller.poll(testScope);

    assert.equal(result.duplicates, 5);
    assert.equal(result.documentsSaved, 5);

    console.log('✓ Real poller: reports duplicates');
  });

  it('poller handles gateway timeout with retry', async () => {
    let attempts = 0;

    mockGateway.getDocuments = async () => {
      attempts++;

      if (attempts < 2) {
        throw new Error('Timeout');
      }

      return {
        documents: [],
        hasMore: false,
      };
    };

    const result = await poller.poll(testScope);

    assert.equal(attempts, 2);
    assert.equal(result.documentsFetched, 0);

    console.log('✓ Real poller: retries on timeout');
  });

  it('poller reconciles UNKNOWN document', async () => {
    const mockDoc = {
      id: 'doc-123',
      state: 'UNKNOWN',
      externalId: 'gw-doc-456',
    };

    mockStore.getByExternalId = async () => mockDoc;

    mockGateway.lookup = async () => ({
      state: 'REGISTERED',
    });

    const result = await poller.reconcile(testScope, 'gw-doc-456');

    assert.equal(result.oldState, 'UNKNOWN');
    assert.equal(result.newState, 'REGISTERED');
    assert(result.reconciled === true);

    console.log('✓ Real poller: reconciles UNKNOWN');
  });

  it('poller skips reconciliation for terminal state', async () => {
    const mockDoc = {
      id: 'doc-123',
      state: 'REGISTERED', // already terminal
      externalId: 'gw-doc-456',
    };

    mockStore.getByExternalId = async () => mockDoc;

    const result = await poller.reconcile(testScope, 'gw-doc-456');

    assert.equal(result.oldState, 'REGISTERED');
    assert(result.reconciled === false);

    console.log('✓ Real poller: skips terminal states');
  });

  it('poller batch reconciles old UNKNOWN documents', async () => {
    const unknownDocs = [
      { id: '1', state: 'UNKNOWN', externalId: 'doc-1' },
      { id: '2', state: 'UNKNOWN', externalId: 'doc-2' },
    ];

    mockStore.findUnknown = async () => unknownDocs;

    // Mock getByExternalId to return documents
    mockStore.getByExternalId = async (scope: any, externalId: string) => {
      return unknownDocs.find((d) => d.externalId === externalId);
    };

    mockGateway.lookup = async (externalId: string) => ({
      state: externalId === 'doc-1' ? 'REGISTERED' : 'REJECTED',
    });

    const result = await poller.reconcileUnknown(testScope, 300);

    assert.equal(result.reconciled, 2);
    assert.equal(result.failed, 0);

    console.log('✓ Real poller: batch reconciles old UNKNOWN');
  });

  it('poller handles partial reconciliation failure', async () => {
    const unknownDocs = [
      { id: '1', state: 'UNKNOWN', externalId: 'doc-1' },
      { id: '2', state: 'UNKNOWN', externalId: 'doc-2' },
    ];

    mockStore.findUnknown = async () => unknownDocs;

    // Mock getByExternalId to return documents
    mockStore.getByExternalId = async (scope: any, externalId: string) => {
      return unknownDocs.find((d) => d.externalId === externalId);
    };

    let callCount = 0;
    mockGateway.lookup = async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error('Gateway error');
      }
      return { state: 'REGISTERED' };
    };

    const result = await poller.reconcileUnknown(testScope, 300);

    assert.equal(result.reconciled, 1);
    assert.equal(result.failed, 1);
    assert(result.errors.length > 0);

    console.log('✓ Real poller: handles partial failure');
  });
});

describe('FP-012: Cursor Management', () => {
  let mockStore: StoreWithCursor;

  beforeEach(() => {
    let cursor = '';

    mockStore = {
      getCursor() {
        return cursor || null;
      },

      async setCursor(scope: any, newCursor: string) {
        cursor = newCursor;
      },

      async ingestInbound() {
        return { saved: 1, duplicates: 0 };
      },

      async findUnknown() {
        return [];
      },

      async getByExternalId() {
        return null;
      },

      async updateState() {
        // no-op
      },
    };
  });

  it('cursor starts null', async () => {
    const cursor = mockStore.getCursor({});
    assert.equal(cursor, null);

    console.log('✓ Cursor: starts null');
  });

  it('cursor updates after poll', async () => {
    await mockStore.setCursor({}, 'new-cursor-value');
    const cursor = mockStore.getCursor({});

    assert.equal(cursor, 'new-cursor-value');

    console.log('✓ Cursor: updates correctly');
  });

  it('cursor persists across polls', async () => {
    await mockStore.setCursor({}, 'cursor-1');
    assert.equal(mockStore.getCursor({}), 'cursor-1');

    await mockStore.setCursor({}, 'cursor-2');
    assert.equal(mockStore.getCursor({}), 'cursor-2');

    console.log('✓ Cursor: persists across updates');
  });
});

describe('FP-012: Error Handling', () => {
  let poller: InboundPoller;
  let mockGateway: GatewayWithInbound;
  let mockStore: StoreWithCursor;
  let testScope: any;

  beforeEach(() => {
    testScope = { tenantId: 'tenant-1', orgId: 'org-1' };

    mockGateway = {
      async getDocuments() {
        throw new Error('Gateway unavailable');
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

    mockStore = {
      getCursor() {
        return null;
      },
      async setCursor() {},
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

    poller = new InboundPoller(mockGateway, mockStore, {
      batchSize: 50,
      maxRetries: 2,
    });
  });

  it('poller handles gateway failure', async () => {
    const result = await poller.poll(testScope);

    assert.equal(result.documentsFetched, 0);
    assert(result.errors.length > 0);

    console.log('✓ Error handling: gateway failure');
  });

  it('poller handles missing document in reconciliation', async () => {
    try {
      await poller.reconcile(testScope, 'nonexistent-doc');
      assert.fail('Should throw error');
    } catch (error: any) {
      assert(error.message.includes('not found'));
    }

    console.log('✓ Error handling: missing document');
  });
});
