/**
 * FP-013: Integrated ESF validator + real SchemaRegistry (no mocks).
 * Uses the synthetic fixture XSD; it is NOT the official ИС ЭСФ schema.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { SchemaRegistry } from './schema-registry.ts';
import { EsfValidatorIntegrated } from './esf-validator.integrated.ts';
import { RealEsfSchema, type Invoice } from './schema.real.ts';

const XSD = fileURLToPath(new URL('./fixtures/synthetic-invoice-v3.xsd', import.meta.url));

const invoice: Invoice = {
  number: 'INV-1',
  date: '2026-10-29',
  seller: { iin: '121212121212', name: 'Seller' },
  buyer: { iin: '343434343434', name: 'Buyer' },
  items: [{ description: 'Item', quantity: '1', unitPrice: '100.00', amount: '100.00' }],
  totalAmount: '100.00',
  currency: 'KZT',
};
const validXml = (version: string | null = 'v3') => {
  const xml = new RealEsfSchema(XSD).generateXml(invoice);
  return version === null
    ? xml.replace(/ schemaVersion="[^"]*"/, '')
    : xml.replace(/schemaVersion="[^"]*"/, `schemaVersion="${version}"`);
};
const withoutCurrency = (xml: string) => xml.replace(/<Currency>KZT<\/Currency>/, '');

async function makeValidator(config?: ConstructorParameters<typeof EsfValidatorIntegrated>[1]) {
  const validator = new EsfValidatorIntegrated(new SchemaRegistry(), config);
  await validator.initialize([
    { version: 'v2', xsdPath: XSD, deprecated: true },
    { version: 'v3', xsdPath: XSD },
    { version: 'v4', xsdPath: XSD },
  ]);
  return validator;
}

describe('FP-013: EsfValidatorIntegrated (real registry)', () => {
  let validator: EsfValidatorIntegrated;

  beforeEach(async () => {
    validator = await makeValidator();
  });

  it('can be constructed on an empty registry and initialized afterwards', async () => {
    const v = new EsfValidatorIntegrated(new SchemaRegistry());
    await v.initialize([{ version: 'v3', xsdPath: XSD }]);
    assert.equal((await v.validateDocument(validXml())).recommendation, 'ACCEPT');
  });

  it('ACCEPTs a valid document with the detected version, no fallback', async () => {
    const r = await validator.validateDocument(validXml('v3'));
    assert.equal(r.recommendation, 'ACCEPT');
    assert.equal(r.usedVersion, 'v3');
    assert.equal(r.fallback, false);
    assert.equal(r.isQuarantined, false);
  });

  it('REJECTs (not quarantines) a known version with invalid content and keeps its errors', async () => {
    const r = await validator.validateDocument(withoutCurrency(validXml('v3')));
    assert.equal(r.recommendation, 'REJECT');
    assert.equal(r.isQuarantined, false);
    assert.equal(r.usedVersion, 'v3');
    assert(r.errors.some((e) => e.includes('Currency')), r.errors.join('; '));
  });

  it('falls back to the primary schema for an unknown version whose content is valid', async () => {
    const r = await validator.validateDocument(validXml('v99'));
    assert.equal(r.recommendation, 'ACCEPT');
    assert.equal(r.detectedVersion, 'v99');
    assert.equal(r.usedVersion, 'v3');
    assert.equal(r.fallback, true);
  });

  it('QUARANTINEs an unknown version that matches no schema', async () => {
    const r = await validator.validateDocument(withoutCurrency(validXml('v99')));
    assert.equal(r.recommendation, 'QUARANTINE');
    assert.equal(r.isQuarantined, true);
    assert.equal(r.detectedVersion, 'v99');
    assert.equal(r.usedVersion, undefined);
  });

  it('QUARANTINEs a document with no declared version that matches nothing', async () => {
    const r = await validator.validateDocument('<?xml version="1.0"?><Garbage/>');
    assert.equal(r.recommendation, 'QUARANTINE');
    assert.equal(r.detectedVersion, undefined);
  });

  it('never ACCEPTs a document with a DTD (XXE)', async () => {
    const xml = validXml('v3').replace('?>', '?><!DOCTYPE Invoice [<!ENTITY e SYSTEM "file:///etc/passwd">]>');
    const r = await validator.validateDocument(xml);
    assert.notEqual(r.recommendation, 'ACCEPT');
    assert(r.errors.some((e) => e.includes('DTD')), r.errors.join('; '));
  });

  it('REJECTs instead of quarantining when quarantineUnknown is false', async () => {
    const v = await makeValidator({ quarantineUnknown: false });
    const r = await v.validateDocument(withoutCurrency(validXml('v99')));
    assert.equal(r.recommendation, 'REJECT');
    assert.equal(r.isQuarantined, false);
  });

  it('strict validation never falls back and never quarantines', async () => {
    const unknown = await validator.validateStrict(validXml('v99'));
    assert.equal(unknown.recommendation, 'REJECT');
    assert.equal(unknown.isQuarantined, false);

    const invalid = await validator.validateStrict(withoutCurrency(validXml('v3')));
    assert.equal(invalid.recommendation, 'REJECT');
    assert.equal(invalid.isQuarantined, false);

    const ok = await validator.validateStrict(validXml('v2'));
    assert.equal(ok.recommendation, 'ACCEPT');
    assert.equal(ok.usedVersion, 'v2');
    assert.equal(ok.fallback, false);
  });

  it('uses the configured primary version for documents without a version', async () => {
    const v = await makeValidator({ primaryVersion: 'v2', fallbackChain: ['v2', 'v3'] });
    const r = await v.validateStrict(validXml(null));
    assert.equal(r.usedVersion, 'v2');
    const stats = v.getSchemaStats();
    assert.equal(stats.primaryVersion, 'v2');
    assert.deepEqual(stats.fallbackChain, ['v2', 'v3']);
  });

  it('counts hits per version and reports deprecation', async () => {
    await validator.validateDocument(validXml('v3'));
    await validator.validateDocument(validXml('v3'));
    await validator.validateDocument(validXml('v2'));
    const byVersion = Object.fromEntries(validator.getSchemaStats().schemas.map((s) => [s.version, s]));
    assert.equal(byVersion.v3.hits, 2);
    assert.equal(byVersion.v2.hits, 1);
    assert.equal(byVersion.v4.hits, 0);
    assert.equal(byVersion.v2.deprecated, true);
    assert.equal(byVersion.v3.deprecated, false);
  });
});

describe('FP-013: SchemaRegistry (real)', () => {
  let registry: SchemaRegistry;

  beforeEach(async () => {
    registry = new SchemaRegistry();
    await registry.register('v3', XSD);
    await registry.register('v2', XSD, { deprecated: true });
  });

  it('rejects duplicate registration and unreadable XSD', async () => {
    await assert.rejects(registry.register('v3', XSD), /already registered/);
    await assert.rejects(registry.register('v9', '/nonexistent.xsd'), /Failed to load schema v9/);
  });

  it('refuses unknown versions as default or in the fallback chain', () => {
    assert.throws(() => registry.setDefaultVersion('v99'), /not registered/);
    assert.throws(() => registry.setFallbackChain(['v3', 'v99']), /not registered/);
  });

  it('validate() reports an unregistered declared version without falling back', async () => {
    const r = await registry.validate(validXml('v99'));
    assert.equal(r.valid, false);
    assert.equal(r.usedVersion, 'v99');
    assert.notEqual(r.quarantined, true);
  });

  it('validateWithFallback() sets quarantined only when nothing matches', async () => {
    assert.equal((await registry.validateWithFallback(validXml('v3'))).quarantined, false);
    assert.equal((await registry.validateWithFallback(withoutCurrency(validXml('v3')))).quarantined, false);
    assert.equal((await registry.validateWithFallback(withoutCurrency(validXml('v7')))).quarantined, true);
  });

  it('respects a custom fallback chain order', async () => {
    registry.setFallbackChain(['v2', 'v3']);
    const r = await registry.validateWithFallback(validXml('v42'));
    assert.equal(r.usedVersion, 'v2');
    assert.equal(r.fallback, true);
  });
});
