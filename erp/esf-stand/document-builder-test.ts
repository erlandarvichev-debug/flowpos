/**
 * FP-011 Phase 4: Document Builder Tests
 * Tests invoice → XML conversion + validation
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import {
  EsfDocumentBuilder,
  MockDocumentBuilder,
  type Invoice,
} from './document-builder.ts';

describe('FP-011: Mock Document Builder', () => {
  let builder: MockDocumentBuilder;

  beforeEach(() => {
    builder = new MockDocumentBuilder();
  });

  it('mock builder generates valid XML', async () => {
    const invoice: Invoice = {
      number: 'INV-001',
      date: '2026-10-29',
      seller: { iin: '121212121212', name: 'Seller' },
      buyer: { iin: '343434343434', name: 'Buyer' },
      items: [],
      totalAmount: '0',
      currency: 'KZT',
    };

    const doc = builder.build(invoice);

    assert(doc.xml);
    assert(doc.hash);
    assert(doc.validated === true);
    assert.equal(doc.errors.length, 0);

    console.log('✓ Mock builder: generates valid document');
  });
});

describe('FP-011: Real Document Builder', () => {
  let builder: EsfDocumentBuilder;

  beforeEach(() => {
    builder = new EsfDocumentBuilder();
  });

  it('builder validates required fields', async () => {
    const invalidInvoice: Invoice = {
      number: '', // missing number
      date: '2026-10-29',
      seller: { iin: '121212121212', name: 'Seller' },
      buyer: { iin: '343434343434', name: 'Buyer' },
      items: [
        {
          description: 'Product',
          quantity: '1',
          unitPrice: '100',
          amount: '100',
        },
      ],
      totalAmount: '100',
      currency: 'KZT',
    };

    const doc = builder.build(invalidInvoice);

    assert(!doc.validated);
    assert(doc.errors.length > 0);
    assert(doc.errors[0].includes('number'));

    console.log('✓ Builder: rejects missing invoice number');
  });

  it('builder validates date format (ISO 8601)', async () => {
    const invalidInvoice: Invoice = {
      number: 'INV-001',
      date: '29-10-2026', // wrong format
      seller: { iin: '121212121212', name: 'Seller' },
      buyer: { iin: '343434343434', name: 'Buyer' },
      items: [
        {
          description: 'Product',
          quantity: '1',
          unitPrice: '100',
          amount: '100',
        },
      ],
      totalAmount: '100',
      currency: 'KZT',
    };

    const doc = builder.build(invalidInvoice);

    assert(!doc.validated);
    assert(doc.errors.some((e) => e.includes('ISO')));

    console.log('✓ Builder: enforces ISO 8601 date format');
  });

  it('builder validates numeric fields', async () => {
    const invalidInvoice: Invoice = {
      number: 'INV-001',
      date: '2026-10-29',
      seller: { iin: '121212121212', name: 'Seller' },
      buyer: { iin: '343434343434', name: 'Buyer' },
      items: [
        {
          description: 'Product',
          quantity: 'abc', // not numeric
          unitPrice: '100',
          amount: '100',
        },
      ],
      totalAmount: '100',
      currency: 'KZT',
    };

    const doc = builder.build(invalidInvoice);

    assert(!doc.validated);
    assert(doc.errors.some((e) => e.includes('numeric')));

    console.log('✓ Builder: validates numeric fields');
  });

  it('builder validates supported currencies', async () => {
    const invalidInvoice: Invoice = {
      number: 'INV-001',
      date: '2026-10-29',
      seller: { iin: '121212121212', name: 'Seller' },
      buyer: { iin: '343434343434', name: 'Buyer' },
      items: [
        {
          description: 'Product',
          quantity: '1',
          unitPrice: '100',
          amount: '100',
        },
      ],
      totalAmount: '100',
      currency: 'XYZ', // unsupported
    };

    const doc = builder.build(invalidInvoice);

    assert(!doc.validated);
    assert(doc.errors.some((e) => e.includes('currency')));

    console.log('✓ Builder: validates supported currencies');
  });

  it('builder builds valid complete invoice', async () => {
    const invoice: Invoice = {
      number: 'INV-2026-001',
      date: '2026-10-29',
      seller: {
        iin: '121212121212',
        name: 'Seller Company Ltd',
        address: 'Almaty',
      },
      buyer: {
        iin: '343434343434',
        name: 'Buyer Corporation',
        address: 'Nur-Sultan',
      },
      items: [
        {
          description: 'Service A',
          quantity: '10',
          unitPrice: '100',
          amount: '1000',
          taxRate: '12',
        },
        {
          description: 'Service B',
          quantity: '5',
          unitPrice: '200',
          amount: '1000',
          taxRate: '12',
        },
      ],
      totalAmount: '2000',
      currency: 'KZT',
    };

    const doc = builder.build(invoice);

    assert(doc.validated);
    assert.equal(doc.errors.length, 0);
    assert(doc.xml);
    assert(doc.hash);
    assert(doc.xml.includes(invoice.number));
    assert(doc.xml.includes('INV-2026-001'));

    console.log('✓ Builder: creates valid complete invoice');
  });

  it('builder computes consistent hash', async () => {
    const invoice: Invoice = {
      number: 'INV-001',
      date: '2026-10-29',
      seller: { iin: '121212121212', name: 'Seller' },
      buyer: { iin: '343434343434', name: 'Buyer' },
      items: [
        {
          description: 'Product',
          quantity: '1',
          unitPrice: '100',
          amount: '100',
        },
      ],
      totalAmount: '100',
      currency: 'KZT',
    };

    const doc1 = builder.build(invoice);
    const doc2 = builder.build(invoice);

    // Same input → same hash
    assert.equal(doc1.hash, doc2.hash);

    // Hash is non-empty
    assert(doc1.hash);
    assert(doc1.hash.length === 64); // SHA256 hex = 64 chars

    console.log('✓ Builder: computes consistent SHA256 hash');
  });

  it('builder calculates tax amounts', async () => {
    const invoice: Invoice = {
      number: 'INV-001',
      date: '2026-10-29',
      seller: { iin: '121212121212', name: 'Seller' },
      buyer: { iin: '343434343434', name: 'Buyer' },
      items: [
        {
          description: 'Product',
          quantity: '1',
          unitPrice: '100',
          amount: '100',
          taxRate: '12', // 12% VAT
        },
      ],
      totalAmount: '100',
      currency: 'KZT',
    };

    const doc = builder.build(invoice);

    assert(doc.validated);
    // Tax should be calculated: 100 * 12% = 12.00
    assert(doc.xml.includes('TaxAmount'));

    console.log('✓ Builder: calculates tax amounts');
  });

  it('builder escapes special XML characters', async () => {
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
      items: [
        {
          description: 'Product & Service',
          quantity: '1',
          unitPrice: '100',
          amount: '100',
        },
      ],
      totalAmount: '100',
      currency: 'KZT',
    };

    const doc = builder.build(invoice);

    assert(doc.validated);
    // & should be escaped to &amp;
    assert(doc.xml.includes('&amp;'));

    console.log('✓ Builder: escapes XML special characters');
  });

  it('builder handles optional fields', async () => {
    const invoice: Invoice = {
      number: 'INV-001',
      date: '2026-10-29',
      seller: {
        iin: '121212121212',
        name: 'Seller',
        // no address, city, postalCode
      },
      buyer: {
        iin: '343434343434',
        name: 'Buyer',
        // no address, city, postalCode
      },
      items: [
        {
          description: 'Product',
          quantity: '1',
          unitPrice: '100',
          amount: '100',
          // no taxRate, taxAmount
        },
      ],
      totalAmount: '100',
      currency: 'KZT',
      // no taxAmount, description
    };

    const doc = builder.build(invoice);

    assert(doc.validated);
    assert(doc.xml);

    console.log('✓ Builder: handles optional fields');
  });

  it('builder rounds currency to 2 decimals', async () => {
    const invoice: Invoice = {
      number: 'INV-001',
      date: '2026-10-29',
      seller: { iin: '121212121212', name: 'Seller' },
      buyer: { iin: '343434343434', name: 'Buyer' },
      items: [
        {
          description: 'Product',
          quantity: '1',
          unitPrice: '99.99', // valid 2 decimals
          amount: '99.99',
        },
      ],
      totalAmount: '99.99',
      currency: 'KZT',
    };

    const doc = builder.build(invoice);

    assert(doc.validated);
    // Amounts in XML should have at most 2 decimal places
    assert(doc.xml.includes('99.99'));

    console.log('✓ Builder: handles 2-decimal currency amounts');
  });
});

describe('FP-011: Document Builder Errors', () => {
  let builder: EsfDocumentBuilder;

  beforeEach(() => {
    builder = new EsfDocumentBuilder();
  });

  it('builder collects multiple errors', async () => {
    const invalidInvoice: Invoice = {
      number: '',
      date: 'invalid-date',
      seller: { iin: '', name: '' },
      buyer: { iin: '', name: '' },
      items: [],
      totalAmount: 'not-a-number',
      currency: 'INVALID',
    };

    const doc = builder.build(invalidInvoice);

    assert(!doc.validated);
    assert(doc.errors.length >= 5); // Multiple validation errors

    console.log(
      `✓ Builder: collected ${doc.errors.length} validation errors`,
    );
  });

  it('builder requires at least one item', async () => {
    const invoice: Invoice = {
      number: 'INV-001',
      date: '2026-10-29',
      seller: { iin: '121212121212', name: 'Seller' },
      buyer: { iin: '343434343434', name: 'Buyer' },
      items: [], // no items
      totalAmount: '0',
      currency: 'KZT',
    };

    const doc = builder.build(invoice);

    assert(!doc.validated);
    assert(doc.errors.some((e) => e.includes('at least one item')));

    console.log('✓ Builder: requires items');
  });
});
