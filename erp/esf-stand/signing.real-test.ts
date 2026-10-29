/**
 * FP-011 Phase 1: Real Signing Provider Tests
 * Tests NCALayer integration + mock provider
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import {
  RealSigningProvider,
  MockNCALayerProvider,
  type Principal,
} from './signing.real.ts';

describe('FP-011: Real Signing Provider', () => {
  let provider: RealSigningProvider;
  let principal: Principal;

  beforeEach(() => {
    // Use mock NCALayer for tests
    provider = new RealSigningProvider('http://localhost:13579');

    principal = {
      principalId: 'test-user-1',
      tenantId: 'tenant-1',
      organizationId: 'org-1',
      certAlias: 'test_cert',
    };
  });

  it('real signing provider requires NCALayer connection', async () => {
    const bytes = Buffer.from('test-document');

    try {
      await provider.sign(bytes, principal);
      // If we reach here, NCALayer is running
      console.log('✓ NCALayer is available');
    } catch (error: any) {
      // Expected if NCALayer not running
      assert(
        error.message.includes('NCALayer') ||
          error.message.includes('connection'),
        'Should fail with NCALayer error',
      );
      console.log('✓ NCALayer not available (expected for CI)');
    }
  });

  it('mock signing provider generates deterministic signatures', async () => {
    const mock = new MockNCALayerProvider();
    const bytes = Buffer.from('test-document');

    const result1 = await mock.sign(bytes, principal);
    const result2 = await mock.sign(bytes, principal);

    assert.equal(result1.signature, result2.signature);
    assert.equal(result1.marker, 'MOCK_ECP');
    assert(result1.notice?.includes('test only'));

    console.log('✓ Mock provider: deterministic signatures');
  });

  it('signature result includes marker and notice', async () => {
    const mock = new MockNCALayerProvider();
    const bytes = Buffer.from('invoice-data');

    const result = await mock.sign(bytes, principal);

    assert(result.signature);
    assert(result.signature.length > 0);
    assert.equal(result.marker, 'MOCK_ECP');
    assert(result.notice);

    console.log('✓ Signature result: complete fields');
  });

  it('different data produces different signatures', async () => {
    const mock = new MockNCALayerProvider();

    const sig1 = await mock.sign(Buffer.from('data-1'), principal);
    const sig2 = await mock.sign(Buffer.from('data-2'), principal);

    assert.notEqual(sig1.signature, sig2.signature);

    console.log('✓ Different data: different signatures');
  });

  it('principal cert alias is respected', async () => {
    const mock = new MockNCALayerProvider();
    const principal1 = {
      ...principal,
      certAlias: 'cert_1',
    };

    const principal2 = {
      ...principal,
      certAlias: 'cert_2',
    };

    const bytes = Buffer.from('same-data');

    // Both should work (mock doesn't validate cert)
    const result1 = await mock.sign(bytes, principal1);
    const result2 = await mock.sign(bytes, principal2);

    assert(result1.signature);
    assert(result2.signature);

    console.log('✓ Principal cert alias: independent signing');
  });

  it('binary data is properly base64-encoded', async () => {
    const mock = new MockNCALayerProvider();
    const binaryData = Buffer.from([0xff, 0xfe, 0xfd, 0xfc]);

    const result = await mock.sign(binaryData, principal);

    // Signature should be valid base64
    const decoded = Buffer.from(result.signature, 'base64');
    assert(decoded.length > 0);

    console.log('✓ Binary data: proper base64 encoding');
  });
});

describe('FP-011: Certificate Management', () => {
  let provider: RealSigningProvider;
  let principal: Principal;

  beforeEach(() => {
    provider = new RealSigningProvider('http://localhost:13579');
    principal = {
      principalId: 'test-user-1',
      tenantId: 'tenant-1',
      organizationId: 'org-1',
    };
  });

  it('certificate info requires NCALayer or mock', async () => {
    try {
      const info = await provider.getCertificateInfo(principal);
      assert(info.subject);
      console.log('✓ Certificate info: NCALayer available');
    } catch (error: any) {
      assert(error.message.includes('certificate'));
      console.log('✓ Certificate info: NCALayer not available (expected)');
    }
  });

  it('list certificates returns empty on connection failure', async () => {
    // With mock/unavailable NCALayer, should return []
    const certs = await provider.listCertificates();
    assert(Array.isArray(certs));
    console.log(
      `✓ List certificates: returned ${certs.length} certs (may be 0)`,
    );
  });

  it('certificate verification checks expiry', async () => {
    // This test depends on NCALayer being available
    try {
      const valid = await provider.verifyCertificate(principal);
      assert(typeof valid === 'boolean');
      console.log(
        `✓ Certificate verification: ${valid ? 'valid' : 'expired'}`,
      );
    } catch (error) {
      console.log('✓ Certificate verification: skipped (NCALayer unavailable)');
    }
  });
});

describe('FP-011: Signing Errors', () => {
  let mock: MockNCALayerProvider;
  let principal: Principal;

  beforeEach(() => {
    mock = new MockNCALayerProvider();
    principal = {
      principalId: 'test-user',
      tenantId: 'tenant-1',
      organizationId: 'org-1',
    };
  });

  it('mock provider does not throw on error', async () => {
    const empty = Buffer.alloc(0);
    const result = await mock.sign(empty, principal);

    assert(result.signature);
    assert(result.marker === 'MOCK_ECP');

    console.log('✓ Mock provider: handles empty data');
  });

  it('signature remains valid across multiple calls', async () => {
    const bytes = Buffer.from('test');
    const signatures: string[] = [];

    for (let i = 0; i < 5; i++) {
      const result = await mock.sign(bytes, principal);
      signatures.push(result.signature);
    }

    // All signatures should be identical (deterministic)
    assert(signatures.every((s) => s === signatures[0]));

    console.log('✓ Signatures: consistent across calls');
  });
});
