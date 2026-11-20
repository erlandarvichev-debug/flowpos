-- Отсутствия: утверждённое не меняется (только отмена с причиной); утверждённые одного договора не пересекаются
-- (проверка под блокировкой строк договора — в БД, а не только в коде). Идемпотентно.
CREATE OR REPLACE FUNCTION fp_hr_absence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'DRAFT' OR fp_stock_maintenance() THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'ACC_IMMUTABLE: утверждённое отсутствие не удаляется — отмените его с причиной' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status <> 'DRAFT' THEN
    IF NOT (OLD.status = 'APPROVED' AND NEW.status = 'CANCELLED' AND coalesce(NEW.cancel_reason, '') <> '' AND NEW.cancelled_by IS NOT NULL
            AND (NEW.contract_id, NEW.kind, NEW.date_from, NEW.date_to, NEW.amount, NEW.avg_daily_wage, NEW.calc, NEW.pay_period, NEW.approved_by, NEW.approved_at)
                IS NOT DISTINCT FROM (OLD.contract_id, OLD.kind, OLD.date_from, OLD.date_to, OLD.amount, OLD.avg_daily_wage, OLD.calc, OLD.pay_period, OLD.approved_by, OLD.approved_at)) THEN
      RAISE EXCEPTION 'ACC_IMMUTABLE: утверждённое отсутствие меняется только отменой с причиной' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF NEW.date_to < NEW.date_from THEN RAISE EXCEPTION 'ABSENCE_DATES: дата окончания раньше даты начала' USING ERRCODE = 'P0001'; END IF;
  IF NEW.status = 'APPROVED' THEN
    PERFORM 1 FROM employment_contracts WHERE id = NEW.contract_id FOR UPDATE;
    IF EXISTS (SELECT 1 FROM hr_absences a WHERE a.contract_id = NEW.contract_id AND a.id <> NEW.id AND a.status = 'APPROVED'
               AND a.date_from <= NEW.date_to AND a.date_to >= NEW.date_from) THEN
      RAISE EXCEPTION 'ABSENCE_OVERLAP: отсутствия сотрудника пересекаются' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS fp_hr_absence_guard_trg ON hr_absences;
CREATE TRIGGER fp_hr_absence_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON hr_absences FOR EACH ROW EXECUTE FUNCTION fp_hr_absence_guard();
