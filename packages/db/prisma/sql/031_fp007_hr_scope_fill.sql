-- FP-007: организация кадровых строк старого модуля заполняется от родителя, если её не передал код
-- (см. 030 — зачем). Несколько возможных родителей — несколько триггеров по порядку имени; последний
-- шаг — единственная организация в БД.
DO $$
DECLARE
  spec text[];
BEGIN
  FOREACH spec SLICE 1 IN ARRAY ARRAY[
    -- таблица,          имя триггера,                        ссылка,            родитель,         поле,              запасной вариант
    ['employees',        'fp_fill_organization_id_1_user',    'user_id',         'users',          'organization_id', ''],
    ['employees',        'fp_fill_organization_id_2_dept',    'department_id',   'departments',    'organization_id', 'fallback'],
    ['positions',        'fp_fill_organization_id',           '',                '',               '',                'fallback'],
    ['work_schedules',   'fp_fill_organization_id',           '',                '',               '',                'fallback'],
    ['time_sheets',      'fp_fill_organization_id',           '',                '',               '',                'fallback'],
    ['shift_plans',      'fp_fill_organization_id',           'store_id',        'stores',         'organization_id', ''],
    ['open_shifts',      'fp_fill_organization_id',           'store_id',        'stores',         'organization_id', ''],
    ['shift_responses',  'fp_fill_organization_id',           'open_shift_id',   'open_shifts',    'organization_id', ''],
    ['time_sheet_rows',  'fp_fill_organization_id',           'time_sheet_id',   'time_sheets',    'organization_id', '']
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', spec[2], spec[1]);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION fp_fill_scope(%L, %L, %L, %L, %L)',
                   spec[2], spec[1], 'organization_id', spec[3], spec[4], spec[5], spec[6]);
  END LOOP;
END $$;
