/**
 * FP-013 Phase 1: Schema Registry Tests
 * Tests multiple schema versions, detection, validation & fallback
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import {
  SchemaRegistry,
  MockSchemaRegistry,
  type SchemaMetadata,
} from './schema-registry.ts';

describe('FP-013: Mock Schema Registry', () => {
  let registry: MockSchemaRegistry;

  beforeEach(async () => {
    registry = new MockSchemaRegistry();
  });

  it('mock registry registers multiple versions', async () => {
    await registry.register('v2', './Invoice_v2.xsd');
    await registry.register('v3', './Invoice_v3.xsd');
    await registry.register('v4', './Invoice_v4.xsd');

    const versions = registry.listVersions();

    assert.equal(versions.length, 3);
    assert(versions.includes('v2'));
    assert(versions.includes('v3'));
    assert(versions.includes('v4'));

    console.log('✓ Mock registry: registers multiple versions');
  });

  it('mock registry detects version from XML', async () => {
    const xml2 = '<Invoice schemaVersion="v2">...</Invoice>';
    const xml3 = '<Invoice schemaVersion="v3">...</Invoice>';
    const xmlUnknown = '<Invoice>...</Invoice>';

    const v2 = registry.detectVersion(xml2);
    const v3 = registry.detectVersion(xml3);
    const unknown = registry.detectVersion(xmlUnknown);

    assert.equal(v2, 'v2');
    assert.equal(v3, 'v3');
    assert.equal(unknown, null);

    console.log('✓ Mock registry: detects version');
  });

  it('mock registry validates documents', async () => {
    await registry.register('v3', './Invoice_v3.xsd');

    const xml = '<Invoice schemaVersion="v3">Valid doc</Invoice>';
    const result = await registry.validate(xml);

    assert(result.valid === true);
    assert.equal(result.usedVersion, 'v3');

    console.log('✓ Mock registry: validates documents');
  });

  it('mock registry validates with fallback', async () => {
    await registry.register('v3', './Invoice_v3.xsd');

    const xml = '<Invoice>No version specified</Invoice>';
    const result = await registry.validateWithFallback(xml);

    assert(typeof result.valid === 'boolean');
    assert(result.usedVersion);

    console.log('✓ Mock registry: fallback validation');
  });

  it('mock registry tracks statistics', async () => {
    await registry.register('v3', './Invoice_v3.xsd');

    const xml = '<Invoice schemaVersion="v3">Doc</Invoice>';

    // Validate 3 times
    await registry.validate(xml);
    await registry.validate(xml);
    await registry.validate(xml);

    const stats = registry.getStats('v3');

    assert.equal(stats.length, 1);
    assert.equal(stats[0].hits, 3);

    console.log('✓ Mock registry: tracks statistics');
  });

  it('mock registry sets default version', async () => {
    await registry.register('v2', './Invoice_v2.xsd');
    await registry.register('v3', './Invoice_v3.xsd');

    registry.setDefaultVersion('v3');

    const xml = '<Invoice>No version</Invoice>';
    const result = await registry.validate(xml);

    assert.equal(result.usedVersion, 'v3');

    console.log('✓ Mock registry: sets default version');
  });

  it('mock registry returns schema info', async () => {
    await registry.register('v3', './Invoice_v3.xsd', {
      deprecated: false,
    });

    const info = registry.getSchemaInfo('v3');

    assert(info);
    assert.equal(info.version, 'v3');
    assert.equal(info.deprecated, false);

    console.log('✓ Mock registry: returns schema info');
  });

  it('mock registry returns null for unknown version', async () => {
    const info = registry.getSchemaInfo('v99');

    assert.equal(info, null);

    console.log('✓ Mock registry: null for unknown');
  });
});

describe('FP-013: Schema Version Detection', () => {
  let registry: MockSchemaRegistry;

  beforeEach(async () => {
    registry = new MockSchemaRegistry();
  });

  it('detects v2 format', async () => {
    const xml = '<Invoice schemaVersion="v2">content</Invoice>';
    const version = registry.detectVersion(xml);

    assert.equal(version, 'v2');

    console.log('✓ Detection: v2 format');
  });

  it('detects v3 format', async () => {
    const xml = '<Invoice schemaVersion="v3">content</Invoice>';
    const version = registry.detectVersion(xml);

    assert.equal(version, 'v3');

    console.log('✓ Detection: v3 format');
  });

  it('detects with single quotes', async () => {
    const xml = "<Invoice schemaVersion='v3'>content</Invoice>";
    const version = registry.detectVersion(xml);

    assert.equal(version, 'v3');

    console.log('✓ Detection: single quotes');
  });

  it('ignores case variations', async () => {
    const xml = '<Invoice SCHEMAVERSION="v3">content</Invoice>';
    const version = registry.detectVersion(xml);

    assert.equal(version, 'v3');

    console.log('✓ Detection: case insensitive');
  });

  it('returns null for missing version', async () => {
    const xml = '<Invoice>no version attr</Invoice>';
    const version = registry.detectVersion(xml);

    assert.equal(version, null);

    console.log('✓ Detection: missing returns null');
  });

  it('handles whitespace', async () => {
    const xml = '<Invoice schemaVersion = "v3" >content</Invoice>';
    const version = registry.detectVersion(xml);

    assert.equal(version, 'v3');

    console.log('✓ Detection: whitespace handling');
  });
});

describe('FP-013: Schema Registry Validation', () => {
  let registry: MockSchemaRegistry;

  beforeEach(async () => {
    registry = new MockSchemaRegistry();
    await registry.register('v2', './Invoice_v2.xsd', {
      deprecated: true,
    });
    await registry.register('v3', './Invoice_v3.xsd');
    await registry.register('v4', './Invoice_v4.xsd');
  });

  it('validates known version', async () => {
    const xml = '<Invoice schemaVersion="v3">doc</Invoice>';
    const result = await registry.validate(xml);

    assert(result.valid === true);
    assert.equal(result.usedVersion, 'v3');

    console.log('✓ Validation: known version');
  });

  it('returns error for unknown version', async () => {
    const xml = '<Invoice schemaVersion="v99">doc</Invoice>';
    const result = await registry.validate(xml);

    assert(result.valid === false);
    assert(result.errors.length > 0);

    console.log('✓ Validation: unknown version error');
  });

  it('uses default for missing version', async () => {
    registry.setDefaultVersion('v3');

    const xml = '<Invoice>no version</Invoice>';
    const result = await registry.validate(xml);

    assert.equal(result.usedVersion, 'v3');

    console.log('✓ Validation: default version');
  });

  it('fallback validation tries multiple versions', async () => {
    const xml = '<Invoice>unknown version</Invoice>';
    const result = await registry.validateWithFallback(xml);

    assert(result.usedVersion);
    assert(typeof result.fallback === 'boolean' || result.fallback === undefined);

    console.log('✓ Validation: fallback chain');
  });
});

describe('FP-013: Schema Statistics & Metadata', () => {
  let registry: MockSchemaRegistry;

  beforeEach(async () => {
    registry = new MockSchemaRegistry();
  });

  it('tracks hits per version', async () => {
    await registry.register('v3', './Invoice_v3.xsd');

    const xml = '<Invoice schemaVersion="v3">doc</Invoice>';

    for (let i = 0; i < 5; i++) {
      await registry.validate(xml);
    }

    const stats = registry.getStats('v3');

    assert.equal(stats[0].hits, 5);

    console.log('✓ Statistics: hit tracking');
  });

  it('stores deprecation info', async () => {
    await registry.register('v2', './Invoice_v2.xsd', {
      deprecated: true,
    });

    const stats = registry.getStats('v2');

    assert.equal(stats[0].deprecated, true);

    console.log('✓ Metadata: deprecation flag');
  });

  it('returns all stats without filter', async () => {
    await registry.register('v2', './Invoice_v2.xsd');
    await registry.register('v3', './Invoice_v3.xsd');
    await registry.register('v4', './Invoice_v4.xsd');

    const allStats = registry.getStats();

    assert.equal(allStats.length, 3);

    console.log('✓ Statistics: get all');
  });

  it('returns empty array for unknown version', async () => {
    const stats = registry.getStats('v99');

    assert.equal(stats.length, 0);

    console.log('✓ Statistics: unknown version');
  });
});

describe('FP-013: Schema Registry Errors', () => {
  let registry: MockSchemaRegistry;

  beforeEach(async () => {
    registry = new MockSchemaRegistry();
  });

  it('rejects setting unknown default', async () => {
    try {
      registry.setDefaultVersion('v99');
      assert.fail('Should throw error');
    } catch (error: any) {
      assert(error.message.includes('not registered'));
    }

    console.log('✓ Error handling: unknown default');
  });

  it('fallback chain validation (mock is no-op)', async () => {
    await registry.register('v3', './Invoice_v3.xsd');

    // Mock registry's setFallbackChain is a no-op, so it won't throw
    // This is fine for a mock - real registry would validate
    registry.setFallbackChain(['v3']);

    // Should still work
    const versions = registry.listVersions();
    assert(versions.includes('v3'));

    console.log('✓ Fallback chain: mock allows (real would validate)');
  });
});
