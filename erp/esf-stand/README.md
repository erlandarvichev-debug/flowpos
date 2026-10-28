# FlowPOS ESF local stand

SYNTHETIC ONLY. No network gateway, real signature, credential loading, legal acceptance, stock posting or VAT credit. All HTTP routes are our internal stand API, not methods of IS ESF.

Requires Node 24.17+ (built-in TypeScript stripping and experimental `node:sqlite`). From repository root:

```
node --test erp/esf-stand/core.node-test.ts
node erp/esf-stand/server.ts
```

Open http://127.0.0.1:14840. Synthetic SQLite lives only under `erp/esf-stand/.local-stand/`, ignored by Git. Use test data only. It is intentionally a single-process, loopback prototype; do not expose it via proxy or public interface. Process startup rejects `FLOWPOS_ESF_MODE` other than `synthetic`. Code contains no live send implementation.

Receive a fixture twice to see dedup. Create outbound draft, approve synthetic hash for two minutes, send to get UNKNOWN, reconcile to obtain a synthetic registered result. No real cryptographic signing occurs. A sending record left by a crash recovers to UNKNOWN and cannot resend.

Principal comes from a fixed server-side fixture AuthProvider. Select stand-org (operator) or stand-org-b (read-only); organization header is only a selector checked against server grants. Client tenant/principal fields are rejected. Production requires authenticated scope resolution, RBAC, PostgreSQL/RLS, verified WSDL/XSD and transport, certificate/authority validation and an approved test protocol. Browser approval here is NOT a legal signature or recipient business acceptance.

Changing device does not change the stable operation ID. Same tenant + organization + operation ID returns the same document; changing its payload returns a conflict. Inbound identity is tenant + organization + external ID + revision. Raw XML is preserved byte-for-byte as UTF-8 string for these synthetic fixtures, hashed, never parsed. Real ingestion must preserve original binary bytes and encoding before decoding.

Limits: local SQLite lease/fencing is tested across processes, but no distributed production worker scheduler/HA, signing provider stub, no official XML validation, no live portal test, no payroll/accounting implementation, 200-row journal cap, no full production auth or backup system. See `docs/erp/` for target design, backlog, contracts and acceptance gates. Existing POS startup/router/provider paths are untouched.

Stage 2: schema v2 upgrades old local synthetic DB atomically. Active SENDING is retained across second-process startup; only expired leases recover UNKNOWN. Fenced callbacks cannot overwrite reconciliation. Version is required on API transitions. PostgreSQL SQL migrations/tests are in erp/postgres and tools/test_esf_postgres.py, separately from the SQLite HTTP runtime. See docs/erp/STAGE2.md.
