# FP-015: Serializer исходящего документа

**Status:** ⚠️ PARTIAL — serializer + checks done against the official InvoiceV2 XSD; golden XML is our own baseline, not yet confirmed by the KGD stand (FP-023)
**Date:** 2026-10-29
**Backlog:** ESF · P0 · deps FP-011, FP-013, FP-029 · acceptance: *Golden XML по XSD; версии формы; totals/rounding; no silent truncation*

## Where

The real outbound ESF path is in `apps/api` (NestJS + Prisma), not in the local `erp/esf-stand`:

- `apps/api/src/modules/accounting/esf/invoice-serializer.ts` — **new**: `validateInvoiceV2`, the `FORM_VERSIONS` registry, `serializeInvoice`.
- `invoice-xml.ts` — existing `buildInvoiceV2` (element order = XSD `xs:sequence`), unchanged.
- `esf.service.ts` → `prepare()` now builds the body **only** via `serializeInvoice`. Validation errors become `AccError` with a path to each field.

## Acceptance → evidence (`invoice-serializer.spec.ts`, 24 tests; `accounting-esf.int-spec.ts` still green)

- **Golden XML per XSD.** `test/fixtures/esf/golden/invoice-v2-ordinary.xml` and `invoice-v2-additional.xml` are compared byte for byte and validated with `xmllint --schema invoice_v2.xsd --nonet`. A negative test proves `xmllint` really rejects a broken document. The official XSD files are pinned by sha256: if KGD changes the schema, the test fails and the goldens must be rechecked, not regenerated blindly (`UPDATE_GOLDEN=1` only after review).
- **Form versions.** `FORM_VERSIONS` holds only `InvoiceV2`. Any other version, including prototype keys, raises `ESF_FORM_VERSION_UNSUPPORTED`. The result carries `{ version, xml, sha256 }`.
- **Totals and rounding.** All arithmetic is in tiyn (BigInt), never float:
  - each line: with VAT = without VAT + VAT, exactly;
  - VAT matches the rate within 1 tiyn (the rounding of VAT extraction from the gross amount);
  - no rate → VAT = 0; the rate is an integer;
  - totals = sum of lines, exactly; excise total = 0, since lines have no excise;
  - negative amounts only in an additional ESF; the sign of the quantity matches the sign of the amount.
- **No silent truncation.**
  - More than 2 (money) or 6 (quantity/price) decimal places, more than 17/18 digits, `operatorFullname` longer than 200 or empty, XML-illegal control characters, or a bad number/date/BIN/code format → each is an error, never rounding or cutting.
  - Fixed in `esf.service`: line amounts were rounded with `toFixed(2)` and quantities with `toDecimalPlaces(6)`; now they pass through unchanged and the checker rejects them. A previously possible defect: an empty `operatorFullname` made `el()` drop a required element, so the XML broke the XSD.
  - After building, the XML is parsed back and lines and totals are compared with the input (`ESF_SERIALIZATION_MISMATCH`).

## Not done / open

- **The goldens are ours.** Proof that ИС ЭСФ accepts them belongs to FP-023 (sandbox pilot).
- **FLK business rules of ИС ЭСФ beyond the XSD** are not known: limits on text lengths without `maxLength`, combinations of `truOriginCode` with declarations, and so on. They are not invented here.
- **FP-029 (approvals bound to hash/sum/TTL) does not exist yet.** The serializer returns `sha256` for it to bind to.
- **The form version is not stored on the `esfInvoice` row** (needs a Prisma migration); today it is the `INVOICE_VERSION` constant.
- **The unit price** (G 10) is derived as net/qty and rounded half-up to 6 places; the XSD allows this.
- **18 tests in `apps/api` fail before and after this change**, all in `pos`, `catalog/items` and `auth`. They are unrelated to ESF and not fixed here.
