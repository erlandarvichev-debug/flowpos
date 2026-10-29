# FP-013: XML Schema Registry

**Status:** ⚠️ PARTIAL — registry + validator work and are tested on real classes; immutable raw bytes/checksum not implemented  
**Date:** 2026-10-29  
**Target:** Dynamic schema versioning & management

---

## Overview

FP-013 implements a **schema version registry** for managing multiple XSD versions:
- ✅ Multiple schema versions (v2, v3, v4...)
- ✅ Dynamic schema loading & caching
- ✅ Unknown format detection
- ✅ Graceful fallback handling
- ✅ Schema metadata (version, compatibility)

---

## Problem Statement

Current state (FP-011):
```typescript
const schema = new RealEsfSchema('./Invoice_v3.xsd');
// Single hard-coded version
// No fallback for unsupported versions
// No version detection from document
```

Desired state (FP-013):
```typescript
const registry = new SchemaRegistry();
await registry.register('v3', './Invoice_v3.xsd');
await registry.register('v2', './Invoice_v2.xsd');

// Auto-detect version from document
const validation = await registry.validate(xml);

// Graceful degradation
const result = await registry.validateWithFallback(xml);
// → v3 schema if detected
// → v2 schema if v3 fails
// → QUARANTINE if all fail
```

---

## Architecture

```
┌──────────────────────────────────────────┐
│ SchemaRegistry                           │
├──────────────────────────────────────────┤
│                                          │
│ Schemas:                                 │
│  ├─ v2 → RealEsfSchema (Invoice_v2.xsd)│
│  ├─ v3 → RealEsfSchema (Invoice_v3.xsd)│
│  └─ v4 → RealEsfSchema (Invoice_v4.xsd)│
│                                          │
│ Methods:                                 │
│  ├─ register(version, path)             │
│  ├─ detectVersion(xml) → string         │
│  ├─ validate(xml) → ValidationResult    │
│  ├─ validateWithFallback(xml)           │
│  └─ getSchemaInfo(version)              │
│                                          │
│ Cache:                                   │
│  └─ loaded schemas + metadata           │
└──────────────────────────────────────────┘
```

---

## Core Components

### 1. Schema Metadata

```typescript
export interface SchemaMetadata {
  version: string; // "v2", "v3", "v4"
  xsdPath: string; // path to XSD file
  rootElement: string; // "Invoice"
  namespace: string; // XML namespace
  deprecated: boolean; // v2 is deprecated
  supportedUntil?: Date; // end of support
}
```

### 2. Schema Registry

```typescript
export class SchemaRegistry {
  async register(version: string, xsdPath: string): Promise<void> {
    // Load + cache XSD
    // Parse metadata
    // Add to registry
  }

  async validate(xml: string): Promise<ValidationResult> {
    // 1. Detect version from XML
    // 2. Get schema for version
    // 3. Validate
    // 4. Return result (VALID | INVALID | UNKNOWN)
  }

  async validateWithFallback(xml: string): Promise<ValidationResult> {
    // 1. Try detected version
    // 2. Try v3 (primary)
    // 3. Try v2 (fallback)
    // 4. QUARANTINE if all fail
  }

  detectVersion(xml: string): string | null {
    // Parse schemaVersion attribute
    // Return "v2", "v3", "v4", or null
  }
}
```

### 3. Schema Caching

```typescript
interface SchemaCache {
  version: string;
  schema: RealEsfSchema;
  metadata: SchemaMetadata;
  loadedAt: Date;
  hits: number; // cache hit count
}
```

---

## Implementation Plan

### Phase 1: Schema Registry Core

**File:** `schema-registry.ts`

```typescript
export class SchemaRegistry {
  private schemas: Map<string, SchemaCache> = new Map();
  private defaultVersion: string = 'v3';

  async register(
    version: string,
    xsdPath: string,
    metadata?: Partial<SchemaMetadata>,
  ): Promise<void> {
    // Load XSD
    const schema = new RealEsfSchema(xsdPath);

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

  async validate(xml: string): Promise<ValidationResult> {
    const version = this.detectVersion(xml);
    const cache = this.schemas.get(version || this.defaultVersion);

    if (!cache) {
      return {
        valid: false,
        errors: [`Schema version ${version} not found`],
        warnings: [],
      };
    }

    cache.hits++;
    return cache.schema.validate(xml);
  }

  detectVersion(xml: string): string | null {
    // Parse schemaVersion from XML
    // Example: schemaVersion="v3"
    const match = xml.match(/schemaVersion="([^"]+)"/);
    return match ? match[1] : null;
  }
}
```

### Phase 2: Fallback Validation

**File:** `schema-registry.fallback.ts`

```typescript
export class SchemaRegistry {
  async validateWithFallback(xml: string): Promise<ValidationResult> {
    // 1. Try detected version
    const detected = this.detectVersion(xml);
    if (detected) {
      const result = await this.validate(xml);
      if (result.valid) {
        return { ...result, usedVersion: detected };
      }
    }

    // 2. Try primary version (v3)
    const primaryResult = await this.validateWithVersion(xml, 'v3');
    if (primaryResult.valid) {
      return { ...primaryResult, usedVersion: 'v3', fallback: true };
    }

    // 3. Try fallback versions (v2, v4)
    for (const version of ['v2', 'v4']) {
      const result = await this.validateWithVersion(xml, version);
      if (result.valid) {
        return { ...result, usedVersion: version, fallback: true };
      }
    }

    // 4. All schemas failed → QUARANTINE
    return {
      valid: false,
      errors: [
        'Document does not match any registered schema version',
        'Quarantined: manual review required',
      ],
      warnings: [],
    };
  }

  private async validateWithVersion(
    xml: string,
    version: string,
  ): Promise<ValidationResult> {
    const cache = this.schemas.get(version);
    if (!cache) {
      return { valid: false, errors: [`Schema ${version} not registered`], warnings: [] };
    }

    try {
      return cache.schema.validate(xml);
    } catch (error: any) {
      return {
        valid: false,
        errors: [error.message],
        warnings: [],
      };
    }
  }
}
```

### Phase 3: Monitoring & Metrics

```typescript
export interface SchemaStats {
  version: string;
  hits: number;
  lastUsed: Date | null;
  deprecated: boolean;
  supportedUntil?: Date;
}

export class SchemaRegistry {
  getStats(version?: string): SchemaStats[] {
    if (version) {
      const cache = this.schemas.get(version);
      return cache ? [this.cacheToStats(cache)] : [];
    }

    return Array.from(this.schemas.values()).map((c) =>
      this.cacheToStats(c),
    );
  }

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
```

---

## Integration with FP-011

**Before (FP-011):**
```typescript
const schema = new RealEsfSchema('./Invoice_v3.xsd');
const validation = schema.validate(xml);
if (!validation.valid) quarantine(doc);
```

**After (FP-013):**
```typescript
const registry = new SchemaRegistry();
await registry.register('v2', './Invoice_v2.xsd', { deprecated: true });
await registry.register('v3', './Invoice_v3.xsd');

const validation = await registry.validateWithFallback(xml);
if (!validation.valid) {
  if (validation.errors.includes('Quarantined')) {
    // Unknown schema → quarantine
  } else {
    // Known schema but invalid → handle errors
  }
}
```

---

## Test Strategy

### Unit Tests

```typescript
describe('FP-013: Schema Registry', () => {
  it('registers multiple schema versions', async () => {
    const registry = new SchemaRegistry();
    
    await registry.register('v2', './Invoice_v2.xsd');
    await registry.register('v3', './Invoice_v3.xsd');
    
    const stats = registry.getStats();
    assert.equal(stats.length, 2);
  });

  it('detects schema version from XML', async () => {
    const registry = new SchemaRegistry();
    
    const version = registry.detectVersion(
      '<Invoice schemaVersion="v3">...</Invoice>'
    );
    
    assert.equal(version, 'v3');
  });

  it('validates with correct schema', async () => {
    const registry = new SchemaRegistry();
    await registry.register('v3', './Invoice_v3.xsd');
    
    const xml = '<Invoice schemaVersion="v3">...</Invoice>';
    const result = await registry.validate(xml);
    
    assert(typeof result.valid === 'boolean');
  });

  it('falls back to primary version on unknown', async () => {
    const registry = new SchemaRegistry();
    await registry.register('v3', './Invoice_v3.xsd');
    
    const xml = '<Invoice schemaVersion="unknown">...</Invoice>';
    const result = await registry.validateWithFallback(xml);
    
    assert(result.fallback === true);
    assert.equal(result.usedVersion, 'v3');
  });

  it('quarantines on all validation failures', async () => {
    const registry = new SchemaRegistry();
    await registry.register('v3', './Invoice_v3.xsd');
    
    const invalidXml = '<Invalid>Not an invoice</Invalid>';
    const result = await registry.validateWithFallback(invalidXml);
    
    assert(!result.valid);
    assert(result.errors.some(e => e.includes('Quarantined')));
  });
});
```

---

## Acceptance Criteria (FP-013)

- ✅ Register multiple schema versions
- ✅ Auto-detect version from document
- ✅ Validate with detected version
- ✅ Fallback to primary version (v3)
- ✅ Try multiple fallback versions
- ✅ Quarantine on all failures
- ✅ Cache schemas (performance)
- ✅ Track statistics (hits, last used)
- ✅ Support deprecated versions
- ✅ No breaking changes to FP-011

---

## What's Next

**FP-014–FP-020:** Full ESF Features  
- Reconciliation
- Corrections
- Decisions
- Document lifecycle management

---

**FP-013 Status: ⚠️ PARTIAL (audit 2026-10-29)**

Done and tested against the real classes (`esf-validator.integrated-test.ts`, 16 tests, no mocks):
- multi-version registry, version detection, fallback chain, per-version stats;
- `EsfValidatorIntegrated`: ACCEPT / REJECT / QUARANTINE;
- XXE: documents with DTD/ENTITY are never accepted (`xml-wellformed.ts`).

Fixed on 2026-10-29:
- the validator constructor threw on an empty registry → config is now applied after `initialize()`;
- QUARANTINE was never produced (case-sensitive substring match on "Quarantined") → explicit `quarantined` flag;
- a known version with invalid content was quarantined → now REJECT with that schema's errors; only unknown/undeclared schemas are quarantined;
- strict validation flagged rejects as quarantined → fixed;
- the tests exercised `MockEsfValidatorIntegrated`, and two assertions had been weakened to pass → mock removed, tests rewritten.

Not done (backlog acceptance):
- **immutable raw bytes + encoding + checksum** stored with the document;
- **"unknown schema quarantined without losing fields"** — needs raw-bytes storage;
- validation runs against the synthetic fixture only — no official XSD yet (blocked on FP-011).