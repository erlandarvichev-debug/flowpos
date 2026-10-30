-- FP-009: у записей outbox есть клиент (для RLS и для отправки только в подключения этого клиента).
-- Существующие записи: клиент документа или подключения; иначе — единственный клиент; иначе — стоп.
DO $$
DECLARE
  n bigint;
  tenants_n int;
BEGIN
  IF to_regclass('public.outbox') IS NULL THEN
    RETURN;
  END IF;
  ALTER TABLE outbox ADD COLUMN IF NOT EXISTS tenant_id text;
  UPDATE outbox o SET tenant_id = d.tenant_id FROM documents d WHERE o.tenant_id IS NULL AND o.entity = 'document' AND d.id = o.local_id;
  UPDATE outbox o SET tenant_id = org.tenant_id FROM onec_connections c JOIN organizations org ON org.id = c.organization_id
   WHERE o.tenant_id IS NULL AND c.id = o.connection_id;
  SELECT count(*) INTO tenants_n FROM tenants;
  IF tenants_n = 1 THEN
    UPDATE outbox SET tenant_id = (SELECT id FROM tenants) WHERE tenant_id IS NULL;
  END IF;
  SELECT count(*) INTO n FROM outbox WHERE tenant_id IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'FP-009: % записей outbox без клиента (клиентов: %). Назначьте: UPDATE outbox SET tenant_id = ''<id клиента>'' WHERE tenant_id IS NULL; или удалите обработанные (status = ''DONE'')', n, tenants_n;
  END IF;
END $$;
