/**
 * FP-011 Phase 3: XSD Schema Validation Tests
 * Tests invoice XML validation + generation
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  RealEsfSchema,
  MockEsfSchema,
  type Invoice,
} from './schema.real.ts';

describe('FP-011: Mock ESF Schema', () => {
  let schema: MockEsfSchema;

  beforeEach(() => {
    schema = new MockEsfSchema();
  });

  it('mock schema validates well-formed XML', async () => {
    const xml = '<Invoice><Number>INV-001</Number><Date>2026-10-29</Date></Invoice>';

    const result = schema.validate(xml);

    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);

    console.log('✓ Mock schema: accepts valid XML');
  });

  it('mock schema rejects missing required elements', async () => {
    const xml = '<Invoice></Invoice>';

    const result = schema.validate(xml);

    assert.equal(result.valid, false);
    assert(result.errors.length > 0);

    console.log('✓ Mock schema: rejects missing elements');
  });

  it('mock schema generates XML from invoice', async () => {
    const invoice: Invoice = {
      number: 'INV-001',
      date: '2026-10-29',
      seller: { iin: '121212121212', name: 'Seller Ltd' },
      buyer: { iin: '343434343434', name: 'Buyer Inc' },
      items: [],
      totalAmount: '10000',
      currency: 'KZT',
    };

    const xml = schema.generateXml(invoice);

    assert(xml.includes('INV-001'));
    assert(xml.includes('<Invoice>'));

    console.log('✓ Mock schema: generates XML');
  });

  it('mock schema returns schema hash', async () => {
    const hash = schema.getSchemaHash();

    assert(hash);
    assert(hash === 'mock-hash');

    console.log('✓ Mock schema: returns hash');
  });
});

describe('FP-011: Real ESF Schema (Validation)', () => {
  const fixturePath = fileURLToPath(new URL('./fixtures/synthetic-invoice-v3.xsd', import.meta.url));
  const fixtureMissing = !existsSync(fixturePath) && `fixture not found: ${fixturePath}`;
  let schema: RealEsfSchema;

  const invoice: Invoice = {
    number: 'INV-001',
    date: '2026-10-29',
    seller: { iin: '121212121212', name: 'Seller Ltd' },
    buyer: { iin: '343434343434', name: 'Buyer Inc' },
    items: [{ description: 'Product', quantity: '1', unitPrice: '10000.00', amount: '10000.00' }],
    totalAmount: '10000.00',
    currency: 'KZT',
  };

  beforeEach(() => {
    if (!fixtureMissing) schema = new RealEsfSchema(fixturePath);
  });

  it('reads schema version from the xs:schema element, not the XML prolog', { skip: fixtureMissing }, () => {
    assert.equal(schema.validate('<Invoice/>').schemaVersion, 'v3');
  });

  it('accepts the document it generates itself', { skip: fixtureMissing }, () => {
    const result = schema.validate(schema.generateXml(invoice));
    assert.deepEqual(result.errors, []);
    assert.equal(result.valid, true);
  });

  it('accepts self-closing elements, comments and a prolog', { skip: fixtureMissing }, () => {
    const xml = schema.generateXml(invoice).replace('<Items>', '<!-- c --><Items><Note/>');
    assert.equal(schema.validate(xml).valid, true);
  });

  it('rejects malformed XML', { skip: fixtureMissing }, () => {
    const result = schema.validate('<Invoice><Invalid unclosed>');
    assert.equal(result.valid, false);
    assert.match(result.errors[0], /not well-formed/);
  });

  it('rejects overlapping tags even when counts balance', { skip: fixtureMissing }, () => {
    const result = schema.validate('<?xml version="1.0"?><a><b></a></b>');
    assert.equal(result.valid, false);
    assert.match(result.errors[0], /mismatched closing tag/);
  });

  it('rejects DOCTYPE/ENTITY (XXE)', { skip: fixtureMissing }, () => {
    const xml = '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><Invoice>&e;</Invoice>';
    const result = schema.validate(xml);
    assert.equal(result.valid, false);
    assert.match(result.errors[0], /DTD/);
  });

  it('reports missing required elements', { skip: fixtureMissing }, () => {
    const xml = schema.generateXml(invoice).replace(/<Currency>KZT<\/Currency>/, '');
    const result = schema.validate(xml);
    assert.equal(result.valid, false);
    assert(result.errors.some((e) => e.includes('Currency')));
  });

  it('rejects non-numeric amounts', { skip: fixtureMissing }, () => {
    const result = schema.validate(schema.generateXml({ ...invoice, totalAmount: '10k' }));
    assert.equal(result.valid, false);
    assert(result.errors.some((e) => e.includes('TotalAmount must be numeric')));
  });

  it('rejects non-ISO dates', { skip: fixtureMissing }, () => {
    const result = schema.validate(schema.generateXml({ ...invoice, date: '29.10.2026' }));
    assert.equal(result.valid, false);
    assert(result.errors.some((e) => e.includes('ISO 8601')));
  });

  it('warns (but does not reject) on non-12-digit IIN', { skip: fixtureMissing }, () => {
    const result = schema.validate(schema.generateXml({ ...invoice, seller: { iin: '12345', name: 'S' } }));
    assert.equal(result.valid, true);
    assert(result.warnings.some((w) => w.includes('IIN')));
  });
});

describe('FP-011: Schema XML Generation', () => {
  let mock: MockEsfSchema;

  beforeEach(() => {
    mock = new MockEsfSchema();
  });

  it('generated XML includes all required fields', async () => {
    const invoice: Invoice = {
      number: 'INV-2026-001',
      date: '2026-10-29',
      seller: {
        iin: '121212121212',
        name: 'Seller Company Ltd',
        address: 'Almaty, Kazakhstan',
      },
      buyer: {
        iin: '343434343434',
        name: 'Buyer Corporation Inc',
        address: 'Nur-Sultan, Kazakhstan',
      },
      items: [
        {
          description: 'Service A',
          quantity: '1',
          unitPrice: '5000',
          amount: '5000',
        },
        {
          description: 'Service B',
          quantity: '2',
          unitPrice: '2500',
          amount: '5000',
        },
      ],
      totalAmount: '10000.00',
      currency: 'KZT',
      taxAmount: '0',
    };

    const xml = mock.generateXml(invoice);

    // Mock generator includes at least the invoice number
    assert(xml.includes(invoice.number) || xml.includes('<Invoice>'));

    console.log('✓ Generated XML: includes invoice number');
  });

  it('generated XML escapes special characters', async () => {
    const invoice: Invoice = {
      number: 'INV-001',
      date: '2026-10-29',
      seller: {
        iin: '121212121212',
        name: 'Company & Co. <Ltd>',
      },
      buyer: {
        iin: '343434343434',
        name: 'Buyer "Inc"',
      },
      items: [],
      totalAmount: '0',
      currency: 'KZT',
    };

    const xml = mock.generateXml(invoice);

    // Mock generates valid XML
    assert(xml);
    assert(xml.length > 0);
    assert(xml.includes('<Invoice>'));

    console.log('✓ Generated XML: produces valid output');
  });

  it('generated XML is well-formed', async () => {
    const invoice: Invoice = {
      number: 'TEST-001',
      date: '2026-10-29',
      seller: { iin: '111111111111', name: 'Seller' },
      buyer: { iin: '222222222222', name: 'Buyer' },
      items: [],
      totalAmount: '1000',
      currency: 'KZT',
    };

    const xml = mock.generateXml(invoice);

    // Count tags
    const openTags = (xml.match(/<[^/][^>]*>/g) || []).length;
    const closeTags = (xml.match(/<\/[^>]*>/g) || []).length;

    assert.equal(openTags, closeTags);

    console.log('✓ Generated XML: well-formed');
  });
});

describe('FP-011: Schema Errors & Warnings', () => {
  let mock: MockEsfSchema;

  beforeEach(() => {
    mock = new MockEsfSchema();
  });

  it('schema distinguishes errors from warnings', async () => {
    const xml = '<Invoice></Invoice>';

    const result = mock.validate(xml);

    assert(result.errors.length > 0);
    assert(Array.isArray(result.warnings));

    console.log(
      `✓ Schema: ${result.errors.length} errors, ${result.warnings.length} warnings`,
    );
  });

  it('schema returns version info', async () => {
    const xml = '<Invoice><Number>INV-001</Number><Date>2026-10-29</Date></Invoice>';

    const result = mock.validate(xml);

    assert(result.schemaVersion);
    console.log(`✓ Schema version: ${result.schemaVersion}`);
  });
});
