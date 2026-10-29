/**
 * FP-011 Phase 2: Real ESF Gateway (SOAP/WSDL Integration)
 * Integrates with ИС ЭСФ WSDL API (МОД РК)
 *
 * Gateway URLs:
 * - Test: https://test-es.lk.kz/esfgateway/
 * - Production: https://es.lk.kz/esfgateway/
 *
 * WSDL Methods:
 * - SendDocument(documentXml, signature) → DocumentId, Status, Error
 * - GetDocumentStatus(documentId) → Status, Error
 * - GetDocument(documentId) → Document, Metadata
 */

import https from 'https';
import http from 'http';

export interface EsfDocument {
  id: string;
  xml: string;
  signature: string; // base64-encoded ЭЦП
  invoiceNumber: string;
  invoiceDate: string; // ISO 8601
}

export interface GatewayResponse {
  state: 'REGISTERED' | 'REJECTED' | 'UNKNOWN';
  externalId?: string; // DocumentId from gateway
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

export interface SOAPClientConfig {
  wsdlUrl: string;
  credentials: {
    login: string;
    password: string;
    organizationId: string;
  };
  timeout?: number; // milliseconds
  retryAttempts?: number;
}

/**
 * FP-011: Real ESF Gateway (SOAP/WSDL)
 */
export class RealEsfGateway {
  private wsdlUrl: string;
  private credentials: SOAPClientConfig['credentials'];
  private timeout: number;
  private retryAttempts: number;

  constructor(config: SOAPClientConfig) {
    this.wsdlUrl = config.wsdlUrl;
    this.credentials = config.credentials;
    this.timeout = config.timeout || 30_000; // 30s default
    this.retryAttempts = config.retryAttempts || 3;
  }

  /**
   * FP-011: Send document to ESF gateway
   * Maps: invoke SOAP SendDocument → state + externalId
   */
  async send(doc: EsfDocument): Promise<GatewayResponse> {
    try {
      const result = await this.sendWithRetry(doc, 0);
      return result;
    } catch (error: any) {
      return {
        state: 'UNKNOWN',
        error: {
          code: 'GATEWAY_ERROR',
          message: error.message || 'Unknown error',
        },
      };
    }
  }

  /**
   * FP-011: Lookup document status in gateway
   * Maps: invoke SOAP GetDocumentStatus → state
   */
  async lookup(externalId: string): Promise<GatewayResponse> {
    try {
      const response = await this.callSoapMethod('GetDocumentStatus', {
        documentId: externalId,
      });

      const state = this.mapStatus(response.status);
      const error = response.error
        ? {
            code: response.error.code || 'REMOTE_ERROR',
            message: response.error.message || 'Unknown error',
          }
        : undefined;

      return {
        state,
        externalId,
        error,
      };
    } catch (error: any) {
      return {
        state: 'UNKNOWN',
        externalId,
        error: {
          code: 'LOOKUP_FAILED',
          message: error.message,
        },
      };
    }
  }

  /**
   * FP-011: Download document from gateway (for audit/verification)
   */
  async getDocument(externalId: string): Promise<{
    xml: string;
    signature: string;
    status: string;
    timestamp: Date;
  } | null> {
    try {
      const response = await this.callSoapMethod('GetDocument', {
        documentId: externalId,
      });

      return {
        xml: response.xml || '',
        signature: response.signature || '',
        status: response.status || 'UNKNOWN',
        timestamp: new Date(),
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * FP-011: Internal: send with retry logic
   */
  private async sendWithRetry(
    doc: EsfDocument,
    attempt: number,
  ): Promise<GatewayResponse> {
    try {
      const response = await this.callSoapMethod('SendDocument', {
        documentXml: doc.xml,
        signature: doc.signature,
        invoiceNumber: doc.invoiceNumber,
        invoiceDate: doc.invoiceDate,
      });

      // Parse SOAP response
      const state = this.mapStatus(response.status);
      const externalId = response.documentId || response.id;
      const error = response.error
        ? {
            code: response.error.code || 'REMOTE_ERROR',
            message: response.error.message || 'Unknown error',
            details: response.error.details,
          }
        : undefined;

      return {
        state,
        externalId,
        error,
      };
    } catch (error: any) {
      // Retry logic: transient errors (timeout, connection)
      if (attempt < this.retryAttempts && this.isRetryable(error)) {
        const backoffMs = Math.pow(2, attempt) * 1000; // exponential backoff
        await this.delay(backoffMs);
        return this.sendWithRetry(doc, attempt + 1);
      }

      // Terminal error
      throw error;
    }
  }

  /**
   * FP-011: Internal: call SOAP method via HTTP
   */
  private async callSoapMethod(
    method: string,
    params: Record<string, unknown>,
  ): Promise<any> {
    // Build SOAP request XML
    const soapRequest = this.buildSoapRequest(method, params);

    // Send HTTP request
    const response = await this.postSoap(soapRequest);

    // Parse SOAP response
    return this.parseSoapResponse(response);
  }

  /**
   * FP-011: Build SOAP request XML
   */
  private buildSoapRequest(method: string, params: Record<string, unknown>): string {
    const paramXml = Object.entries(params)
      .map(([key, value]) => `<${key}>${this.escapeXml(String(value))}</${key}>`)
      .join('\n    ');

    return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:esf="http://es.lk.kz/esfgateway/">
  <soapenv:Header/>
  <soapenv:Body>
    <esf:${method}>
      <credentials>
        <login>${this.escapeXml(this.credentials.login)}</login>
        <password>${this.escapeXml(this.credentials.password)}</password>
        <organizationId>${this.escapeXml(this.credentials.organizationId)}</organizationId>
      </credentials>
      ${paramXml}
    </esf:${method}>
  </soapenv:Body>
</soapenv:Envelope>`;
  }

  /**
   * FP-011: Send HTTP POST to gateway
   */
  private async postSoap(soapXml: string): Promise<string> {
    // This is a stub — actual implementation requires http/https client
    // For now, we throw to indicate real implementation is needed
    const url = new URL(this.wsdlUrl);
    const isHttps = url.protocol === 'https:';

    return new Promise((resolve, reject) => {
      const client = isHttps ? https : http;

      const options = {
        method: 'POST',
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        timeout: this.timeout,
        headers: {
          'Content-Type': 'text/xml; charset=UTF-8',
          'SOAPAction': '', // Will be set per method
          'Content-Length': Buffer.byteLength(soapXml),
        },
      };

      const req = client.request(options, (res: any) => {
        let data = '';

        res.on('data', (chunk: Buffer) => {
          data += chunk;
        });

        res.on('end', () => {
          resolve(data);
        });
      });

      req.on('error', (error: Error) => {
        reject(error);
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('SOAP request timeout'));
      });

      req.write(soapXml);
      req.end();
    });
  }

  /**
   * FP-011: Parse SOAP response
   */
  private parseSoapResponse(soapXml: string): Record<string, unknown> {
    // Stub: real implementation would parse XML
    // For now, return structure expected by callers

    // Extract status from SOAP response
    const statusMatch = soapXml.match(/<status[^>]*>([^<]+)<\/status>/i);
    const status = statusMatch ? statusMatch[1] : 'UNKNOWN';

    // Extract documentId from SOAP response
    const idMatch = soapXml.match(/<documentId[^>]*>([^<]+)<\/documentId>/i);
    const documentId = idMatch ? idMatch[1] : undefined;

    // Extract error (if present)
    const errorMatch = soapXml.match(
      /<error[^>]*><code[^>]*>([^<]+)<\/code><message[^>]*>([^<]+)<\/message><\/error>/i,
    );
    const error = errorMatch
      ? { code: errorMatch[1], message: errorMatch[2] }
      : undefined;

    return {
      status,
      documentId,
      error,
    };
  }

  /**
   * FP-011: Map SOAP status to canonical state
   */
  private mapStatus(
    soapStatus: string,
  ): 'REGISTERED' | 'REJECTED' | 'UNKNOWN' {
    const status = (soapStatus || '').toUpperCase();

    if (
      status === 'REGISTERED' ||
      status === 'ACCEPTED' ||
      status === 'OK'
    ) {
      return 'REGISTERED';
    }

    if (
      status === 'REJECTED' ||
      status === 'REFUSED' ||
      status === 'ERROR'
    ) {
      return 'REJECTED';
    }

    return 'UNKNOWN';
  }

  /**
   * FP-011: Check if error is retryable
   */
  private isRetryable(error: any): boolean {
    const msg = (error.message || '').toLowerCase();

    return (
      msg.includes('timeout') ||
      msg.includes('econnrefused') ||
      msg.includes('econnreset') ||
      msg.includes('socket hang up')
    );
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

  /**
   * FP-011: Delay utility (for backoff)
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * FP-011: Mock ESF Gateway (for testing without real gateway)
 */
export class MockEsfGateway {
  private documents: Map<string, GatewayResponse> = new Map();
  private docCounter = 0;

  async send(doc: EsfDocument): Promise<GatewayResponse> {
    // Generate synthetic document ID
    const externalId = `mock-doc-${++this.docCounter}`;

    // Store for lookup
    this.documents.set(externalId, {
      state: 'REGISTERED',
      externalId,
    });

    return {
      state: 'REGISTERED',
      externalId,
    };
  }

  async lookup(externalId: string): Promise<GatewayResponse> {
    const doc = this.documents.get(externalId);

    if (!doc) {
      return {
        state: 'UNKNOWN',
        externalId,
        error: {
          code: 'NOT_FOUND',
          message: 'Document not found in mock gateway',
        },
      };
    }

    return doc;
  }

  // Test helper: simulate rejection
  simulateRejection(externalId: string, reason: string): void {
    this.documents.set(externalId, {
      state: 'REJECTED',
      externalId,
      error: {
        code: 'REMOTE_REJECTED',
        message: reason,
      },
    });
  }

  // Test helper: clear all documents
  reset(): void {
    this.documents.clear();
    this.docCounter = 0;
  }
}
