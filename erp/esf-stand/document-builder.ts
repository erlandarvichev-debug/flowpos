/**
 * FP-011 Phase 4: Document Builder
 * Converts invoice objects → canonical ESF XML format
 *
 * Handles:
 * - Field mapping (domain → XML)
 * - Tax calculation (VAT, excise, etc.)
 * - Amount rounding (to 2 decimals)
 * - Currency validation (KZT, USD, EUR)
 * - Payload hash computation (for idempotency)
 */

import { createHash } from 'crypto';

export interface InvoiceItem {
  description: string;
  quantity: string; // numeric string
  unitPrice: string; // in currency minor units
  amount: string; // quantity * unitPrice
  taxRate?: string; // percentage (e.g. "12" for 12%)
  taxAmount?: string; // calculated
}

export interface Invoice {
  number: string; // document number
  date: string; // ISO 8601: YYYY-MM-DD
  seller: {
    iin: string; // 12-digit Kazakhstan IIN or foreign ID
    name: string;
    address?: string;
    city?: string;
    postalCode?: string;
  };
  buyer: {
    iin: string; // 12-digit Kazakhstan IIN or BIN
    name: string;
    address?: string;
    city?: string;
    postalCode?: string;
  };
  items: InvoiceItem[];
  totalAmount: string; // sum of item amounts
  currency: string; // KZT, USD, EUR
  taxAmount?: string; // total tax
  description?: string; // invoice description/purpose
}

export interface GeneratedDocument {
  xml: string;
  hash: string;
  validated: boolean;
  errors: string[];
}

/**
 * FP-011: Document Builder
 * Converts invoice → canonical ESF XML + validation
 */
export class EsfDocumentBuilder {
  private supportedCurrencies = new Set(['KZT', 'USD', 'EUR', 'RUB']);
  private defaultTaxRate = '12'; // Kazakhstan VAT default

  /**
   * FP-011: Build document from invoice object
   */
  build(invoice: Invoice): GeneratedDocument {
    const errors: string[] = [];

    // 1. Validate invoice fields
    this.validateInvoice(invoice, errors);

    if (errors.length > 0) {
      return {
        xml: '',
        hash: '',
        validated: false,
        errors,
      };
    }

    // 2. Calculate tax amounts
    const enriched = this.enrichWithTax(invoice);

    // 3. Generate XML
    const xml = this.generateXml(enriched);

    // 4. Compute hash
    const hash = this.computeHash(xml);

    return {
      xml,
      hash,
      validated: true,
      errors: [],
    };
  }

  /**
   * FP-011: Validate invoice fields
   */
  private validateInvoice(invoice: Invoice, errors: string[]): void {
    // Document number
    if (!invoice.number || invoice.number.trim().length === 0) {
      errors.push('Invoice number is required');
    }

    // Date format
    if (!this.isValidDate(invoice.date)) {
      errors.push(
        `Invoice date must be ISO 8601 format (YYYY-MM-DD): ${invoice.date}`,
      );
    }

    // Seller
    if (!invoice.seller || !invoice.seller.iin) {
      errors.push('Seller IIN is required');
    }
    if (!invoice.seller || !invoice.seller.name) {
      errors.push('Seller name is required');
    }

    // Buyer
    if (!invoice.buyer || !invoice.buyer.iin) {
      errors.push('Buyer IIN is required');
    }
    if (!invoice.buyer || !invoice.buyer.name) {
      errors.push('Buyer name is required');
    }

    // Items
    if (!invoice.items || invoice.items.length === 0) {
      errors.push('Invoice must have at least one item');
    }

    for (let i = 0; i < (invoice.items || []).length; i++) {
      const item = invoice.items[i];

      if (!item.description) {
        errors.push(`Item ${i + 1}: description is required`);
      }

      if (!this.isNumeric(item.quantity)) {
        errors.push(`Item ${i + 1}: quantity must be numeric`);
      }

      if (!this.isNumeric(item.unitPrice)) {
        errors.push(`Item ${i + 1}: unitPrice must be numeric`);
      }

      if (!this.isNumeric(item.amount)) {
        errors.push(`Item ${i + 1}: amount must be numeric`);
      }
    }

    // Currency
    if (!invoice.currency) {
      errors.push('Currency is required');
    } else if (!this.supportedCurrencies.has(invoice.currency)) {
      errors.push(
        `Unsupported currency: ${invoice.currency} (expected: ${Array.from(this.supportedCurrencies).join(', ')})`,
      );
    }

    // Total amount
    if (!this.isNumeric(invoice.totalAmount)) {
      errors.push('Total amount must be numeric');
    }
  }

  /**
   * FP-011: Enrich invoice with calculated tax amounts
   */
  private enrichWithTax(invoice: Invoice): Invoice {
    const enriched = { ...invoice };

    // Calculate tax per item (if not provided)
    for (const item of enriched.items) {
      if (!item.taxAmount && item.amount) {
        const rate = item.taxRate ? parseFloat(item.taxRate) : parseFloat(this.defaultTaxRate);
        const amount = parseFloat(item.amount);
        const taxAmount = amount * (rate / 100);
        item.taxAmount = this.roundCurrency(taxAmount);
      }
    }

    // Calculate total tax (if not provided)
    if (!enriched.taxAmount) {
      const totalTax = enriched.items.reduce((sum, item) => {
        return sum + (item.taxAmount ? parseFloat(item.taxAmount) : 0);
      }, 0);
      enriched.taxAmount = this.roundCurrency(totalTax);
    }

    return enriched;
  }

  /**
   * FP-011: Generate canonical XML
   */
  private generateXml(invoice: Invoice): string {
    const itemsXml = invoice.items
      .map(
        (item) => `    <Item>
      <Description>${this.escapeXml(item.description)}</Description>
      <Quantity>${this.escapeXml(item.quantity)}</Quantity>
      <UnitPrice>${this.escapeXml(item.unitPrice)}</UnitPrice>
      <Amount>${this.escapeXml(item.amount)}</Amount>
      ${item.taxRate ? `<TaxRate>${this.escapeXml(item.taxRate)}</TaxRate>` : ''}
      ${item.taxAmount ? `<TaxAmount>${this.escapeXml(item.taxAmount)}</TaxAmount>` : ''}
    </Item>`,
      )
      .join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="http://es.lk.kz/schema/invoice" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <Number>${this.escapeXml(invoice.number)}</Number>
  <Date>${this.escapeXml(invoice.date)}</Date>
  <Seller>
    <IIN>${this.escapeXml(invoice.seller.iin)}</IIN>
    <Name>${this.escapeXml(invoice.seller.name)}</Name>
    ${invoice.seller.address ? `<Address>${this.escapeXml(invoice.seller.address)}</Address>` : ''}
    ${invoice.seller.city ? `<City>${this.escapeXml(invoice.seller.city)}</City>` : ''}
    ${invoice.seller.postalCode ? `<PostalCode>${this.escapeXml(invoice.seller.postalCode)}</PostalCode>` : ''}
  </Seller>
  <Buyer>
    <IIN>${this.escapeXml(invoice.buyer.iin)}</IIN>
    <Name>${this.escapeXml(invoice.buyer.name)}</Name>
    ${invoice.buyer.address ? `<Address>${this.escapeXml(invoice.buyer.address)}</Address>` : ''}
    ${invoice.buyer.city ? `<City>${this.escapeXml(invoice.buyer.city)}</City>` : ''}
    ${invoice.buyer.postalCode ? `<PostalCode>${this.escapeXml(invoice.buyer.postalCode)}</PostalCode>` : ''}
  </Buyer>
  <Items>
${itemsXml}
  </Items>
  <TotalAmount>${this.escapeXml(invoice.totalAmount)}</TotalAmount>
  <Currency>${this.escapeXml(invoice.currency)}</Currency>
  ${invoice.taxAmount ? `<TaxAmount>${this.escapeXml(invoice.taxAmount)}</TaxAmount>` : ''}
  ${invoice.description ? `<Description>${this.escapeXml(invoice.description)}</Description>` : ''}
</Invoice>`;
  }

  /**
   * FP-011: Compute SHA256 hash of XML (for idempotency)
   */
  private computeHash(xml: string): string {
    return createHash('sha256').update(xml).digest('hex');
  }

  /**
   * FP-011: Round currency to 2 decimals
   */
  private roundCurrency(amount: number): string {
    return (Math.round(amount * 100) / 100).toFixed(2);
  }

  /**
   * FP-011: Check if string is valid numeric
   */
  private isNumeric(str: string): boolean {
    return /^\d+(\.\d{1,2})?$/.test(str.trim());
  }

  /**
   * FP-011: Check if string is valid ISO 8601 date
   */
  private isValidDate(dateStr: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}/.test(dateStr)) {
      return false;
    }

    const date = new Date(dateStr);
    return !isNaN(date.getTime());
  }

  /**
   * FP-011: Escape XML entities
   */
  private escapeXml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
}

/**
 * FP-011: Mock Document Builder (for testing)
 */
export class MockDocumentBuilder {
  build(invoice: Invoice): GeneratedDocument {
    return {
      xml: `<Invoice><Number>${invoice.number}</Number></Invoice>`,
      hash: 'mock-hash',
      validated: true,
      errors: [],
    };
  }
}
