-- FP-024: неразобранные входящие из временного карантина FP-022 (журнал ESF_INBOUND_UNPARSED) → таблица карантина.
-- Идемпотентно (ON CONFLICT). Пропускаются те, что уже есть в реестре. Тело в журнале могло быть обрезано до 1 МБ —
-- повторная обработка сверяет sha256 и не использует неполное тело.
INSERT INTO esf_inbound_quarantine (id, organization_id, environment, esf_id, registration_number, invoice_status, body,
  body_hash, body_bytes, error_code, error_detail, first_seen_at, last_seen_at, trace_id)
SELECT gen_random_uuid()::text, a.organization_id, COALESCE(a.after->>'environment', 'TEST'), a.entity_id::bigint,
  a.after->>'registrationNumber', a.after->>'invoiceStatus', COALESCE(a.after->>'body', ''), a.after->>'bodySha256',
  COALESCE((a.after->>'bodyBytes')::int, 0), 'ESF_IN_LEGACY', a.after->>'error', a.ts, a.ts, a.trace_id
FROM audit_log a
WHERE a.action = 'ESF_INBOUND_UNPARSED' AND a.organization_id IS NOT NULL AND a.entity_id ~ '^[0-9]{1,18}$'
  AND a.after->>'bodySha256' IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM esf_invoices i WHERE i.organization_id = a.organization_id AND i.direction = 'INBOUND'
                  AND i.esf_id = a.entity_id::bigint)
ON CONFLICT (organization_id, environment, esf_id, body_hash) DO NOTHING;
