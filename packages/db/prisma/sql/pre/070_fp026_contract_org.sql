-- FP-026 (expand): договор принадлежит организации. До `db push` заполняем contracts.organization_id для существующих
-- договоров однозначно: (1) личный контрагент — его организация; (2) все документы с этим договором — одной
-- организации; (3) у клиента одна организация. Неоднозначный договор — остановка выкладки с перечнем: решает человек
-- (UPDATE contracts SET organization_id = … WHERE id = …), иначе документы одной организации ссылались бы на договор
-- другой. Затем уникальность номера договора в паре «организация — контрагент». На новой БД ничего не делает.
DO $$
DECLARE
  bad text;
BEGIN
  IF to_regclass('public.contracts') IS NULL THEN
    RETURN;
  END IF;
  ALTER TABLE contracts ADD COLUMN IF NOT EXISTS organization_id text;
  ALTER TABLE contracts ADD COLUMN IF NOT EXISTS date date;

  UPDATE contracts c SET organization_id = cp.organization_id
    FROM counterparties cp WHERE c.organization_id IS NULL AND cp.id = c.counterparty_id AND cp.organization_id IS NOT NULL;

  UPDATE contracts c SET organization_id = d.org
    FROM (SELECT contract_id, min(COALESCE(d.organization_id, s.organization_id)) AS org
            FROM documents d LEFT JOIN stores s ON s.id = d.store_id
           WHERE d.contract_id IS NOT NULL
           GROUP BY contract_id HAVING count(DISTINCT COALESCE(d.organization_id, s.organization_id)) = 1) d
   WHERE c.organization_id IS NULL AND d.contract_id = c.id AND d.org IS NOT NULL;

  UPDATE contracts c SET organization_id = o.id
    FROM (SELECT tenant_id, min(id) AS id FROM organizations GROUP BY tenant_id HAVING count(*) = 1) o
   WHERE c.organization_id IS NULL AND o.tenant_id = c.tenant_id;

  SELECT string_agg(id || ' (№ ' || number || ')', ', ') INTO bad FROM (SELECT id, number FROM contracts WHERE organization_id IS NULL LIMIT 20) x;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'FP-026: у договоров не определяется организация: %. Укажите contracts.organization_id вручную', bad;
  END IF;

  SELECT string_agg(organization_id || '/' || counterparty_id || '/' || number, ', ') INTO bad FROM (
    SELECT organization_id, counterparty_id, number FROM contracts GROUP BY 1, 2, 3 HAVING count(*) > 1 LIMIT 20) x;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'FP-026: повторяющиеся номера договоров (организация/контрагент/номер): %. Переименуйте дубли', bad;
  END IF;
  CREATE UNIQUE INDEX IF NOT EXISTS contracts_organization_id_counterparty_id_number_key ON contracts (organization_id, counterparty_id, number);
END $$;
