/**
 * FP-013 Phase 1: XML Schema Registry
 * Manages multiple XSD schema versions with caching & fallback
 *
 * Features:
 * - Register multiple schema versions (v2, v3, v4...)
 * - Auto-detect version from XML
 * - Validate with detected or primary schema
 * - Fallback chain (v3 → v2 → v4)
 * - Cache loaded schemas
 * - Track statistics (hits, deprecation)
 */

import { RealEsfSchema, type ValidationResult } from './schema.real.ts';

export interface SchemaMetadata {
  version: string; // "v2", "v3", "v4"
  xsdPath: string; // path to XSD file
  rootElement: string; // "Invoice"
  namespace: string; // XML namespace
  deprecated: boolean; // true if deprecated
  supportedUntil?: Date; // end of support date
}

export interface SchemaCache {
  version: string;
  schema: RealEsfSchema;
  metadata: SchemaMetadata;
  loadedAt: Date;
  hits: number; // cache hit count
}

export interface SchemaStats {
  version: string;
  hits: number;
  lastUsed: Date;
  deprecated: boolean;
  supportedUntil?: Date;
}

export interface ValidationResultWithMetadata extends ValidationResult {
  usedVersion?: string;
  fallback?: boolean;
  detectedVersion?: string;
  quarantined?: boolean;
}

/**
 * FP-013: Schema Registry
 * Manages multiple schema versions with validation & fallback
 */
export class SchemaRegistry {
  private schemas: Map<string, SchemaCache> = new Map();
  private defaultVersion: string = 'v3';
  private fallbackChain: string[] = ['v3', 'v2', 'v4']; // primary → fallbacks

  /**
   * FP-013: Register a schema version
   */
  async register(
    version: string,
    xsdPath: string,
    metadata?: Partial<SchemaMetadata>,
  ): Promise<void> {
    if (this.schemas.has(version)) {
      throw new Error(`Schema version ${version} already registered`);
    }

    // Load XSD
    let schema: RealEsfSchema;
    try {
      schema = new RealEsfSchema(xsdPath);
    } catch (error: any) {
      throw new Error(`Failed to load schema ${version}: ${error.message}`);
    }

    // Create cache entry
    const cache: SchemaCache = {
      version,
      schema,
      metadata: {
        version,
        xsdPath,
        rootElement: 'Invoice',
        namespace: 'http://es.lk.kz/schema/invoice',
        deprecated: false,
        ...metadata,
      },
      loadedAt: new Date(),
      hits: 0,
    };

    this.schemas.set(version, cache);
  }

  /**
   * FP-013: Detect schema version from XML
   * Looks for schemaVersion="v3" attribute
   */
  detectVersion(xml: string): string | null {
    // Pattern: schemaVersion="v3" or schemaVersion='v3'
    const match = xml.match(/schemaVersion\s*=\s*["']([^"']+)["']/i);
    return match ? match[1] : null;
  }

  /**
   * FP-013: Validate with detected version
   * Returns UNKNOWN if version not found
   */
  async validate(xml: string): Promise<ValidationResultWithMetadata> {
    const detectedVersion = this.detectVersion(xml) ?? undefined;
    const versionToUse = detectedVersion || this.defaultVersion;

    const cache = this.schemas.get(versionToUse);

    if (!cache) {
      return {
        valid: false,
        errors: [
          `Schema version ${versionToUse} not registered`,
          detectedVersion
            ? `Detected: ${detectedVersion}, Available: ${Array.from(this.schemas.keys()).join(', ')}`
            : `Default version ${this.defaultVersion} not registered`,
        ],
        warnings: [],
        usedVersion: versionToUse,
        detectedVersion,
      };
    }

    cache.hits++;

    const result = cache.schema.validate(xml);

    return {
      ...result,
      usedVersion: versionToUse,
      detectedVersion,
      fallback: false,
    };
  }

  /**
   * FP-013: Validate with fallback chain
   * Try: detected → v3 → v2 → v4 → QUARANTINE
   */
  async validateWithFallback(xml: string): Promise<ValidationResultWithMetadata> {
    const detectedVersion = this.detectVersion(xml) ?? undefined;

    // 1. Try detected version
    let detectedResult: ValidationResult | null = null;
    if (detectedVersion && this.schemas.has(detectedVersion)) {
      const cache = this.schemas.get(detectedVersion)!;
      detectedResult = cache.schema.validate(xml);

      if (detectedResult.valid) {
        cache.hits++;
        return {
          ...detectedResult,
          usedVersion: detectedVersion,
          detectedVersion,
          fallback: false,
          quarantined: false,
        };
      }
    }

    // 2. Try primary → fallback chain
    for (const version of this.fallbackChain) {
      const cache = this.schemas.get(version);

      if (!cache) {
        continue; // Skip if not registered
      }

      try {
        const result = cache.schema.validate(xml);

        if (result.valid) {
          cache.hits++;
          return {
            ...result,
            usedVersion: version,
            detectedVersion,
            fallback: true,
            quarantined: false,
          };
        }
      } catch (error) {
        // Continue to next fallback on error
        continue;
      }
    }

    // 3a. Known schema, invalid content → plain rejection with that schema's errors.
    if (detectedResult) {
      return {
        ...detectedResult,
        usedVersion: detectedVersion!,
        detectedVersion,
        fallback: false,
        quarantined: false,
      };
    }

    // 3b. Unknown or undeclared schema that matches nothing → QUARANTINE
    return {
      valid: false,
      errors: [
        'Document does not match any registered schema version',
        `Tried versions: ${this.fallbackChain.filter((v) => this.schemas.has(v)).join(', ')}`,
        'Status: QUARANTINED (manual review required)',
      ],
      warnings: [],
      usedVersion: undefined,
      detectedVersion,
      fallback: false,
      quarantined: true,
    };
  }

  /**
   * FP-013: Get statistics for schema(s)
   */
  getStats(version?: string): SchemaStats[] {
    if (version) {
      const cache = this.schemas.get(version);
      return cache ? [this.cacheToStats(cache)] : [];
    }

    return Array.from(this.schemas.values()).map((c) =>
      this.cacheToStats(c),
    );
  }

  /**
   * FP-013: Set default version (for unknown documents)
   */
  setDefaultVersion(version: string): void {
    if (!this.schemas.has(version)) {
      throw new Error(`Version ${version} not registered`);
    }
    this.defaultVersion = version;
  }

  /**
   * FP-013: Set fallback chain order
   */
  setFallbackChain(versions: string[]): void {
    // Validate all versions exist
    for (const version of versions) {
      if (!this.schemas.has(version)) {
        throw new Error(`Version ${version} not registered`);
      }
    }
    this.fallbackChain = versions;
  }

  /**
   * FP-013: List registered versions
   */
  listVersions(): string[] {
    return Array.from(this.schemas.keys());
  }

  /**
   * FP-013: Get schema info
   */
  getSchemaInfo(version: string): SchemaMetadata | null {
    const cache = this.schemas.get(version);
    return cache ? cache.metadata : null;
  }

  /**
   * FP-013: Internal: convert cache to stats
   */
  private cacheToStats(cache: SchemaCache): SchemaStats {
    return {
      version: cache.version,
      hits: cache.hits,
      lastUsed: cache.loadedAt,
      deprecated: cache.metadata.deprecated,
      supportedUntil: cache.metadata.supportedUntil,
    };
  }
}

/**
 * FP-013: Mock Schema Registry (for testing)
 */
export class MockSchemaRegistry {
  private schemas: Map<string, SchemaStats> = new Map();
  private defaultVersion = 'v3';

  async register(
    version: string,
    xsdPath: string,
    metadata?: Partial<SchemaMetadata>,
  ): Promise<void> {
    this.schemas.set(version, {
      version,
      hits: 0,
      lastUsed: new Date(),
      deprecated: metadata?.deprecated || false,
      supportedUntil: metadata?.supportedUntil,
    });
  }

  detectVersion(xml: string): string | null {
    const match = xml.match(/schemaVersion\s*=\s*["']([^"']+)["']/i);
    return match ? match[1] : null;
  }

  async validate(xml: string): Promise<ValidationResultWithMetadata> {
    const version = this.detectVersion(xml) || this.defaultVersion;

    if (!this.schemas.has(version)) {
      return {
        valid: false,
        errors: [`Schema ${version} not registered`],
        warnings: [],
        usedVersion: version,
      };
    }

    const stat = this.schemas.get(version)!;
    stat.hits++;

    return {
      valid: true,
      errors: [],
      warnings: [],
      usedVersion: version,
      detectedVersion: this.detectVersion(xml) ?? undefined,
    };
  }

  async validateWithFallback(xml: string): Promise<ValidationResultWithMetadata> {
    const version = this.detectVersion(xml) || this.defaultVersion;

    if (!this.schemas.has(version)) {
      // Fallback to default
      return this.validate(xml);
    }

    return this.validate(xml);
  }

  getStats(version?: string): SchemaStats[] {
    if (version) {
      return this.schemas.get(version) ? [this.schemas.get(version)!] : [];
    }

    return Array.from(this.schemas.values());
  }

  setDefaultVersion(version: string): void {
    if (!this.schemas.has(version)) {
      throw new Error(`Version ${version} not registered`);
    }
    this.defaultVersion = version;
  }

  setFallbackChain(versions: string[]): void {
    // no-op for mock
  }

  listVersions(): string[] {
    return Array.from(this.schemas.keys());
  }

  getSchemaInfo(version: string): SchemaMetadata | null {
    if (!this.schemas.has(version)) {
      return null;
    }

    return {
      version,
      xsdPath: `./Invoice_${version}.xsd`,
      rootElement: 'Invoice',
      namespace: 'http://es.lk.kz/schema/invoice',
      deprecated: false,
    };
  }
}
