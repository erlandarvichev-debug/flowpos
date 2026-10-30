-- FP-007 (expand), шаг 1 из 2: столбцы организации у кадровых таблиц старого модуля. Выполняется ДО db push.
-- Отдельным файлом, чтобы столбцы остались, даже если шаг 2 остановится на неоднозначных данных:
-- тогда оператору достаточно одного UPDATE (текст ошибки говорит, какого) и повторной выкладки.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['employees', 'positions', 'work_schedules', 'shift_plans', 'open_shifts', 'shift_responses', 'time_sheets', 'time_sheet_rows'] LOOP
    CONTINUE WHEN to_regclass('public.' || t) IS NULL;
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS organization_id text', t);
  END LOOP;
  -- Табель был один на месяц для всей базы; теперь — на месяц для каждой организации.
  DROP INDEX IF EXISTS time_sheets_month_year_key;
END $$;
