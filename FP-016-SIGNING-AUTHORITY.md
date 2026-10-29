# FP-016: Signing provider и authority validation

**Status:** ⚠️ PARTIAL — binding, certificate/authority checks and RSA verification done and tested; the RSA raw-signature format of NCALayer and real НУЦ certificate profiles are not yet confirmed on live keys
**Date:** 2026-10-29
**Backlog:** ESF · P0 · deps FP-008, FP-011, FP-013 · acceptance: *Exact bytes hash; сертификат/назначение/полномочия/expiry; stale approval блокируется; нет key в логах*

## Where

- `apps/api/src/modules/accounting/esf/esf-signing.ts` — **new**: signing requests, certificate inspection, signer policy, RSA verification, evidence.
- `esf.service.ts`: `signData` / `actionData` issue a signing request; `upload` / `action` call `checkSignatures` **before any network call** to ИС ЭСФ.
- `apps/web/.../EsfView.vue` passes `signingToken` back.
- `main.ts` + `deploy/`: `ESF_SIGNING_SECRET` (≥ 32 chars) is required in production.

## Acceptance → evidence

`esf-signing.spec.ts` (18 unit tests) and `accounting-esf.int-spec.ts` (real Postgres, test certificates generated with `openssl`).

- **Exact bytes hash.** The signing request is an HMAC token over organization, user, kind (`INVOICE` / `ACTION`), subject (invoice id / action + ids), the SHA-256 of the exact UTF-8 bytes, and expiry. On upload, the hash of the bytes that will be sent must match it. For RSA keys, the raw signature itself is also verified over those bytes (`SHA256withRSA`): a signature of other bytes, or by another key → `ESF_SIGNATURE_INVALID`.
- **Certificate: purpose, authority, expiry.**
  - Validity at signing time.
  - KeyUsage must contain `nonRepudiation`: a signing key, not AUTH; no KeyUsage → refused.
  - The IIN from `serialNumber=IIN…` must equal the signer in the ESF settings.
  - For `COMPANY` signatures, `OU=BIN…` must equal the organization's BIN.
  - Any problem → `ESF_SIGNER_NOT_AUTHORIZED` with the list of reasons.
- **Stale approval is blocked.**
  - The document was rebuilt after it was handed out for signing, or the revoke reason changed → `ESF_STALE_SIGNATURE`.
  - The request expired (15 min) → `ESF_SIGN_REQUEST_EXPIRED`.
  - Another user, another document or action, a forged token, or a token from another server → `ESF_SIGN_REQUEST_INVALID`.
  - The integration test proves that **no** `syncInvoice` / revoke call reaches ИС ЭСФ in these cases.
- **No key in logs.**
  - A private key pasted as the certificate → `ESF_CERT_PRIVATE_KEY`, with no key bytes in the error.
  - The audit log stores evidence only: certificate serial and SHA-256, IIN/BIN, `validTo`, KeyUsage, key type, verification result and bytes hash — never the signature or the certificate body. The test checks the stored audit row.

Also fixed: `signData` returned invoices in database order, not in the requested order. That made the end-to-end test flaky in a full run.

## Not done / open — confirm with real НУЦ test keys

- **RSA format is an assumption.** RSA verification assumes NCALayer raw signing is PKCS#1 v1.5 `SHA256withRSA` over the UTF-8 bytes. If that is wrong, sending fails loudly (`ESF_SIGNATURE_INVALID`), it is not sent silently. Confirm on the first live НУЦ test key.
- **GOST keys** cannot be verified by Node: the result is `VERIFICATION_PENDING` and ИС ЭСФ remains the verifier. No OCSP/CRL check yet; per spec that is `verification_pending`, never `valid`.
- **Certificate field formats are not confirmed on real НУЦ certificates:** the IIN/BIN subject format (`serialNumber=IIN…`, `OU=BIN…`) and the use of `nonRepudiation` to tell signing keys from AUTH keys.
- **Signer authority** is "the IIN configured in ESF settings + the organization's BIN". Per-user signing grants (FP-008) and FP-029 approvals are not modelled; the endpoint still requires `acc.esf.send`.
- **The session login** (`openSession`, AUTH key over the ticket) is unchanged and not in scope.
- **Deployment:** existing servers must add `ESF_SIGNING_SECRET` to `/opt/flowpos/shared/api.env` **before** updating, or the API will refuse to start.
