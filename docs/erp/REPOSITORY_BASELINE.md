# Repository baseline · 27 October 2026

Target: `erlandarvichev-debug/moysklad-flowpos`, default branch `main`.
Read-only GitHub branch API and `git ls-remote` both returned `e87ab0bd3cab1a130fdc114078d772200d3223b1` at this run. This was verified afresh; the same SHA being present in an earlier report was not treated as proof of freshness.

Isolated clone: `C:\Users\123\Documents\Codex\2026-10-27\task\flowpos-esf`; local branch `codex/esf-local-20261027`. No push, PR, installer launch, production migration or deploy.

Existing working POS checkout `D:\rmkFlowpos` has origin `https://github.com/zhandos38/rmk.git`, same committed SHA, and 10 modified files (ARCHITECTURE.md, latest.json, package.json, Cargo.lock, Cargo.toml, tauri.conf.json, moyskladBackoffice.provider.ts, moyskladCashOrders.service.ts, moyskladShipment.service.ts, updater.json). Those changes were neither copied into the implementation nor edited. No live POS database or secrets were read. A second unused no-checkout clone exists under `task/flowpos-local`; it contains only git objects and no new implementation.

`git ls-tree -r HEAD -- AGENTS.md .agents .codex` returned no repository rules. No parent AGENTS.md found in task, Codex or Documents directory. Thus there are no repository `.agents/skills` at this verified baseline. Runtime documents and Library skills were read and applied.

## Verified stack and paths

Vue 3 / TypeScript 5.6 / Vite 6 / Pinia / PrimeVue, Tauri 2 + Rust, SQLite. Manifest app version 0.2.90. ARCHITECTURE.md contains old version claims; manifest is authoritative for this baseline. Root package-lock had stale project version 0.2.49; npm normalized that metadata when adding Node types, no application version bump.

| Concern | Verified source | Implication / owner |
| --- | --- | --- |
| Sale orchestration | src/services/sale.service.ts `commitSale` | ReKassa/Pulsar calls precede local save; durable intent is future FP-002, not fixed by this ESF stand |
| Local write | src/repos/ordersRepo.ts; src/services/ordersMigrate.service.ts | Header/items/payments are separate calls; Rust single-connection atomic command is required |
| SQLite | src/services/db.service.ts; src/lib/noCrossCallTransactions.test.ts; src-tauri/tests/sqlite_pool_transactions.rs | JS BEGIN/COMMIT across pool calls must not be reintroduced |
| Payment uncertainty | src/services/terminalPayment.service.ts | Preserve UNKNOWN vs confirmed rejection semantics |
| Export | src/services/orderExport.service.ts; orderExportScheduler.ts | Existing retries and completeness guards preserved; posSyncId not replaced |
| Provider | src/services/backoffice/backofficeProvider.ts; types.ts | Current providers moysklad / one_c; canonical ERP provider remains backlog |
| Direct coupling | sale.service.ts and kiosk.service.ts import MoySklad stock operations | Need gradual anti-corruption layer, not URL replacement |
| Migration | src/services/migrate.service.ts / ordersMigrate.service.ts | Existing POS migrations untouched; stand DB is separate and synthetic |

## Data ownership during transition

POS owns local intent, offline snapshot and hardware interaction. Existing selected backoffice remains authoritative for its current catalog/stock until organization-specific cutover. ERP will own canonical documents, ledger, cost layers, payroll and reporting once each module is accepted. IS ESF owns external registration/status; downloading one invoice does not establish physical receipt, ledger posting, VAT credit or recipient business consent. External IDs are mappings, never core product identities. A migrated device preserves operation_id; device_id is provenance only.

## Actual validation

`npm ci --ignore-scripts` succeeded. First sandbox Vitest run failed because transformed files under its temporary sandbox path could not be read. Read-only rerun outside sandbox: 42 suites / 230 tests passed. `npm run build` passed (large chunk warning). ESF tests and Node typecheck are in evidence. No hardware, real fiscal operator, live ESF portal, PostgreSQL or power-off test was executed. Static source review and fault injection do not prove survival of physical power failure.

4 inherited npm advisories were reported (2 moderate, 2 high); no automatic dependency upgrade was performed. See audit report and release backlog.
