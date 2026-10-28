-- Бухгалтерские инварианты на уровне БД (идемпотентно, применяется после prisma db push).
-- См. docs/accounting/INVARIANTS.md

-- I1. Одна активная запись движений на источник
CREATE UNIQUE INDEX IF NOT EXISTS acc_entries_one_active_per_source
  ON acc_entries (organization_id, source_type, source_id) WHERE status = 'ACTIVE';

-- I2. Сторона и разрез учёта — только допустимые значения, сумма не ноль
DO $$ BEGIN
  ALTER TABLE acc_postings ADD CONSTRAINT acc_postings_side_chk CHECK (side IN ('D','C'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE acc_postings ADD CONSTRAINT acc_postings_ledger_chk CHECK (ledger IN ('BU','NU'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE acc_postings ADD CONSTRAINT acc_postings_amount_nonzero CHECK (amount <> 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE acc_entries ADD CONSTRAINT acc_entries_status_chk CHECK (status IN ('ACTIVE','SUPERSEDED','CANCELLED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- I3. Дебет = Кредит в каждой записи по каждому разрезу учёта (проверка в конце транзакции)
CREATE OR REPLACE FUNCTION acc_check_entry_balance() RETURNS trigger AS $$
DECLARE
  bad record;
  eid text;
BEGIN
  eid := COALESCE(NEW.entry_id, OLD.entry_id);
  SELECT ledger, SUM(CASE WHEN side='D' THEN amount ELSE -amount END) AS diff
    INTO bad
    FROM acc_postings WHERE entry_id = eid
   GROUP BY ledger
  HAVING SUM(CASE WHEN side='D' THEN amount ELSE -amount END) <> 0
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'ACC_UNBALANCED: запись % разрез % дебет-кредит = %', eid, bad.ledger, bad.diff
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS acc_postings_balance_trg ON acc_postings;
CREATE CONSTRAINT TRIGGER acc_postings_balance_trg
  AFTER INSERT OR UPDATE OR DELETE ON acc_postings
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION acc_check_entry_balance();

-- I4. Проводки неизменяемы: запрещены DELETE и UPDATE любых полей, кроме is_active
CREATE OR REPLACE FUNCTION acc_postings_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ACC_IMMUTABLE: удаление проводок запрещено (используйте отмену/сторно)';
  END IF;
  IF (NEW.entry_id, NEW.organization_id, NEW.date, NEW.ledger, NEW.line_no, NEW.side, NEW.account_id,
      NEW.amount, NEW.currency, NEW.currency_amount, NEW.quantity)
     IS DISTINCT FROM
     (OLD.entry_id, OLD.organization_id, OLD.date, OLD.ledger, OLD.line_no, OLD.side, OLD.account_id,
      OLD.amount, OLD.currency, OLD.currency_amount, OLD.quantity) THEN
    RAISE EXCEPTION 'ACC_IMMUTABLE: изменение проводок запрещено';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS acc_postings_immutable_trg ON acc_postings;
CREATE TRIGGER acc_postings_immutable_trg
  BEFORE UPDATE OR DELETE ON acc_postings
  FOR EACH ROW EXECUTE FUNCTION acc_postings_immutable();

-- I5. История версий документа неизменяема
CREATE OR REPLACE FUNCTION acc_versions_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ACC_IMMUTABLE: история версий документа не изменяется';
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS acc_versions_immutable_trg ON acc_document_versions;
CREATE TRIGGER acc_versions_immutable_trg
  BEFORE UPDATE OR DELETE ON acc_document_versions
  FOR EACH ROW EXECUTE FUNCTION acc_versions_immutable();
