-- FP-008: доступ к организации — только по членству с ролью. Раньше старые модули пускали любого вошедшего
-- пользователя в его организацию, а OrgGuard «лениво» делал владельцем каждого с ролью admin из токена.
-- Здесь старые пользователи без членства в своей организации получают его с ролью из старых ролей
-- (admin → admin, не владелец; manager, hr, cashier — одноимённые). Без старых ролей членство не создаётся:
-- доступ выдаёт администратор организации (Настройки → Участники). Выполняется до db push; идемпотентно.
DO $$
DECLARE
  created bigint;
  left_out bigint;
BEGIN
  IF to_regclass('public.org_memberships') IS NULL OR to_regclass('public.user_roles') IS NULL THEN
    RETURN;
  END IF;
  WITH mapped AS (
    SELECT u.id AS user_id, u.organization_id, o.tenant_id,
           (array_agg(m.org_role ORDER BY m.rank))[1] AS role
    FROM users u
    JOIN organizations o ON o.id = u.organization_id
    JOIN user_roles ur ON ur.user_id = u.id
    JOIN roles r ON r.id = ur.role_id
    JOIN (VALUES ('admin', 'admin', 1), ('manager', 'manager', 2), ('hr', 'hr', 3), ('cashier', 'cashier', 4)) AS m(legacy, org_role, rank) ON m.legacy = r.name
    WHERE NOT EXISTS (SELECT 1 FROM org_memberships om WHERE om.user_id = u.id AND om.organization_id = u.organization_id)
    GROUP BY u.id, u.organization_id, o.tenant_id
  ), ins AS (
    INSERT INTO org_memberships (id, user_id, organization_id, tenant_id, role, is_active, created_at)
    SELECT gen_random_uuid()::text, user_id, organization_id, tenant_id, role, true, CURRENT_TIMESTAMP FROM mapped
    RETURNING 1
  )
  SELECT count(*) INTO created FROM ins;

  SELECT count(*) INTO left_out FROM users u
  WHERE u.is_active AND NOT EXISTS (SELECT 1 FROM org_memberships om WHERE om.user_id = u.id);
  RAISE NOTICE 'FP-008: создано членств из старых ролей: %; активных пользователей без членства (доступ выдаёт администратор): %', created, left_out;
END $$;
