-- FP-009: изоляция клиентов на уровне PostgreSQL (RLS) и рабочая роль без обхода RLS.
--
-- Роли (создаёт install.sh, не этот файл):
--   flowpos     — владелец таблиц и роль миграций (db push, sql/pre, этот файл); BYPASSRLS.
--   flowpos_app — рабочая роль API и воркеров: LOGIN, NOSUPERUSER, NOBYPASSRLS, только DML.
-- Контекст: каждая транзакция приложения начинается с set_config('flowpos.tenant_id', …, true) и
-- set_config('flowpos.system', 'on'|'off', true). Нет контекста — строк нет (fail-closed).
--
-- Политики (FORCE — действуют и на владельца без BYPASSRLS):
--   таблица с tenant_id         — строки текущего клиента;
--   с organization_id без tenant_id — организации текущего клиента (organizations сама под RLS);
--   дочерние без обоих          — через родителя (RLS родителя);
--   служебные                   — только в системном режиме;
--   глобальные справочники      — без RLS (план счетов, валюты, курсы, ставки НДС, роли старого модуля).
-- Идемпотентно: политики пересоздаются при каждой выкладке.

DO $$
BEGIN
  -- FORCE RLS распространяется на владельца: без BYPASSRLS у роли миграций sql/pre при следующей
  -- выкладке не увидит данных и молча ничего не заполнит. Лучше остановиться здесь.
  IF NOT (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'FP-009: роль миграций % должна иметь BYPASSRLS (ALTER ROLE % BYPASSRLS — от суперпользователя, см. deploy/README.md)', current_user, current_user;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION fp_system() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('flowpos.system', true), '') = 'on'
$$;

CREATE OR REPLACE FUNCTION fp_tenant_ok(t text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT fp_system() OR t = NULLIF(current_setting('flowpos.tenant_id', true), '')
$$;

DO $$
DECLARE
  r record;
  spec text[];
  global_tables text[] := ARRAY['acc_charts', 'currencies', 'currency_rates', 'vat_rates', 'roles', 'permissions', 'role_permissions', '_prisma_migrations'];
  system_tables text[] := ARRAY['oidc_states', 'acc_autopilot_cursors',
    -- старые витрины и маркетплейс без клиента/организации; в API не используются
    'gig_workers', 'gig_offers', 'marketplace_orders', 'marketplace_assignments', 'mart_payroll', 'mart_sales_daily',
    'mart_shift_coverage', 'mart_stock_snapshot', 'demand_forecasts'];
  covered text[] := ARRAY[]::text[];
  uncovered text := '';
BEGIN
  -- Снять прежние политики FlowPOS (переименования и смена правил между версиями).
  FOR r IN SELECT schemaname, tablename, policyname FROM pg_policies WHERE schemaname = 'public' AND policyname LIKE 'fp_%' LOOP
    EXECUTE format('DROP POLICY %I ON %I.%I', r.policyname, r.schemaname, r.tablename);
  END LOOP;

  -- Таблицы клиента.
  FOR r IN SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t USING (table_schema, table_name)
           WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE' AND c.column_name = 'tenant_id' LOOP
    EXECUTE format('CREATE POLICY fp_tenant ON %I USING (fp_tenant_ok(tenant_id)) WITH CHECK (fp_tenant_ok(tenant_id))', r.table_name);
    covered := covered || r.table_name;
  END LOOP;
  -- Сам клиент.
  EXECUTE 'CREATE POLICY fp_tenant ON tenants USING (fp_tenant_ok(id)) WITH CHECK (fp_system())';
  covered := covered || 'tenants'::text;

  -- План счетов: строки без организации — общий типовой план, его читают все; пишет только система.
  EXECUTE 'CREATE POLICY fp_org ON acc_accounts USING (organization_id IS NULL OR fp_system() OR organization_id IN (SELECT id FROM organizations)) '
          'WITH CHECK (fp_system() OR organization_id IN (SELECT id FROM organizations))';
  covered := covered || 'acc_accounts'::text;

  -- Таблицы организации без tenant_id: организация должна быть видима (своего клиента).
  FOR r IN SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t USING (table_schema, table_name)
           WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE' AND c.column_name = 'organization_id'
             AND NOT (c.table_name = ANY (covered)) LOOP
    EXECUTE format('CREATE POLICY fp_org ON %I USING (fp_system() OR organization_id IN (SELECT id FROM organizations)) '
                   'WITH CHECK (fp_system() OR organization_id IN (SELECT id FROM organizations))', r.table_name);
    covered := covered || r.table_name;
  END LOOP;

  -- Дочерние: {таблица, ссылка, родитель}.
  FOREACH spec SLICE 1 IN ARRAY ARRAY[
    ['acc_document_versions', 'document_id',       'acc_documents'],
    ['employee_bank_details', 'contract_id',       'employment_contracts'],
    ['employee_terminations', 'contract_id',       'employment_contracts'],
    ['one_time_accruals',     'contract_id',       'employment_contracts'],
    ['pos_shifts',            'terminal_id',       'pos_terminals'],
    ['pos_cash_ops',          'shift_id',          'pos_shifts'],
    ['time_events',           'employee_id',       'employees'],
    ['payrolls',              'employee_id',       'employees'],
    ['refresh_tokens',        'user_id',           'users'],
    ['user_roles',            'user_id',           'users'],
    ['id_map',                'connection_id',     'onec_connections'],
    ['sync_cursor',           'connection_id',     'onec_connections'],
    ['sync_log',              'connection_id',     'onec_connections'],
    ['moysklad_sync_cursor',  'connection_id',     'moysklad_connections'],
    ['moysklad_sync_log',     'connection_id',     'moysklad_connections'],
    ['journal_entries',       'payroll_period_id', 'payroll_periods'],
    ['journal_entry_lines',   'entry_id',          'journal_entries']
  ] LOOP
    CONTINUE WHEN to_regclass('public.' || spec[1]) IS NULL OR spec[1] = ANY (covered);
    EXECUTE format('CREATE POLICY fp_parent ON %1$I USING (fp_system() OR EXISTS (SELECT 1 FROM %3$I p WHERE p.id = %1$I.%2$I)) '
                   'WITH CHECK (fp_system() OR EXISTS (SELECT 1 FROM %3$I p WHERE p.id = %1$I.%2$I))', spec[1], spec[2], spec[3]);
    covered := covered || spec[1];
  END LOOP;

  -- Служебные — только системный режим.
  FOREACH spec SLICE 1 IN ARRAY (SELECT array_agg(ARRAY[x]) FROM unnest(system_tables) AS x) LOOP
    CONTINUE WHEN to_regclass('public.' || spec[1]) IS NULL OR spec[1] = ANY (covered);
    EXECUTE format('CREATE POLICY fp_system ON %I USING (fp_system()) WITH CHECK (fp_system())', spec[1]);
    covered := covered || spec[1];
  END LOOP;

  -- Включить RLS (FORCE) на всём покрытом; глобальные — без RLS.
  FOREACH spec SLICE 1 IN ARRAY (SELECT array_agg(ARRAY[x]) FROM unnest(covered) AS x) LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', spec[1]);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', spec[1]);
  END LOOP;

  -- Новая таблица, не попавшая ни в одну группу, — выкладка останавливается: её нужно отнести к группе явно.
  FOR r IN SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
             AND NOT (table_name = ANY (covered)) AND NOT (table_name = ANY (global_tables)) LOOP
    uncovered := uncovered || ' ' || r.table_name;
  END LOOP;
  IF uncovered <> '' THEN
    RAISE EXCEPTION 'FP-009: таблицы без правила RLS:% — добавьте их в 040_fp009_rls.sql (клиент, организация, родитель, служебная или глобальная)', uncovered;
  END IF;
END $$;

-- Рабочая роль: только DML, без DDL и без обхода RLS. Роль создаётся при установке; нет роли — пропуск.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flowpos_app') THEN
    IF (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = 'flowpos_app') THEN
      RAISE EXCEPTION 'FP-009: рабочая роль flowpos_app не должна иметь BYPASSRLS/SUPERUSER';
    END IF;
    EXECUTE 'GRANT USAGE ON SCHEMA public TO flowpos_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO flowpos_app';
    EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO flowpos_app';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO flowpos_app';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO flowpos_app';
  END IF;
END $$;
