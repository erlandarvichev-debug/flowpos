/**
 * FP-011 Phase 2: Real ESF Gateway Tests
 * Tests SOAP integration + mock gateway
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import {
  RealEsfGateway,
  MockEsfGateway,
  type EsfDocument,
  type SOAPClientConfig,
} from './gateway.real.ts';

describe('FP-011: Mock ESF Gateway', () => {
  let gateway: MockEsfGateway;
  let testDoc: EsfDocument;

  beforeEach(() => {
    gateway = new MockEsfGateway();

    testDoc = {
      id: 'doc-001',
      xml: '<invoice number="INV-001"/>',
      signature: 'base64-signature-here',
      invoiceNumber: 'INV-001',
      invoiceDate: '2026-10-29',
    };
  });

  it('mock gateway sends document and returns externalId', async () => {
    const result = await gateway.send(testDoc);

    assert.equal(result.state, 'REGISTERED');
    assert(result.externalId);
    assert(result.externalId?.startsWith('mock-doc-'));

    console.log(`✓ Mock send: document registered as ${result.externalId}`);
  });

  it('mock gateway lookup returns sent document', async () => {
    const sent = await gateway.send(testDoc);
    const lookup = await gateway.lookup(sent.externalId!);

    assert.equal(lookup.state, 'REGISTERED');
    assert.equal(lookup.externalId, sent.externalId);

    console.log('✓ Mock lookup: sent document found');
  });

  it('mock gateway returns UNKNOWN for unfound document', async () => {
    const result = await gateway.lookup('nonexistent-id');

    assert.equal(result.state, 'UNKNOWN');
    assert(result.error);
    assert.equal(result.error.code, 'NOT_FOUND');

    console.log('✓ Mock lookup: unfound document returns UNKNOWN');
  });

  it('mock gateway can simulate rejection', async () => {
    const sent = await gateway.send(testDoc);

    // Simulate rejection
    gateway.simulateRejection(sent.externalId!, 'Invalid invoice format');

    const lookup = await gateway.lookup(sent.externalId!);

    assert.equal(lookup.state, 'REJECTED');
    assert(lookup.error);
    assert.equal(lookup.error.code, 'REMOTE_REJECTED');

    console.log('✓ Mock gateway: simulated rejection');
  });

  it('mock gateway resets state', async () => {
    const sent1 = await gateway.send(testDoc);
    assert(sent1.externalId?.startsWith('mock-doc-1'));

    gateway.reset();

    const sent2 = await gateway.send(testDoc);
    assert(sent2.externalId?.startsWith('mock-doc-1')); // Counter reset

    console.log('✓ Mock gateway: reset clears state');
  });

  it('mock gateway handles multiple documents', async () => {
    const doc1 = await gateway.send(testDoc);
    const doc2 = await gateway.send({
      ...testDoc,
      id: 'doc-002',
      invoiceNumber: 'INV-002',
    });

    assert.notEqual(doc1.externalId, doc2.externalId);

    const lookup1 = await gateway.lookup(doc1.externalId!);
    const lookup2 = await gateway.lookup(doc2.externalId!);

    assert.equal(lookup1.state, 'REGISTERED');
    assert.equal(lookup2.state, 'REGISTERED');

    console.log('✓ Mock gateway: handles multiple documents');
  });
});

describe('FP-011: Real ESF Gateway Configuration', () => {
  it('real gateway requires SOAP endpoint', () => {
    const config: SOAPClientConfig = {
      wsdlUrl: 'https://es.lk.kz/esfgateway/',
      credentials: {
        login: 'test-login',
        password: 'test-password',
        organizationId: 'test-org-123',
      },
      timeout: 30_000,
      retryAttempts: 3,
    };

    const gateway = new RealEsfGateway(config);
    assert(gateway);

    console.log('✓ Real gateway: instantiated with config');
  });

  it('real gateway test URL points to test environment', () => {
    const testConfig: SOAPClientConfig = {
      wsdlUrl: 'https://test-es.lk.kz/esfgateway/',
      credentials: {
        login: 'test-user',
        password: 'test-pass',
        organizationId: 'test-org',
      },
    };

    const gateway = new RealEsfGateway(testConfig);
    assert(gateway);
    console.log('✓ Real gateway: test environment URL accepted');
  });

  it('real gateway production URL requires credentials', () => {
    const prodConfig: SOAPClientConfig = {
      wsdlUrl: 'https://es.lk.kz/esfgateway/',
      credentials: {
        login: process.env.ESF_GATEWAY_LOGIN || 'prod-user',
        password: process.env.ESF_GATEWAY_PASSWORD || 'prod-pass',
        organizationId: process.env.ESF_GATEWAY_ORG_ID || 'prod-org',
      },
    };

    const gateway = new RealEsfGateway(prodConfig);
    assert(gateway);
    console.log('✓ Real gateway: production config accepted');
  });
});

describe('FP-011: Gateway Response Mapping', () => {
  let mock: MockEsfGateway;

  beforeEach(() => {
    mock = new MockEsfGateway();
  });

  it('REGISTERED state maps correctly', async () => {
    const doc: EsfDocument = {
      id: 'test-1',
      xml: '<invoice/>',
      signature: 'sig-1',
      invoiceNumber: 'INV-1',
      invoiceDate: '2026-10-29',
    };

    const result = await mock.send(doc);
    assert.equal(result.state, 'REGISTERED');
    assert(result.externalId);

    console.log('✓ Response: REGISTERED state correct');
  });

  it('REJECTED state includes error', async () => {
    const externalId = 'test-doc-id';
    mock.simulateRejection(externalId, 'Invalid seller');

    const result = await mock.lookup(externalId);
    assert.equal(result.state, 'REJECTED');
    assert(result.error);
    assert.equal(result.error.code, 'REMOTE_REJECTED');
    assert(result.error.message.includes('Invalid seller'));

    console.log('✓ Response: REJECTED with error code');
  });

  it('UNKNOWN state for unfound documents', async () => {
    const result = await mock.lookup('missing-id');
    assert.equal(result.state, 'UNKNOWN');
    assert(result.error);

    console.log('✓ Response: UNKNOWN for missing document');
  });
});

describe('FP-011: Gateway Error Handling', () => {
  let gateway: RealEsfGateway;

  beforeEach(() => {
    // Point to unavailable endpoint (will fail)
    const config: SOAPClientConfig = {
      wsdlUrl: 'http://localhost:1', // Invalid port
      credentials: {
        login: 'test',
        password: 'test',
        organizationId: 'test-org',
      },
      timeout: 1000, // short timeout
      retryAttempts: 1,
    };

    gateway = new RealEsfGateway(config);
  });

  it('real gateway send handles connection errors', async () => {
    const doc: EsfDocument = {
      id: 'test-1',
      xml: '<invoice/>',
      signature: 'sig-1',
      invoiceNumber: 'INV-1',
      invoiceDate: '2026-10-29',
    };

    const result = await gateway.send(doc);

    // Should return UNKNOWN state with error
    assert.equal(result.state, 'UNKNOWN');
    assert(result.error);
    assert(result.error.code === 'GATEWAY_ERROR');

    console.log('✓ Error handling: connection error returns UNKNOWN');
  });

  it('real gateway lookup handles connection errors', async () => {
    const result = await gateway.lookup('any-id');

    assert.equal(result.state, 'UNKNOWN');
    assert(result.error);

    console.log('✓ Error handling: lookup error returns UNKNOWN');
  });
});
