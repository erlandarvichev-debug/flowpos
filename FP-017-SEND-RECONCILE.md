# FP-017: Отправка и reconciliation результата

**Status:** ⚠️ PARTIAL — send/UNKNOWN/reconcile/release done and tested on the real `apps/api` path (Postgres); lookup semantics of ИС ЭСФ and its processing delays are not confirmed on the live stand
**Date:** 2026-10-29
**Backlog:** ESF · P0 · deps FP-015, FP-016, FP-021 · acceptance: *Lost response/restart → UNKNOWN; status lookup доказан; нет слепого resend*

## What changed (`apps/api/src/modules/accounting/esf/esf.service.ts`)

- **Atomic claim before the network.** `upload()` moves rows `READY → SENDING` in one transaction, with `sentAt` as the claim mark, the signature and an audit entry `ESF_SEND_STARTED`. A concurrent upload of the same rows gets `ESF_STATUS`, and exactly one `syncInvoice` goes out.
- **Lost response → `UNKNOWN`.** A network error, timeout, unparseable response, generic SOAP fault, or no result for a given invoice in the response all give `UNKNOWN` with `OUTCOME_UNKNOWN`. Only failures that prove the request was not processed (session closed, access denied, security error) return the rows to `READY`.
- **Restart → `UNKNOWN`.** `recoverStaleSending()` runs in `tick()` and before reconciliation. `SENDING` older than `SEND_LEASE_MS` (5 min, with a SOAP timeout of 60 s) becomes `UNKNOWN` (`RECOVERED_UNKNOWN`), never `READY`.
- **Fencing.** Results are applied with `WHERE status='SENDING' AND sentAt=<claim>`. A late response after recovery is not applied (`fenced: true`), and reconciliation resolves the row.
- **Proven status lookup.** `UNKNOWN` (and legacy `SENT` without an id) is reconciled only via `queryInvoiceSummaryByKey` (date of issue + number, `OUTBOUND`). It counts as found only if both num and date match:
  - found → `SENT` with `esfId`; the usual status refresh continues from there;
  - not found → stays `UNKNOWN`, with an audit `ESF_RECONCILE_NOT_FOUND`.
  Reconciliation never resends.
- **No blind resend.** `UNKNOWN` cannot be prepared again (it keeps its number), signed, uploaded or discarded. `releaseUnknown()` (`POST esf/invoices/:id/release-unknown`, `acc.esf.send`) returns it to `READY` only if:
  - the operator gives a reason (≥ 5 chars);
  - there is an `ESF_RECONCILE_NOT_FOUND` entry made at least `RECONCILE_QUIET_MS` (10 min) after sending.
  The release is audited (`ESF_UNKNOWN_RELEASED` with the user, the reason and the proof id).
- **Web** (`EsfView.vue`): labels for `SENDING` / `UNKNOWN` and a "Разрешить повторную отправку" button with a reason prompt. Only typechecked, **not clicked through in a browser**.

## Evidence (`test/accounting-esf.int-spec.ts`, block FP-017: 9 scenarios; all `apps/api` integration tests 46/46, twice)

Network break; fault; session closed; partial response; parallel upload; crash recovery and a fresh lease; late result fenced; found by key with the exact request body checked (and a num match with the wrong date rejected); not found → release refused before the quiet period, then allowed with a reason. Two mutations (removing fencing; treating every failure as "not processed") make the tests fail.

## Not done / open

- **Lookup and delays are not confirmed live.** `queryInvoiceSummaryByKey` semantics and ИС ЭСФ processing delays are not confirmed on the live stand; the 10-minute quiet period is our assumption. After a release, the resend uses the same number but a new date of issue (`prepare` on sign). If the first submission still appears later, there will be two documents, which is why release is an explicit, audited operator decision.
- **The match is only by key, not by hash.** The response gives only num, date and status. Fetching the remote body to compare hashes would need an operation we have not verified (the runbook forbids inventing one).
- **No new columns.** The proof of reconciliation lives in `audit_logs`; there are no dedicated attempt/lease columns, no DLQ and no retry policy (FP-021).
- **⚠️ FP-021 and the other recent migrations need their own audit.** The FP-021 migration I wrote (`packages/db/prisma/migrations/20261029_fp021_jobs_lease_fencing`) uses SQLite trigger syntax in a PostgreSQL migration. None of the 2026-10-29 migrations (FP-002…FP-009, FP-021) has been applied to any database; the test DB is built with `db push` and has no `jobs` table. They need the same kind of audit as FP-011–013 before `prisma migrate deploy`.
