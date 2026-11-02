-- FP-039: пакеты налоговых правил и налоговые регистры. Идемпотентно.
-- Пакет: содержимое (параметры, источники, оговорки, хэш, срок действия) неизменно; можно только вывести из действия.
CREATE OR REPLACE FUNCTION fp_tax_pack_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF fp_stock_maintenance() THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'ACC_IMMUTABLE: пакет налоговых правил не удаляется — выведите его из действия' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.code, NEW.version, NEW.valid_from, NEW.valid_to, NEW.params, NEW.sources, NEW.unverified, NEW.content_hash, NEW.created_at)
     IS DISTINCT FROM (OLD.code, OLD.version, OLD.valid_from, OLD.valid_to, OLD.params, OLD.sources, OLD.unverified, OLD.content_hash, OLD.created_at)
     OR NOT (NEW.status = OLD.status OR (OLD.status = 'PUBLISHED' AND NEW.status = 'RETIRED')) THEN
    RAISE EXCEPTION 'ACC_IMMUTABLE: пакет налоговых правил не меняется — выпускается новая версия' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS fp_tax_pack_guard_trg ON tax_rule_packs;
CREATE TRIGGER fp_tax_pack_guard_trg BEFORE UPDATE OR DELETE ON tax_rule_packs FOR EACH ROW EXECUTE FUNCTION fp_tax_pack_guard();

-- Утверждение: неизменно; только отзыв ACTIVE → REVOKED с автором, временем и причиной.
CREATE OR REPLACE FUNCTION fp_org_tax_pack_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF fp_stock_maintenance() THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'ACC_IMMUTABLE: утверждение пакета не удаляется — отзовите его' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status <> 'ACTIVE' OR NEW.status <> 'REVOKED' OR NEW.revoked_by IS NULL OR NEW.revoked_at IS NULL OR coalesce(NEW.revoke_reason, '') = ''
     OR (NEW.organization_id, NEW.pack_id, NEW.content_hash, NEW.acknowledged, NEW.approved_by, NEW.approved_at)
        IS DISTINCT FROM (OLD.organization_id, OLD.pack_id, OLD.content_hash, OLD.acknowledged, OLD.approved_by, OLD.approved_at) THEN
    RAISE EXCEPTION 'ACC_IMMUTABLE: утверждение пакета меняется только отзывом с причиной' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS fp_org_tax_pack_guard_trg ON org_tax_packs;
CREATE TRIGGER fp_org_tax_pack_guard_trg BEFORE UPDATE OR DELETE ON org_tax_packs FOR EACH ROW EXECUTE FUNCTION fp_org_tax_pack_guard();
CREATE UNIQUE INDEX IF NOT EXISTS org_tax_packs_one_active ON org_tax_packs (organization_id, pack_id) WHERE status = 'ACTIVE';

-- Регистр: черновик меняется и удаляется свободно; зафиксированный неизменен, кроме замены (FIXED → SUPERSEDED с причиной).
CREATE OR REPLACE FUNCTION fp_tax_register_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'DRAFT' OR fp_stock_maintenance() THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'ACC_IMMUTABLE: зафиксированный налоговый регистр не удаляется' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'DRAFT' THEN RETURN NEW; END IF;
  IF OLD.status = 'FIXED' AND NEW.status = 'SUPERSEDED' AND NEW.superseded_by IS NOT NULL AND coalesce(NEW.supersede_reason, '') <> ''
     AND (NEW.organization_id, NEW.kind, NEW.year, NEW.period, NEW.pack_id, NEW.pack_version, NEW.data, NEW.content_hash, NEW.created_by, NEW.created_at, NEW.fixed_by, NEW.fixed_at)
         IS NOT DISTINCT FROM (OLD.organization_id, OLD.kind, OLD.year, OLD.period, OLD.pack_id, OLD.pack_version, OLD.data, OLD.content_hash, OLD.created_by, OLD.created_at, OLD.fixed_by, OLD.fixed_at) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ACC_IMMUTABLE: зафиксированный налоговый регистр не меняется — пересоберите и зафиксируйте заново с причиной' USING ERRCODE = 'P0001';
END $$;
DROP TRIGGER IF EXISTS fp_tax_register_guard_trg ON tax_registers;
CREATE TRIGGER fp_tax_register_guard_trg BEFORE UPDATE OR DELETE ON tax_registers FOR EACH ROW EXECUTE FUNCTION fp_tax_register_guard();
CREATE UNIQUE INDEX IF NOT EXISTS tax_registers_one_fixed ON tax_registers (organization_id, kind, year, period) WHERE status = 'FIXED';
CREATE UNIQUE INDEX IF NOT EXISTS tax_registers_one_draft ON tax_registers (organization_id, kind, year, period) WHERE status = 'DRAFT';
