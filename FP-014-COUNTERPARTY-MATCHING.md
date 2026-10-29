# FP-014: Сопоставление товара контрагента и оснований

**Status:** ⚠️ PARTIAL — logic and acceptance tests done on the local stand; real catalog (FP-025) and normalization of official ESF lines not connected
**Date:** 2026-10-29
**Backlog:** ESF · P1 · deps FP-012, FP-025 · acceptance: *Manual override audited; receipt не создаёт stock/VAT; correction chain сохранена*

## What it does

`erp/esf-stand/matching.ts` — `EsfMatchingService` proposes, for a **received** inbound ESF (`state = RECEIVED`), which of our catalog items each counterparty line is, and which contract/supply is the document basis. Every proposal has a confidence and a status; people make the decisions.

| Rule | Status | Confidence |
|---|---|---|
| Learned counterparty code (BIN + seller code), unit matches | `AUTO_MATCHED` | 1.0 |
| Unique barcode, unit matches | `AUTO_MATCHED` | 0.9 |
| Learned code / barcode, but unit differs | `REVIEW_REQUIRED` | ≤ 0.5 |
| Ambiguous barcode or name; unique name only | `REVIEW_REQUIRED` | 0–0.6 |
| Nothing found | `UNMATCHED` | 0 |
| Basis: exactly one contract/supply → `AUTO_MATCHED`; several → `REVIEW_REQUIRED`; none → `UNMATCHED` | | |

A name alone never auto-decides.

## Acceptance criteria → evidence (`matching-test.ts`, 19 tests)

- **Manual override is audited.** `overrideLine` / `overrideBasis` require a human `actorId` (not `system-*`), a reason (≥ 3 chars), an existing item/basis in the same org, and `expectedVersion`. Each one writes `esf_match_history` (from → to, status, actor, reason) and an `audit` event. History is append-only: SQLite triggers abort UPDATE/DELETE. "Remember" (learn a counterparty code) is explicit, audited (`COUNTERPARTY_MAP_LEARNED`) and scoped to that seller's BIN.
- **Receipt creates no stock/VAT.** Matching changes neither the document's state, version nor hash, and writes nothing to `approvals`/`jobs`. The schema has no stock/ledger/VAT tables or triggers. `summary().readyForReceiptCommand` only says that every line and the basis have a decision; the receipt itself must be a separate command with a snapshot and rights (not part of FP-014). `accountingEffect` is always `'NONE'`.
- **Correction chain preserved.** A correction (`correctionOf` → original `externalId`) inherits **decided** matches for lines whose identity (seller code, barcode, name, unit) did not change; quantity may change. Changed lines, undecided lines and a different counterparty are re-matched. Overriding the correction never changes the original (snapshot compared). `chain()` returns original → … → latest from any member.

Also covered: idempotent `match` (same input → same result; different input → `MATCH_INPUT_CONFLICT`), quarantined/outbound documents refused, input validation (BIN, line numbers, quantity, basis date), tenant/org isolation, including foreign catalog items.

## Storage

Local SQLite migration **v3** (`sqliteMigrations.ts`): `esf_match_input`, `esf_match_line`, `esf_match_basis`, `esf_match_history` (append-only), `esf_counterparty_item_map`. All rows carry `tenantId`/`orgId`; line/basis/input tables have a composite FK to `documents`.

## Not done / open

- **FP-025 catalog does not exist.** `CatalogLookup` and `BasisLookup` are narrow ports; the tests use in-memory fakes. Real implementations must scope by tenant+org.
- **The caller supplies normalized lines** (`NormalizedInbound`). Parsing the official ESF XML into lines depends on the official XSD (FP-011) and stored raw bytes (FP-013 gap).
- **НКТ/ТН ВЭД codes and units of measure** are compared as text only; there is no unit conversion table yet.
- **Several corrections of the same original:** `chain()` follows the first one found; branching chains are not modelled.
- **No UI** (FP-020) and no Postgres/RLS version (FP-009).
