-- FP-008: IBAN сотрудника уникален в пределах договора, а не всей базы (см. schema.prisma, EmployeeBankDetail).
-- Ключ под именем Prisma создаётся заранее: новый UNIQUE db push иначе считает риском потери данных.
DO $$
BEGIN
  IF to_regclass('public.employee_bank_details') IS NOT NULL THEN
    CREATE UNIQUE INDEX IF NOT EXISTS employee_bank_details_contract_id_iban_key ON employee_bank_details (contract_id, iban);
  END IF;
END $$;
