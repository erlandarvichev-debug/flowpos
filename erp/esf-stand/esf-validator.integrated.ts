/**
 * FP-013 Phase 2: Integrated ESF Validator
 * Wraps SchemaRegistry with document processing flow
 *
 * Replaces:
 * - Single hardcoded RealEsfSchema with multi-version SchemaRegistry
 * - Simple validate() with version-aware validation + fallback
 *
 * Used by:
 * - InboundPoller (validate incoming documents)
 * - EsfStore (validate outbound documents)
 * - ReconciliationService (validate reconciled documents)
 */

import { SchemaRegistry } from './schema-registry.ts';
import type { ValidationResultWithMetadata } from './schema-registry.ts';

export interface ValidationConfig {
  primaryVersion?: string; // default: v3
  fallbackChain?: string[]; // default: [v3, v2, v4]
  quarantineUnknown?: boolean; // default: true
}

export interface DocumentValidationResult extends ValidationResultWithMetadata {
  isQuarantined: boolean; // true if should be moved to quarantine
  canRetry: boolean; // true if might succeed with fallback
  recommendation: 'ACCEPT' | 'REJECT' | 'QUARANTINE';
}

/**
 * FP-013: Integrated ESF Validator
 * Combines SchemaRegistry with business logic
 */
export class EsfValidatorIntegrated {
  private registry: SchemaRegistry;
  private config: Required<ValidationConfig>;

  constructor(
    registry: SchemaRegistry,
    config?: ValidationConfig,
  ) {
    this.registry = registry;
    this.config = {
      primaryVersion: config?.primaryVersion || 'v3',
      fallbackChain: config?.fallbackChain || ['v3', 'v2', 'v4'],
      quarantineUnknown: config?.quarantineUnknown !== false,
    };

    this.applyConfig();
  }

  // Registration may happen before or after construction; only wire versions that exist.
  private applyConfig(): void {
    const registered = new Set(this.registry.listVersions());
    if (registered.has(this.config.primaryVersion)) {
      this.registry.setDefaultVersion(this.config.primaryVersion);
    }
    const chain = this.config.fallbackChain.filter((v) => registered.has(v));
    if (chain.length) this.registry.setFallbackChain(chain);
  }

  /**
   * FP-013: Validate document (validate + check what to do with it)
   * Used by: inbound processing, outbound creation
   */
  async validateDocument(xml: string): Promise<DocumentValidationResult> {
    // 1. Try with fallback
    const result = await this.registry.validateWithFallback(xml);

    // 2. Determine what to do
    const isQuarantined =
      !result.valid && result.quarantined === true && this.config.quarantineUnknown;

    const canRetry =
      !result.valid &&
      !isQuarantined &&
      result.detectedVersion != null;

    let recommendation: 'ACCEPT' | 'REJECT' | 'QUARANTINE';

    if (result.valid) {
      recommendation = 'ACCEPT';
    } else if (isQuarantined) {
      recommendation = 'QUARANTINE';
    } else {
      recommendation = 'REJECT';
    }

    return {
      ...result,
      isQuarantined,
      canRetry,
      recommendation,
    };
  }

  /**
   * FP-013: Validate with strict schema (no fallback)
   * Used by: outbound document creation (must match spec exactly)
   */
  async validateStrict(xml: string): Promise<DocumentValidationResult> {
    const result = await this.registry.validate(xml);

    return {
      ...result,
      isQuarantined: false,
      canRetry: false,
      recommendation: result.valid ? 'ACCEPT' : 'REJECT',
    };
  }

  /**
   * FP-013: Get schema statistics (for monitoring)
   */
  getSchemaStats(): {
    schemas: Array<{
      version: string;
      hits: number;
      deprecated: boolean;
      supportedUntil?: Date;
    }>;
    primaryVersion: string;
    fallbackChain: string[];
  } {
    const allStats = this.registry.getStats();

    return {
      schemas: allStats.map((s) => ({
        version: s.version,
        hits: s.hits,
        deprecated: s.deprecated,
        supportedUntil: s.supportedUntil,
      })),
      primaryVersion: this.config.primaryVersion,
      fallbackChain: this.config.fallbackChain,
    };
  }

  /**
   * FP-013: Initialize validator (load all schema versions)
   */
  async initialize(
    schemas: Array<{ version: string; xsdPath: string; deprecated?: boolean }>,
  ): Promise<void> {
    for (const schema of schemas) {
      await this.registry.register(schema.version, schema.xsdPath, {
        deprecated: schema.deprecated || false,
      });
    }
    this.applyConfig();
  }
}
