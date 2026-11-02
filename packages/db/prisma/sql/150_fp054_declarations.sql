-- FP-054: декларации. Черновик меняется/удаляется; готовая (FINAL) — содержимое неизменно, дальше только статус сдачи
-- (FINAL → SUBMITTED → ACCEPTED | REJECTED) с квитанцией. Исправление — новая дополнительная декларация. Идемпотентно.
CREATE OR REPLACE FUNCTION fp_tax_declaration_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'DRAFT' OR fp_stock_maintenance() THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'ACC_IMMUTABLE: готовая декларация не удаляется — подайте дополнительную' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'DRAFT' THEN RETURN NEW; END IF;
  IF (NEW.organization_id, NEW.form, NEW.year, NEW.period, NEW.kind, NEW.previous_id, NEW.register_id, NEW.pack_id, NEW.pack_version,
      NEW.header, NEW.lines, NEW.checks, NEW.content_hash, NEW.created_by, NEW.created_at, NEW.finalized_by, NEW.finalized_at)
     IS DISTINCT FROM (OLD.organization_id, OLD.form, OLD.year, OLD.period, OLD.kind, OLD.previous_id, OLD.register_id, OLD.pack_id, OLD.pack_version,
      OLD.header, OLD.lines, OLD.checks, OLD.content_hash, OLD.created_by, OLD.created_at, OLD.finalized_by, OLD.finalized_at)
     OR NOT ((OLD.status = 'FINAL' AND NEW.status IN ('FINAL', 'SUBMITTED'))
          OR (OLD.status = 'SUBMITTED' AND NEW.status IN ('SUBMITTED', 'ACCEPTED', 'REJECTED'))
          OR (OLD.status = NEW.status AND NEW.receipt IS NOT DISTINCT FROM OLD.receipt AND NEW.submitted_at IS NOT DISTINCT FROM OLD.submitted_at)) THEN
    RAISE EXCEPTION 'ACC_IMMUTABLE: готовая декларация не меняется — подайте дополнительную' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS fp_tax_declaration_guard_trg ON tax_declarations;
CREATE TRIGGER fp_tax_declaration_guard_trg BEFORE UPDATE OR DELETE ON tax_declarations FOR EACH ROW EXECUTE FUNCTION fp_tax_declaration_guard();
CREATE UNIQUE INDEX IF NOT EXISTS tax_declarations_one_draft ON tax_declarations (organization_id, form, year, period) WHERE status = 'DRAFT';
