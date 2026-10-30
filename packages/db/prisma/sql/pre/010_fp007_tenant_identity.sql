-- FP-007 (expand): клиент (tenant) над организацией. Выполняется ДО `prisma db push`.
-- Идемпотентно. На новой БД (таблиц ещё нет) ничего не делает — схему создаст db push.
-- На существующей: создаёт tenants, добавляет tenant_id / organization_id (пока NULL) и заполняет их
-- от родителя. NOT NULL, составные ключи и FK затем ставит db push; если данные им противоречат,
-- db push остановит выкладку до переключения релиза.
DO $$
DECLARE
  default_tenant constant text := '00000000-0000-0000-0000-000000000001';
  tenants_n int;
  spec text[];
  n bigint;
BEGIN
  IF to_regclass('public.organizations') IS NULL THEN
    RETURN;
  END IF;

  CREATE TABLE IF NOT EXISTS tenants (
    id         text         NOT NULL,
    name       text         NOT NULL,
    is_active  boolean      NOT NULL DEFAULT true,
    created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT tenants_pkey PRIMARY KEY (id)
  );
  IF NOT EXISTS (SELECT 1 FROM tenants) THEN
    INSERT INTO tenants (id, name) VALUES (default_tenant, 'Основной клиент');
  END IF;
  SELECT count(*) INTO tenants_n FROM tenants;

  -- Организации: единственный клиент получает все организации без клиента. Клиентов несколько — решает человек.
  ALTER TABLE organizations ADD COLUMN IF NOT EXISTS tenant_id text;
  IF EXISTS (SELECT 1 FROM organizations WHERE tenant_id IS NULL) THEN
    IF tenants_n <> 1 THEN
      RAISE EXCEPTION 'FP-007: есть организации без tenant_id, а клиентов %. Назначьте organizations.tenant_id вручную', tenants_n;
    END IF;
    UPDATE organizations SET tenant_id = (SELECT id FROM tenants) WHERE tenant_id IS NULL;
  END IF;

  -- tenant_id от родителя: {таблица, ссылка, родитель, поле родителя}. '' — родителя нет (общий справочник).
  FOREACH spec SLICE 1 IN ARRAY ARRAY[
    ['users',               'organization_id', 'organizations',  'tenant_id'],
    ['org_memberships',     'organization_id', 'organizations',  'tenant_id'],
    ['stores',              'organization_id', 'organizations',  'tenant_id'],
    ['pos_terminals',       'organization_id', 'organizations',  'tenant_id'],
    ['products',            'organization_id', 'organizations',  'tenant_id'],
    ['counterparties',      'organization_id', 'organizations',  'tenant_id'],
    ['documents',           'organization_id', 'organizations',  'tenant_id'],
    ['product_groups',      '',                '',               ''],
    ['uoms',                '',                '',               ''],
    ['price_types',         '',                '',               ''],
    ['counterparty_groups', '',                '',               ''],
    ['product_barcodes',    'product_id',      'products',       'tenant_id'],
    ['prices',              'product_id',      'products',       'tenant_id'],
    ['bins',                'store_id',        'stores',         'tenant_id'],
    ['stock',               'store_id',        'stores',         'tenant_id'],
    ['contracts',           'counterparty_id', 'counterparties', 'tenant_id'],
    ['document_lines',      'document_id',     'documents',      'tenant_id']
  ] LOOP
    CONTINUE WHEN to_regclass('public.' || spec[1]) IS NULL;
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS tenant_id text', spec[1]);
    IF spec[2] <> '' THEN
      EXECUTE format('UPDATE %1$I c SET tenant_id = p.%4$I FROM %3$I p WHERE c.tenant_id IS NULL AND p.id = c.%2$I',
                     spec[1], spec[2], spec[3], spec[4]);
    END IF;
    EXECUTE format('SELECT count(*) FROM %I WHERE tenant_id IS NULL', spec[1]) INTO n;
    IF n > 0 THEN
      IF tenants_n <> 1 THEN
        RAISE EXCEPTION 'FP-007: в % строк без клиента: %, а клиентов %. Назначьте tenant_id вручную', spec[1], n, tenants_n;
      END IF;
      EXECUTE format('UPDATE %I SET tenant_id = (SELECT id FROM tenants) WHERE tenant_id IS NULL', spec[1]);
    END IF;
  END LOOP;

  -- organization_id в строках, которые связывают два объекта организации: от основного родителя.
  FOREACH spec SLICE 1 IN ARRAY ARRAY[
    ['grade_rate_values',  'grade_id',          'salary_grades'],
    ['employment_history', 'contract_id',       'employment_contracts'],
    ['payroll_results',    'payroll_period_id', 'payroll_periods']
  ] LOOP
    CONTINUE WHEN to_regclass('public.' || spec[1]) IS NULL;
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS organization_id text', spec[1]);
    EXECUTE format('UPDATE %1$I c SET organization_id = p.organization_id FROM %3$I p WHERE c.organization_id IS NULL AND p.id = c.%2$I',
                   spec[1], spec[2], spec[3]);
  END LOOP;
END $$;

-- Связи между организациями, которые новые составные FK запретят. Есть такие строки — стоп с понятным
-- сообщением (db push упал бы с менее понятным). Исправляет человек: это данные, а не схема.
DO $$
DECLARE
  chk text[];
  n bigint;
  bad text := '';
BEGIN
  IF to_regclass('public.organizations') IS NULL THEN
    RETURN;
  END IF;
  FOREACH chk SLICE 1 IN ARRAY ARRAY[
    ['pos_terminals.store_id',              'SELECT count(*) FROM pos_terminals c JOIN stores p ON p.id = c.store_id WHERE p.organization_id <> c.organization_id'],
    ['departments.parent_id',               'SELECT count(*) FROM departments c JOIN departments p ON p.id = c.parent_id WHERE p.organization_id IS DISTINCT FROM c.organization_id AND c.organization_id IS NOT NULL'],
    ['staffing_table.grade_id',             'SELECT count(*) FROM staffing_table c JOIN salary_grades p ON p.id = c.grade_id WHERE p.organization_id <> c.organization_id'],
    ['employment_contracts.individual_id',  'SELECT count(*) FROM employment_contracts c JOIN individuals p ON p.id = c.individual_id WHERE p.organization_id <> c.organization_id'],
    ['grade_rate_values.rate_type_id',      'SELECT count(*) FROM grade_rate_values c JOIN rate_types p ON p.id = c.rate_type_id WHERE p.organization_id <> c.organization_id'],
    ['employment_history.rate_type_id',     'SELECT count(*) FROM employment_history c JOIN rate_types p ON p.id = c.rate_type_id WHERE p.organization_id <> c.organization_id'],
    ['payroll_results.contract_id',         'SELECT count(*) FROM payroll_results c JOIN employment_contracts p ON p.id = c.contract_id WHERE p.organization_id <> c.organization_id'],
    ['acc_postings.entry_id',               'SELECT count(*) FROM acc_postings c JOIN acc_entries p ON p.id = c.entry_id WHERE p.organization_id <> c.organization_id'],
    ['org_memberships.user_id',             'SELECT count(*) FROM org_memberships c LEFT JOIN users p ON p.id = c.user_id WHERE p.id IS NULL OR p.tenant_id <> c.tenant_id']
  ] LOOP
    BEGIN
      EXECUTE chk[2] INTO n;
    EXCEPTION WHEN undefined_table OR undefined_column THEN
      CONTINUE;
    END;
    IF n > 0 THEN
      bad := bad || format(' %s: %s;', chk[1], n);
    END IF;
  END LOOP;
  IF bad <> '' THEN
    RAISE EXCEPTION 'FP-007: строки ссылаются на объекты другой организации/клиента:%', bad;
  END IF;
END $$;

-- Составные ключи (scope, id) под именами Prisma. Дублей в них не бывает (id — первичный ключ), но
-- db push считает любой новый UNIQUE риском потери данных и без --accept-data-loss останавливается.
-- Созданные заранее, они для db push уже «есть», а настоящие опасные изменения по-прежнему его остановят.
DO $$
DECLARE
  spec text[];
BEGIN
  IF to_regclass('public.organizations') IS NULL THEN
    RETURN;
  END IF;
  FOREACH spec SLICE 1 IN ARRAY ARRAY[
    ['organizations', 'tenant_id'], ['users', 'tenant_id'], ['product_groups', 'tenant_id'], ['uoms', 'tenant_id'],
    ['price_types', 'tenant_id'], ['products', 'tenant_id'], ['stores', 'tenant_id'], ['stores', 'organization_id'],
    ['bins', 'tenant_id'], ['counterparties', 'tenant_id'], ['counterparty_groups', 'tenant_id'], ['documents', 'tenant_id'],
    ['departments', 'organization_id'], ['salary_grades', 'organization_id'], ['rate_types', 'organization_id'],
    ['individuals', 'organization_id'], ['payroll_periods', 'organization_id'], ['employment_contracts', 'organization_id'],
    ['acc_entries', 'organization_id']
  ] LOOP
    CONTINUE WHEN to_regclass('public.' || spec[1]) IS NULL;
    EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I (%I, id)', spec[1] || '_' || spec[2] || '_id_key', spec[1], spec[2]);
  END LOOP;
END $$;
