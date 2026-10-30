-- FP-007: tenant_id / organization_id заполняются от родителя, если их не передал код.
-- Зачем: старый код (в том числе после автоотката релиза в deploy.sh — схема назад не откатывается) и
-- вложенные create не знают про новые столбцы. Заполнение не расширяет доступ: значение берётся
-- у родителя, который код уже указал, а составные FK проверяют, что всё принадлежит одному клиенту
-- и одной организации. Явно переданное значение не меняется — его проверяет FK.
--
-- Аргументы триггера: столбец, ссылка, таблица родителя, столбец родителя.
-- Ссылка '' — родителя нет. Для tenant_id последний шаг — единственный клиент в БД; клиентов
-- несколько — значение обязано прийти от кода или из SET LOCAL flowpos.tenant_id, иначе NOT NULL.
CREATE OR REPLACE FUNCTION fp_fill_scope() RETURNS trigger AS $$
DECLARE
  col  text := TG_ARGV[0];
  fk   text := TG_ARGV[1];
  ptab text := TG_ARGV[2];
  pcol text := TG_ARGV[3];
  row  jsonb := to_jsonb(NEW);
  val  text;
  ref  text;
BEGIN
  IF row ->> col IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF fk <> '' THEN
    ref := row ->> fk;
    IF ref IS NOT NULL THEN
      EXECUTE format('SELECT %I FROM %I WHERE id = $1', pcol, ptab) INTO val USING ref;
    END IF;
  END IF;
  IF val IS NULL AND col = 'tenant_id' THEN
    SELECT CASE WHEN count(*) = 1 THEN min(id) END INTO val FROM tenants;
  END IF;
  IF val IS NOT NULL THEN
    NEW := jsonb_populate_record(NEW, jsonb_build_object(col, val));
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DO $$
DECLARE
  spec text[];
BEGIN
  FOREACH spec SLICE 1 IN ARRAY ARRAY[
    ['organizations',       'tenant_id',       '',                  '',                     ''],
    ['users',               'tenant_id',       'organization_id',   'organizations',        'tenant_id'],
    ['org_memberships',     'tenant_id',       'organization_id',   'organizations',        'tenant_id'],
    ['stores',              'tenant_id',       'organization_id',   'organizations',        'tenant_id'],
    ['pos_terminals',       'tenant_id',       'organization_id',   'organizations',        'tenant_id'],
    ['products',            'tenant_id',       'organization_id',   'organizations',        'tenant_id'],
    ['counterparties',      'tenant_id',       'organization_id',   'organizations',        'tenant_id'],
    ['documents',           'tenant_id',       'organization_id',   'organizations',        'tenant_id'],
    ['product_groups',      'tenant_id',       '',                  '',                     ''],
    ['uoms',                'tenant_id',       '',                  '',                     ''],
    ['price_types',         'tenant_id',       '',                  '',                     ''],
    ['counterparty_groups', 'tenant_id',       '',                  '',                     ''],
    ['product_barcodes',    'tenant_id',       'product_id',        'products',             'tenant_id'],
    ['prices',              'tenant_id',       'product_id',        'products',             'tenant_id'],
    ['bins',                'tenant_id',       'store_id',          'stores',               'tenant_id'],
    ['stock',               'tenant_id',       'store_id',          'stores',               'tenant_id'],
    ['contracts',           'tenant_id',       'counterparty_id',   'counterparties',       'tenant_id'],
    ['document_lines',      'tenant_id',       'document_id',       'documents',            'tenant_id'],
    ['grade_rate_values',   'organization_id', 'grade_id',          'salary_grades',        'organization_id'],
    ['employment_history',  'organization_id', 'contract_id',       'employment_contracts', 'organization_id'],
    ['payroll_results',     'organization_id', 'payroll_period_id', 'payroll_periods',      'organization_id']
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', 'fp_fill_' || spec[2], spec[1]);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION fp_fill_scope(%L, %L, %L, %L)',
                   'fp_fill_' || spec[2], spec[1], spec[2], spec[3], spec[4], spec[5]);
  END LOOP;
END $$;
