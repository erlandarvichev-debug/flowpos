-- FP-025: каталог — версии товара, внешние сопоставления, штрихкоды из старого поля products.barcode.
-- Триггеры, а не код сервисов: товар пишут API, обмен с 1С и МойСклад, сиды — история и связи не должны зависеть от
-- того, кто писал. Идемпотентно.

-- Тип штрихкода по содержимому (как detectKind в apps/api/src/modules/catalog/barcode.ts).
CREATE OR REPLACE FUNCTION fp_barcode_kind(code text) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  n int := length(code);
  s int := 0;
  i int;
BEGIN
  IF code !~ '^[0-9]{8,14}$' OR n NOT IN (8, 12, 13, 14) THEN
    RETURN 'CODE128';
  END IF;
  FOR i IN 1..n - 1 LOOP
    s := s + substr(code, n - i, 1)::int * CASE WHEN i % 2 = 1 THEN 3 ELSE 1 END;
  END LOOP;
  IF (10 - s % 10) % 10 <> substr(code, n, 1)::int THEN
    RETURN 'CODE128';
  END IF;
  RETURN CASE n WHEN 8 THEN 'EAN8' WHEN 12 THEN 'UPCA' WHEN 13 THEN 'EAN13' ELSE 'GTIN14' END;
END $$;

-- ── Версии товара ──
CREATE OR REPLACE FUNCTION fp_product_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  snap jsonb := jsonb_build_object(
    'kind', NEW.kind, 'code', NEW.code, 'article', NEW.article, 'name', NEW.name, 'groupId', NEW.group_id,
    'uomId', NEW.uom_id, 'vatRate', NEW.vat_rate, 'parentId', NEW.parent_id, 'variantKey', NEW.variant_key,
    'plu', NEW.plu, 'attributes', NEW.attributes, 'deleted', NEW.deleted, 'organizationId', NEW.organization_id);
  prev jsonb;
  diff text[];
BEGIN
  IF TG_OP = 'UPDATE' THEN
    prev := jsonb_build_object(
      'kind', OLD.kind, 'code', OLD.code, 'article', OLD.article, 'name', OLD.name, 'groupId', OLD.group_id,
      'uomId', OLD.uom_id, 'vatRate', OLD.vat_rate, 'parentId', OLD.parent_id, 'variantKey', OLD.variant_key,
      'plu', OLD.plu, 'attributes', OLD.attributes, 'deleted', OLD.deleted, 'organizationId', OLD.organization_id);
    SELECT array_agg(k ORDER BY k) INTO diff FROM jsonb_object_keys(snap) k WHERE snap -> k IS DISTINCT FROM prev -> k;
    IF diff IS NULL THEN
      RETURN NULL; -- значимые поля не менялись (статус обмена, служебные даты)
    END IF;
  ELSE
    diff := '{}';
  END IF;
  -- Строка товара заблокирована изменением — номер версии без гонки.
  INSERT INTO product_versions (id, tenant_id, product_id, version, snapshot, changed, changed_by)
  SELECT gen_random_uuid()::text, NEW.tenant_id, NEW.id, COALESCE(max(v.version), 0) + 1, snap, diff, NEW.updated_by
  FROM product_versions v WHERE v.product_id = NEW.id;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS fp_product_version_trg ON products;
CREATE TRIGGER fp_product_version_trg AFTER INSERT OR UPDATE ON products FOR EACH ROW EXECUTE FUNCTION fp_product_version();

-- Версии неизменяемы.
CREATE OR REPLACE FUNCTION fp_product_versions_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Версии товара неизменяемы';
END $$;
DROP TRIGGER IF EXISTS fp_product_versions_immutable_trg ON product_versions;
CREATE TRIGGER fp_product_versions_immutable_trg BEFORE UPDATE ON product_versions FOR EACH ROW EXECUTE FUNCTION fp_product_versions_immutable();

-- ── Внешние сопоставления (МойСклад, 1С) ──
CREATE OR REPLACE FUNCTION fp_map_external(p_tenant text, p_entity text, p_system text, p_account text, p_old text, p_new text, p_entity_id text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_old IS NOT NULL AND p_old IS DISTINCT FROM p_new THEN
    UPDATE external_mappings SET status = 'DETACHED', detached_at = now()
     WHERE tenant_id = p_tenant AND entity_type = p_entity AND system = p_system AND account = p_account
       AND external_id = p_old AND entity_id = p_entity_id AND status = 'ACTIVE';
  END IF;
  IF p_new IS NOT NULL THEN
    INSERT INTO external_mappings (id, tenant_id, entity_type, entity_id, system, account, external_id)
    VALUES (gen_random_uuid()::text, p_tenant, p_entity, p_entity_id, p_system, p_account, p_new)
    ON CONFLICT (tenant_id, entity_type, system, account, external_id)
      DO UPDATE SET entity_id = EXCLUDED.entity_id, status = 'ACTIVE', detached_at = NULL;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION fp_product_mapping() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM fp_map_external(NEW.tenant_id, 'product', 'MOYSKLAD', COALESCE(NEW.ms_account_id, ''), NULL, NEW.ms_id, NEW.id);
    PERFORM fp_map_external(NEW.tenant_id, 'product', 'ONEC', NEW.onec_base, NULL, NEW.onec_guid::text, NEW.id);
  ELSE
    IF (OLD.ms_id, OLD.ms_account_id) IS DISTINCT FROM (NEW.ms_id, NEW.ms_account_id) THEN
      IF OLD.ms_account_id IS DISTINCT FROM NEW.ms_account_id THEN
        PERFORM fp_map_external(NEW.tenant_id, 'product', 'MOYSKLAD', COALESCE(OLD.ms_account_id, ''), OLD.ms_id, NULL, NEW.id);
        PERFORM fp_map_external(NEW.tenant_id, 'product', 'MOYSKLAD', COALESCE(NEW.ms_account_id, ''), NULL, NEW.ms_id, NEW.id);
      ELSE
        PERFORM fp_map_external(NEW.tenant_id, 'product', 'MOYSKLAD', COALESCE(NEW.ms_account_id, ''), OLD.ms_id, NEW.ms_id, NEW.id);
      END IF;
    END IF;
    IF (OLD.onec_guid, OLD.onec_base) IS DISTINCT FROM (NEW.onec_guid, NEW.onec_base) THEN
      PERFORM fp_map_external(NEW.tenant_id, 'product', 'ONEC', OLD.onec_base, OLD.onec_guid::text, NULL, NEW.id);
      PERFORM fp_map_external(NEW.tenant_id, 'product', 'ONEC', NEW.onec_base, NULL, NEW.onec_guid::text, NEW.id);
    END IF;
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS fp_product_mapping_trg ON products;
CREATE TRIGGER fp_product_mapping_trg AFTER INSERT OR UPDATE ON products FOR EACH ROW EXECUTE FUNCTION fp_product_mapping();

-- ── Старое поле products.barcode (пишут обмен с 1С/МойСклад и старые клиенты) → таблица штрихкодов ──
-- Касса ищет товар только в product_barcodes; раньше штрихкод из обмена туда не попадал и на продаже не находился.
-- Код у другого товара клиента не перехватывается (ON CONFLICT DO NOTHING) — такие дубли видны в отчёте каталога.
CREATE OR REPLACE FUNCTION fp_product_legacy_barcode() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  nb text := NULLIF(regexp_replace(COALESCE(NEW.barcode, ''), '\s', '', 'g'), '');
  ob text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    ob := NULLIF(regexp_replace(COALESCE(OLD.barcode, ''), '\s', '', 'g'), '');
    IF ob IS NOT DISTINCT FROM nb THEN
      RETURN NULL;
    END IF;
    IF ob IS NOT NULL THEN
      DELETE FROM product_barcodes WHERE tenant_id = NEW.tenant_id AND product_id = NEW.id AND barcode = ob AND source = 'LEGACY';
    END IF;
  END IF;
  IF nb IS NOT NULL THEN
    INSERT INTO product_barcodes (id, tenant_id, product_id, barcode, kind, source)
    VALUES (gen_random_uuid()::text, NEW.tenant_id, NEW.id, nb, fp_barcode_kind(nb), 'LEGACY')
    ON CONFLICT (tenant_id, barcode) DO NOTHING;
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS fp_product_legacy_barcode_trg ON products;
CREATE TRIGGER fp_product_legacy_barcode_trg AFTER INSERT OR UPDATE OF barcode ON products FOR EACH ROW EXECUTE FUNCTION fp_product_legacy_barcode();

-- ── Перенос существующих данных ──
INSERT INTO product_versions (id, tenant_id, product_id, version, snapshot, changed, changed_by)
SELECT gen_random_uuid()::text, p.tenant_id, p.id, 1,
  jsonb_build_object('kind', p.kind, 'code', p.code, 'article', p.article, 'name', p.name, 'groupId', p.group_id,
    'uomId', p.uom_id, 'vatRate', p.vat_rate, 'parentId', p.parent_id, 'variantKey', p.variant_key, 'plu', p.plu,
    'attributes', p.attributes, 'deleted', p.deleted, 'organizationId', p.organization_id),
  '{}', p.updated_by
FROM products p WHERE NOT EXISTS (SELECT 1 FROM product_versions v WHERE v.product_id = p.id);

INSERT INTO external_mappings (id, tenant_id, entity_type, entity_id, system, account, external_id)
SELECT gen_random_uuid()::text, tenant_id, 'product', id, 'MOYSKLAD', COALESCE(ms_account_id, ''), ms_id FROM products WHERE ms_id IS NOT NULL
UNION ALL
SELECT gen_random_uuid()::text, tenant_id, 'product', id, 'ONEC', onec_base, onec_guid::text FROM products WHERE onec_guid IS NOT NULL
ON CONFLICT (tenant_id, entity_type, system, account, external_id) DO NOTHING;

INSERT INTO product_barcodes (id, tenant_id, product_id, barcode, kind, source)
SELECT gen_random_uuid()::text, p.tenant_id, p.id, b.code, fp_barcode_kind(b.code), 'LEGACY'
FROM products p CROSS JOIN LATERAL (SELECT regexp_replace(p.barcode, '\s', '', 'g') AS code) b
WHERE p.barcode IS NOT NULL AND b.code <> '' AND NOT p.deleted
ORDER BY p.created_at
ON CONFLICT (tenant_id, barcode) DO NOTHING;
