-- FP-036: журнал разнесения оплат неизменяем: можно только отменить действующую строку (ACTIVE → REVERSED с автором,
-- временем и причиной). Удаление — только при обслуживании (роль миграций). Идемпотентно.
CREATE OR REPLACE FUNCTION fp_payment_allocations_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF fp_stock_maintenance() THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'ACC_IMMUTABLE: разнесение не удаляется — отмените его' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status <> 'ACTIVE' OR NEW.status <> 'REVERSED' OR NEW.reversed_at IS NULL OR coalesce(NEW.reverse_reason, '') = ''
     OR (NEW.organization_id, NEW.payment_doc_id, NEW.payment_version, NEW.counterparty_id, NEW.account, NEW.kind, NEW.settlement_doc_id, NEW.amount, NEW.manual, NEW.created_by, NEW.created_at)
        IS DISTINCT FROM (OLD.organization_id, OLD.payment_doc_id, OLD.payment_version, OLD.counterparty_id, OLD.account, OLD.kind, OLD.settlement_doc_id, OLD.amount, OLD.manual, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'ACC_IMMUTABLE: разнесение меняется только отменой (с причиной)' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS fp_payment_allocations_guard_trg ON payment_allocations;
CREATE TRIGGER fp_payment_allocations_guard_trg BEFORE UPDATE OR DELETE ON payment_allocations FOR EACH ROW EXECUTE FUNCTION fp_payment_allocations_guard();
