-- FP-007 (expand), шаг 2 из 2: заполнение организации у кадровых таблиц старого модуля. Выполняется ДО db push.
-- Организация выводится из связей; одна организация в базе — она; иначе неоднозначно — стоп с инструкцией.
-- Должность, график или табель, которыми пользуются несколько организаций, делятся на копии по организациям.
DO $$
DECLARE
  orgs_n int;
  single_org text;
  n bigint;
  r record;
  o text;
  new_id text;
  first boolean;
  tbl text;
  todo text := '';
BEGIN
  IF to_regclass('public.employees') IS NULL THEN
    RETURN;
  END IF;
  SELECT count(*), min(id) INTO orgs_n, single_org FROM organizations;
  IF orgs_n <> 1 THEN
    single_org := NULL;
  END IF;

  -- Сотрудники: трудовой договор → проводки → пользователь → подразделение → единственная организация.
  IF EXISTS (SELECT 1 FROM employment_contracts GROUP BY employee_id HAVING employee_id IS NOT NULL AND count(DISTINCT organization_id) > 1) THEN
    RAISE EXCEPTION 'FP-007: есть сотрудники с трудовыми договорами в разных организациях — разделите их вручную (employment_contracts.employee_id)';
  END IF;
  UPDATE employees e SET organization_id = c.organization_id FROM employment_contracts c WHERE e.organization_id IS NULL AND c.employee_id = e.id;
  -- Подотчётные лица и сотрудники в аналитике проводок — организация проводок (если она одна).
  UPDATE employees e SET organization_id = p.org FROM (
    SELECT employee_id, min(organization_id) AS org FROM acc_postings WHERE employee_id IS NOT NULL GROUP BY employee_id HAVING count(DISTINCT organization_id) = 1
  ) p WHERE e.organization_id IS NULL AND p.employee_id = e.id;
  UPDATE employees e SET organization_id = u.organization_id FROM users u WHERE e.organization_id IS NULL AND u.id = e.user_id;
  UPDATE employees e SET organization_id = d.organization_id FROM departments d WHERE e.organization_id IS NULL AND d.id = e.department_id AND d.organization_id IS NOT NULL;
  IF single_org IS NOT NULL THEN
    UPDATE employees SET organization_id = single_org WHERE organization_id IS NULL;
  END IF;
  SELECT count(*) INTO n FROM employees WHERE organization_id IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'FP-007: у % сотрудников не определяется организация (организаций в базе: %). Назначьте её: UPDATE employees SET organization_id = ''<id организации>'' WHERE organization_id IS NULL; и повторите выкладку', n, orgs_n;
  END IF;

  -- Смены по складам — организация склада.
  UPDATE shift_plans p SET organization_id = s.organization_id FROM stores s WHERE p.organization_id IS NULL AND s.id = p.store_id;
  UPDATE open_shifts p SET organization_id = s.organization_id FROM stores s WHERE p.organization_id IS NULL AND s.id = p.store_id;

  -- Должности: организации всех, кто ссылается. Несколько — копия на каждую следующую.
  FOR r IN SELECT id FROM positions WHERE organization_id IS NULL LOOP
    first := true;
    FOR o IN
      SELECT DISTINCT x.org FROM (
        SELECT organization_id AS org FROM employees WHERE position_id = r.id
        UNION SELECT organization_id FROM staffing_table WHERE position_id = r.id
        UNION SELECT c.organization_id FROM employment_history h JOIN employment_contracts c ON c.id = h.contract_id WHERE h.position_id = r.id
        UNION SELECT organization_id FROM shift_plans WHERE position_id = r.id
        UNION SELECT organization_id FROM open_shifts WHERE position_id = r.id
      ) x WHERE x.org IS NOT NULL ORDER BY 1
    LOOP
      IF first THEN
        UPDATE positions SET organization_id = o WHERE id = r.id;
        first := false;
      ELSE
        new_id := gen_random_uuid()::text;
        INSERT INTO positions (id, name, organization_id) SELECT new_id, name, o FROM positions WHERE id = r.id;
        UPDATE employees SET position_id = new_id WHERE position_id = r.id AND organization_id = o;
        UPDATE staffing_table SET position_id = new_id WHERE position_id = r.id AND organization_id = o;
        UPDATE employment_history h SET position_id = new_id FROM employment_contracts c WHERE c.id = h.contract_id AND h.position_id = r.id AND c.organization_id = o;
        UPDATE shift_plans SET position_id = new_id WHERE position_id = r.id AND organization_id = o;
        UPDATE open_shifts SET position_id = new_id WHERE position_id = r.id AND organization_id = o;
      END IF;
    END LOOP;
  END LOOP;
  IF single_org IS NOT NULL THEN
    UPDATE positions SET organization_id = single_org WHERE organization_id IS NULL;
  END IF;

  -- Графики работы — так же.
  FOR r IN SELECT id FROM work_schedules WHERE organization_id IS NULL LOOP
    first := true;
    FOR o IN
      SELECT DISTINCT x.org FROM (
        SELECT organization_id AS org FROM employees WHERE work_schedule_id = r.id
        UNION SELECT organization_id FROM shift_plans WHERE work_schedule_id = r.id
        UNION SELECT organization_id FROM open_shifts WHERE work_schedule_id = r.id
        UNION SELECT c.organization_id FROM employment_history h JOIN employment_contracts c ON c.id = h.contract_id WHERE h.schedule_id = r.id
      ) x WHERE x.org IS NOT NULL ORDER BY 1
    LOOP
      IF first THEN
        UPDATE work_schedules SET organization_id = o WHERE id = r.id;
        first := false;
      ELSE
        new_id := gen_random_uuid()::text;
        INSERT INTO work_schedules (id, name, start_time, end_time, duration, break_time, is_active, organization_id)
          SELECT new_id, name, start_time, end_time, duration, break_time, is_active, o FROM work_schedules WHERE id = r.id;
        UPDATE employees SET work_schedule_id = new_id WHERE work_schedule_id = r.id AND organization_id = o;
        UPDATE shift_plans SET work_schedule_id = new_id WHERE work_schedule_id = r.id AND organization_id = o;
        UPDATE open_shifts SET work_schedule_id = new_id WHERE work_schedule_id = r.id AND organization_id = o;
        UPDATE employment_history h SET schedule_id = new_id FROM employment_contracts c WHERE c.id = h.contract_id AND h.schedule_id = r.id AND c.organization_id = o;
      END IF;
    END LOOP;
  END LOOP;
  IF single_org IS NOT NULL THEN
    UPDATE work_schedules SET organization_id = single_org WHERE organization_id IS NULL;
  END IF;

  -- Строки табеля — организация сотрудника; табель с сотрудниками нескольких организаций — копия на каждую следующую.
  UPDATE time_sheet_rows r2 SET organization_id = e.organization_id FROM employees e WHERE r2.organization_id IS NULL AND e.id = r2.employee_id;
  FOR r IN SELECT id FROM time_sheets WHERE organization_id IS NULL LOOP
    first := true;
    FOR o IN SELECT DISTINCT organization_id FROM time_sheet_rows WHERE time_sheet_id = r.id ORDER BY 1 LOOP
      IF first THEN
        UPDATE time_sheets SET organization_id = o WHERE id = r.id;
        first := false;
      ELSE
        new_id := gen_random_uuid()::text;
        INSERT INTO time_sheets (id, month, year, status, created_at, updated_at, organization_id)
          SELECT new_id, month, year, status, created_at, updated_at, o FROM time_sheets WHERE id = r.id;
        UPDATE time_sheet_rows SET time_sheet_id = new_id WHERE time_sheet_id = r.id AND organization_id = o;
      END IF;
    END LOOP;
  END LOOP;
  IF single_org IS NOT NULL THEN
    UPDATE time_sheets SET organization_id = single_org WHERE organization_id IS NULL;
  END IF;

  UPDATE shift_responses x SET organization_id = s.organization_id FROM open_shifts s WHERE x.organization_id IS NULL AND s.id = x.open_shift_id;

  -- Что осталось без организации — решает человек (пустые табели, неиспользуемые должности и графики при нескольких организациях).
  FOREACH tbl IN ARRAY ARRAY['positions', 'work_schedules', 'time_sheets', 'shift_plans', 'open_shifts', 'shift_responses', 'time_sheet_rows'] LOOP
    EXECUTE format('SELECT count(*) FROM %I WHERE organization_id IS NULL', tbl) INTO n;
    IF n > 0 THEN
      todo := todo || format(E'\n  UPDATE %I SET organization_id = ''<id организации>'' WHERE organization_id IS NULL;  -- строк: %s', tbl, n);
    END IF;
  END LOOP;
  IF todo <> '' THEN
    RAISE EXCEPTION 'FP-007: строки без организации (организаций в базе: %) — назначьте и повторите выкладку:%', orgs_n, todo;
  END IF;

  -- Ссылки, которые новые составные FK запретят.
  SELECT count(*) INTO n FROM employees e JOIN departments d ON d.id = e.department_id WHERE d.organization_id IS NOT NULL AND d.organization_id <> e.organization_id;
  IF n > 0 THEN
    RAISE EXCEPTION 'FP-007: % сотрудников числятся в подразделении другой организации (employees.department_id)', n;
  END IF;
  SELECT count(*) INTO n FROM employment_contracts c JOIN employees e ON e.id = c.employee_id WHERE e.organization_id <> c.organization_id;
  IF n > 0 THEN
    RAISE EXCEPTION 'FP-007: % трудовых договоров ссылаются на сотрудника другой организации (employment_contracts.employee_id)', n;
  END IF;

  -- Ключи (organization_id, id) и уникальность табеля под именами Prisma — см. 010.
  CREATE UNIQUE INDEX IF NOT EXISTS employees_organization_id_id_key ON employees (organization_id, id);
  CREATE UNIQUE INDEX IF NOT EXISTS positions_organization_id_id_key ON positions (organization_id, id);
  CREATE UNIQUE INDEX IF NOT EXISTS work_schedules_organization_id_id_key ON work_schedules (organization_id, id);
  CREATE UNIQUE INDEX IF NOT EXISTS open_shifts_organization_id_id_key ON open_shifts (organization_id, id);
  CREATE UNIQUE INDEX IF NOT EXISTS time_sheets_organization_id_id_key ON time_sheets (organization_id, id);
  CREATE UNIQUE INDEX IF NOT EXISTS time_sheets_organization_id_month_year_key ON time_sheets (organization_id, month, year);
END $$;

-- Ключ синхронизации сотрудников с 1С — в пределах организации (см. 010).
DO $$
BEGIN
  IF to_regclass('public.employees') IS NOT NULL THEN
    CREATE UNIQUE INDEX IF NOT EXISTS employees_organization_id_onec_base_onec_guid_key ON employees (organization_id, onec_base, onec_guid);
  END IF;
END $$;
