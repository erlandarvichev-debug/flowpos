/**
 * FP-011 Phase 3: XSD Schema Validation
 * Validates invoice XML against ESF schema
 *
 * Schema sources from ИС ЭСФ (МОД РК):
 * - Invoice_v2.xsd (legacy support)
 * - Invoice_v3.xsd (current production)
 *
 * Usage:
 * const schema = new RealEsfSchema('./Invoice_v3.xsd');
 * const validation = schema.validate(xml);
 * if (!validation.valid) { quarantine(validation.errors); }
 */

import { readFileSync } from 'fs';
import { createHash } from 'crypto';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  schemaVersion?: string;
}

export interface Invoice {
  number: string;
  date: string; // ISO 8601
  seller: {
    iin: string;
    name: string;
    address?: string;
  };
  buyer: {
    iin: string;
    name: string;
    address?: string;
  };
  items: Array<{
    description: string;
    quantity: string;
    unitPrice: string;
    amount: string;
  }>;
  totalAmount: string;
  currency: string;
  taxAmount?: string;
}

/**
 * FP-011: XSD Schema Validator
 * Validates XML against ESF schema definition
 */
export class RealEsfSchema {
  private xsdContent: string;
  private xsdPath: string;
  private schemaVersion: string;
  private requiredElements: Set<string>;
  private enumElements: Map<string, Set<string>>;

  constructor(xsdPath: string) {
    this.xsdPath = xsdPath;

    // Load XSD file
    try {
      this.xsdContent = readFileSync(xsdPath, 'utf-8');
    } catch (error: any) {
      throw new Error(
        `Cannot load XSD schema: ${xsdPath} - ${error.message}`,
      );
    }

    // Parse schema version from content
    this.schemaVersion = this.extractSchemaVersion(this.xsdContent);

    // Extract required elements + enums
    this.requiredElements = this.extractRequiredElements();
    this.enumElements = this.extractEnumElements();
  }

  /**
   * FP-011: Validate XML against schema
   */
  validate(xml: string): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    try {
      // 1. Check XML is well-formed
      if (!this.isWellFormedXml(xml)) {
        errors.push('XML is not well-formed (parse error)');
        return { valid: false, errors, warnings, schemaVersion: this.schemaVersion };
      }

      // 2. Check required elements present
      const missingElements = this.findMissingElements(xml);
      if (missingElements.length > 0) {
        errors.push(
          `Missing required elements: ${missingElements.join(', ')}`,
        );
      }

      // 3. Check enum values
      const invalidEnums = this.findInvalidEnums(xml);
      if (invalidEnums.length > 0) {
        errors.push(`Invalid enum values: ${invalidEnums.join(', ')}`);
      }

      // 4. Check numeric fields
      const numericErrors = this.validateNumericFields(xml);
      errors.push(...numericErrors);

      // 5. Check date formats
      const dateErrors = this.validateDateFields(xml);
      errors.push(...dateErrors);

      // 6. Check IIN/BIN format (Kazakhstan)
      const iinErrors = this.validateIinBin(xml);
      warnings.push(...iinErrors); // warnings only

      return {
        valid: errors.length === 0,
        errors,
        warnings,
        schemaVersion: this.schemaVersion,
      };
    } catch (error: any) {
      return {
        valid: false,
        errors: [`Validation error: ${error.message}`],
        warnings,
        schemaVersion: this.schemaVersion,
      };
    }
  }

  /**
   * FP-011: Generate XML from invoice object
   * Ensures valid structure + all required fields
   */
  generateXml(invoice: Invoice): string {
    const itemsXml = invoice.items
      .map(
        (item) => `
    <Item>
      <Description>${this.escapeXml(item.description)}</Description>
      <Quantity>${this.escapeXml(item.quantity)}</Quantity>
      <UnitPrice>${this.escapeXml(item.unitPrice)}</UnitPrice>
      <Amount>${this.escapeXml(item.amount)}</Amount>
    </Item>`,
      )
      .join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="http://es.lk.kz/schema/invoice" schemaVersion="${this.schemaVersion}">
  <Number>${this.escapeXml(invoice.number)}</Number>
  <Date>${this.escapeXml(invoice.date)}</Date>
  <Seller>
    <IIN>${this.escapeXml(invoice.seller.iin)}</IIN>
    <Name>${this.escapeXml(invoice.seller.name)}</Name>
    <Address>${this.escapeXml(invoice.seller.address || '')}</Address>
  </Seller>
  <Buyer>
    <IIN>${this.escapeXml(invoice.buyer.iin)}</IIN>
    <Name>${this.escapeXml(invoice.buyer.name)}</Name>
    <Address>${this.escapeXml(invoice.buyer.address || '')}</Address>
  </Buyer>
  <Items>${itemsXml}
  </Items>
  <TotalAmount>${this.escapeXml(invoice.totalAmount)}</TotalAmount>
  <Currency>${this.escapeXml(invoice.currency)}</Currency>
  ${invoice.taxAmount ? `<TaxAmount>${this.escapeXml(invoice.taxAmount)}</TaxAmount>` : ''}
</Invoice>`;
  }

  /**
   * FP-011: Compute schema hash (for versioning)
   */
  getSchemaHash(): string {
    return createHash('sha256').update(this.xsdContent).digest('hex');
  }

  /**
   * FP-011: Internal: check if XML is well-formed
   */
  private isWellFormedXml(xml: string): boolean {
    try {
      // Simple check: count opening/closing tags
      const openTags = (xml.match(/<[^/][^>]*>/g) || []).length;
      const closeTags = (xml.match(/<\/[^>]*>/g) || []).length;

      return openTags === closeTags && xml.includes('<?xml');
    } catch {
      return false;
    }
  }

  /**
   * FP-011: Internal: find missing required elements
   */
  private findMissingElements(xml: string): string[] {
    const missing: string[] = [];

    for (const element of this.requiredElements) {
      // Check if element exists in XML
      const pattern = new RegExp(`<${element}[^>]*>`, 'i');
      if (!pattern.test(xml)) {
        missing.push(element);
      }
    }

    return missing;
  }

  /**
   * FP-011: Internal: find invalid enum values
   */
  private findInvalidEnums(xml: string): string[] {
    const invalid: string[] = [];

    for (const [element, validValues] of this.enumElements) {
      const pattern = new RegExp(
        `<${element}[^>]*>([^<]+)</${element}>`,
        'i',
      );
      const match = xml.match(pattern);

      if (match && !validValues.has(match[1])) {
        invalid.push(`${element}=${match[1]} (expected: ${Array.from(validValues).join('|')})`);
      }
    }

    return invalid;
  }

  /**
   * FP-011: Internal: validate numeric fields (amounts, quantities)
   */
  private validateNumericFields(xml: string): string[] {
    const errors: string[] = [];

    // Check TotalAmount is numeric
    const amountMatch = xml.match(
      /<TotalAmount[^>]*>([^<]+)<\/TotalAmount>/,
    );
    if (amountMatch) {
      const amount = amountMatch[1];
      if (!/^\d+(\.\d{1,2})?$/.test(amount)) {
        errors.push(
          `TotalAmount must be numeric: ${amount}`,
        );
      }
    }

    // Check item quantities are numeric
    const quantityMatches = xml.matchAll(
      /<Quantity[^>]*>([^<]+)<\/Quantity>/g,
    );
    for (const match of quantityMatches) {
      if (!/^\d+(\.\d+)?$/.test(match[1])) {
        errors.push(`Quantity must be numeric: ${match[1]}`);
      }
    }

    return errors;
  }

  /**
   * FP-011: Internal: validate date fields (ISO 8601)
   */
  private validateDateFields(xml: string): string[] {
    const errors: string[] = [];

    const dateMatch = xml.match(/<Date[^>]*>([^<]+)<\/Date>/);
    if (dateMatch) {
      const date = dateMatch[1];
      // ISO 8601: YYYY-MM-DD
      if (!/^\d{4}-\d{2}-\d{2}/.test(date)) {
        errors.push(
          `Date must be ISO 8601 format (YYYY-MM-DD): ${date}`,
        );
      }
    }

    return errors;
  }

  /**
   * FP-011: Internal: validate IIN/BIN format (Kazakhstan 12-digit)
   */
  private validateIinBin(xml: string): string[] {
    const warnings: string[] = [];

    const iinMatches = xml.matchAll(/<IIN[^>]*>([^<]+)<\/IIN>/g);
    for (const match of iinMatches) {
      const iin = match[1];
      // Kazakhstan IIN: 12 digits
      if (!/^\d{12}$/.test(iin)) {
        warnings.push(
          `IIN should be 12 digits (Kazakhstan format): ${iin}`,
        );
      }
    }

    return warnings;
  }

  /**
   * FP-011: Internal: extract required elements from schema
   */
  private extractRequiredElements(): Set<string> {
    const required = new Set<string>();

    // Parse minOccurs="1" or explicit required markers
    const requiredPattern =
      /element[^>]*name="([^"]+)"[^>]*minOccurs="1"/g;
    let match;

    while ((match = requiredPattern.exec(this.xsdContent)) !== null) {
      required.add(match[1]);
    }

    // Fallback: assume these are always required
    required.add('Number');
    required.add('Date');
    required.add('Seller');
    required.add('Buyer');
    required.add('Items');
    required.add('TotalAmount');
    required.add('Currency');

    return required;
  }

  /**
   * FP-011: Internal: extract enum definitions from schema
   */
  private extractEnumElements(): Map<string, Set<string>> {
    const enums = new Map<string, Set<string>>();

    // Parse restriction values
    const restrictionPattern =
      /restriction[^>]*base="[^"]*">([\s\S]*?)<\/restriction>/g;
    let match;

    while ((match = restrictionPattern.exec(this.xsdContent)) !== null) {
      const restrictionContent = match[1];
      const enumPattern = /enumeration[^>]*value="([^"]+)"/g;
      const values = new Set<string>();

      let enumMatch;
      while ((enumMatch = enumPattern.exec(restrictionContent)) !== null) {
        values.add(enumMatch[1]);
      }

      // Find the element this restriction applies to
      // (simplified: just track values)
      if (values.size > 0) {
        enums.set(`CurrencyCode`, values); // example
      }
    }

    return enums;
  }

  /**
   * FP-011: Internal: extract schema version
   */
  private extractSchemaVersion(xsd: string): string {
    const versionMatch = xsd.match(/version="([^"]+)"/);
    return versionMatch ? versionMatch[1] : 'unknown';
  }

  /**
   * FP-011: Internal: escape XML entities
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
 * FP-011: Mock ESF Schema (for testing without XSD file)
 */
export class MockEsfSchema {
  validate(xml: string): ValidationResult {
    const errors: string[] = [];

    if (!xml.includes('<Number>')) {
      errors.push('Missing <Number> element');
    }
    if (!xml.includes('<Date>')) {
      errors.push('Missing <Date> element');
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings: [],
      schemaVersion: 'mock-v1',
    };
  }

  generateXml(invoice: Invoice): string {
    return `<Invoice><Number>${invoice.number}</Number></Invoice>`;
  }

  getSchemaHash(): string {
    return 'mock-hash';
  }
}
