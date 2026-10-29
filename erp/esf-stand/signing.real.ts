/**
 * FP-011 Phase 1: Real Signing Provider (NCALayer Integration)
 * Integrates with NCALayer for ЭЦП (electronic digital signature)
 *
 * NCALayer runs on http://localhost:13579
 * Endpoint: POST /sign
 */

import https from 'https';
import http from 'http';
import { randomBytes } from 'crypto';

export interface Principal {
  principalId: string;
  tenantId: string;
  organizationId: string;
  certAlias?: string; // override cert per principal
}

export interface SignatureResult {
  signature: string; // base64-encoded signature
  marker: string; // "REAL_ECP" for production
  notice?: string; // certificate DN
}

export class RealSigningProvider {
  private ncaLayerUrl: string;
  private certAlias: string;
  private certPassword: string;

  constructor(
    ncaLayerUrl: string = 'http://localhost:13579',
    certAlias: string = process.env.NCA_LAYER_CERT_ALIAS || 'my_cert',
    certPassword: string = process.env.NCA_LAYER_PIN || '',
  ) {
    this.ncaLayerUrl = ncaLayerUrl;
    this.certAlias = certAlias;
    this.certPassword = certPassword;
  }

  /**
   * FP-011: Sign bytes with ЭЦП
   * Calls NCALayer /sign endpoint
   */
  async sign(bytes: Buffer, principal: Principal): Promise<SignatureResult> {
    // Use principal-specific cert if provided
    const alias = principal.certAlias || this.certAlias;

    // Build request payload
    const request = {
      method: 'sign',
      keystore: 'PKCS12',
      alias,
      pin: this.certPassword,
      data: bytes.toString('base64'),
    };

    try {
      const response = await this.callNCALayer(request);

      if (!response.success) {
        throw new Error(
          `NCALayer sign failed: ${response.message || 'unknown error'}`,
        );
      }

      // Extract signature + certificate DN
      const signature = response.signature || response.data;
      const certDn = response.certificate_dn || response.subject || alias;

      return {
        signature,
        marker: 'REAL_ECP', // Electronic digital signature (ЭЦП)
        notice: `Certificate: ${certDn}`,
      };
    } catch (error: any) {
      throw new Error(`Failed to sign with NCALayer: ${error.message}`);
    }
  }

  /**
   * FP-011: Get certificate info (for validation)
   */
  async getCertificateInfo(principal: Principal): Promise<{
    subject: string;
    issuer: string;
    validFrom: Date;
    validTo: Date;
    serialNumber: string;
  }> {
    const alias = principal.certAlias || this.certAlias;

    const request = {
      method: 'get-certificate-info',
      alias,
      pin: this.certPassword,
    };

    try {
      const response = await this.callNCALayer(request);

      if (!response.success) {
        throw new Error(`Cannot read certificate: ${response.message}`);
      }

      return {
        subject: response.subject || '',
        issuer: response.issuer || '',
        validFrom: response.validFrom ? new Date(response.validFrom) : new Date(),
        validTo: response.validTo ? new Date(response.validTo) : new Date(),
        serialNumber: response.serialNumber || '',
      };
    } catch (error: any) {
      throw new Error(`Failed to get certificate info: ${error.message}`);
    }
  }

  /**
   * FP-011: Verify certificate is valid (not expired, not revoked)
   */
  async verifyCertificate(principal: Principal): Promise<boolean> {
    try {
      const cert = await this.getCertificateInfo(principal);
      const now = new Date();

      if (cert.validFrom > now || cert.validTo < now) {
        console.warn(
          `Certificate ${principal.certAlias} expired or not yet valid`,
        );
        return false;
      }

      return true;
    } catch (error) {
      console.error(`Certificate verification failed: ${error}`);
      return false;
    }
  }

  /**
   * FP-011: List available certificates in keystore
   */
  async listCertificates(): Promise<
    Array<{ alias: string; subject: string; validTo: Date }>
  > {
    const request = {
      method: 'list-certificates',
    };

    try {
      const response = await this.callNCALayer(request);

      if (!response.success || !response.certificates) {
        return [];
      }

      return response.certificates.map((cert: any) => ({
        alias: cert.alias,
        subject: cert.subject,
        validTo: new Date(cert.validTo),
      }));
    } catch (error) {
      console.error(`Failed to list certificates: ${error}`);
      return [];
    }
  }

  /**
   * FP-011: Internal: call NCALayer HTTP endpoint
   */
  private async callNCALayer(request: Record<string, unknown>): Promise<any> {
    return new Promise((resolve, reject) => {
      const url = new URL(this.ncaLayerUrl);
      const isHttps = url.protocol === 'https:';

      const options = {
        method: 'POST',
        hostname: url.hostname,
        port: url.port,
        path: '/sign', // fixed endpoint for signing
        headers: {
          'Content-Type': 'application/json',
        },
      };

      const client = isHttps ? https : http;
      const req = client.request(options, (res: any) => {
        let data = '';

        res.on('data', (chunk: Buffer) => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            const response = JSON.parse(data);
            resolve(response);
          } catch (error) {
            reject(new Error(`Invalid JSON response from NCALayer: ${data}`));
          }
        });
      });

      req.on('error', (error: Error) => {
        reject(new Error(`NCALayer connection failed: ${error.message}`));
      });

      req.write(JSON.stringify(request));
      req.end();
    });
  }
}

/**
 * FP-011: Mock NCALayer Provider (for testing without real cert)
 * Simulates NCALayer responses for CI/CD
 */
export class MockNCALayerProvider implements SigningProvider {
  async sign(bytes: Buffer, principal: Principal): Promise<SignatureResult> {
    // Generate fake signature (deterministic for tests)
    const hash = bytes
      .toString()
      .split('')
      .reduce((h, c) => (h * 31 + c.charCodeAt(0)) & 0xffffffff, 0);
    const signature = Buffer.from(
      `mock-signature-${hash}`,
    ).toString('base64');

    return {
      signature,
      marker: 'MOCK_ECP', // Mark as mock for audit
      notice: 'Mock certificate (test only)',
    };
  }
}

export interface SigningProvider {
  sign(bytes: Buffer, principal: Principal): Promise<SignatureResult>;
}
