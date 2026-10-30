-- FP-019: регистр распределения входного НДС неизменяем — исправление только сторнирующей строкой.
CREATE OR REPLACE FUNCTION vat_credit_allocations_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Регистр НДС к зачёту неизменяем: исправление — сторнирующей строкой (REVERSAL)';
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS vat_credit_allocations_immutable_trg ON vat_credit_allocations;
CREATE TRIGGER vat_credit_allocations_immutable_trg BEFORE UPDATE OR DELETE ON vat_credit_allocations
  FOR EACH ROW EXECUTE FUNCTION vat_credit_allocations_immutable();
