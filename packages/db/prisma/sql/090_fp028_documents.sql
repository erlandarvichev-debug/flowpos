-- FP-028: документы — неизменяемые проведённые версии и граф связей. Идемпотентно.
--
-- Проведённое содержимое не меняется «на месте»: изменить проведённый документ можно только новой версией
-- (version + 1, через сервис — с причиной и перепроведением). Любой другой писатель (старый модуль, обмен, ручной SQL)
-- получит ошибку БД, а не тихо подменит проведённые данные.

-- ── Торговые документы ──
CREATE OR REPLACE FUNCTION fp_documents_posted_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'POSTED' AND NEW.status = 'POSTED' AND NEW.version = OLD.version
     AND (NEW.date, NEW.total, NEW.doc_type, NEW.counterparty_id, NEW.contract_id, NEW.store_id, NEW.store_to_id, NEW.organization_id)
         IS DISTINCT FROM (OLD.date, OLD.total, OLD.doc_type, OLD.counterparty_id, OLD.contract_id, OLD.store_id, OLD.store_to_id, OLD.organization_id) THEN
    RAISE EXCEPTION 'DOC_POSTED_IMMUTABLE: проведённый документ % изменяется только новой версией', OLD.id USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS fp_documents_posted_guard_trg ON documents;
CREATE TRIGGER fp_documents_posted_guard_trg BEFORE UPDATE ON documents FOR EACH ROW EXECUTE FUNCTION fp_documents_posted_guard();

-- Строки проведённого документа не меняются. Каскадное удаление вместе с документом (вызов из RI-триггера,
-- pg_trigger_depth() > 1) допускается — документ удаляется целиком.
CREATE OR REPLACE FUNCTION fp_document_lines_posted_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  doc_id text := COALESCE(NEW.document_id, OLD.document_id);
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  -- Документ, созданный сразу проведённым в этой же транзакции (касса, старые модули: шапка, затем строки), — ещё
  -- собирается: строки вставлять можно. Проведённый сервисом (posted_version задан) или раньше — нельзя.
  IF EXISTS (SELECT 1 FROM documents d WHERE d.id = doc_id AND d.status = 'POSTED'
               AND NOT (TG_OP = 'INSERT' AND d.posted_version IS NULL
                        AND d.xmin::text = (pg_current_xact_id()::text::bigint % 4294967296)::text)) THEN
    RAISE EXCEPTION 'DOC_POSTED_IMMUTABLE: строки проведённого документа % изменяются только новой версией', doc_id USING ERRCODE = 'P0001';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
DROP TRIGGER IF EXISTS fp_document_lines_posted_guard_trg ON document_lines;
CREATE TRIGGER fp_document_lines_posted_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON document_lines FOR EACH ROW EXECUTE FUNCTION fp_document_lines_posted_guard();

-- История версий торговых документов неизменяема.
CREATE OR REPLACE FUNCTION fp_document_versions_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ACC_IMMUTABLE: версии документа неизменяемы';
END $$;
DROP TRIGGER IF EXISTS fp_document_versions_immutable_trg ON document_versions;
CREATE TRIGGER fp_document_versions_immutable_trg BEFORE UPDATE OR DELETE ON document_versions FOR EACH ROW EXECUTE FUNCTION fp_document_versions_immutable();

-- ── Бухгалтерские документы ──
CREATE OR REPLACE FUNCTION fp_acc_documents_posted_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'POSTED' AND NEW.status = 'POSTED' AND NEW.version = OLD.version
     AND (NEW.date, NEW.body, NEW.amount, NEW.currency, NEW.doc_type, NEW.base_document_id, NEW.reversal_of_id, NEW.organization_id)
         IS DISTINCT FROM (OLD.date, OLD.body, OLD.amount, OLD.currency, OLD.doc_type, OLD.base_document_id, OLD.reversal_of_id, OLD.organization_id) THEN
    RAISE EXCEPTION 'DOC_POSTED_IMMUTABLE: проведённый документ % изменяется только новой версией', OLD.id USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS fp_acc_documents_posted_guard_trg ON acc_documents;
CREATE TRIGGER fp_acc_documents_posted_guard_trg BEFORE UPDATE ON acc_documents FOR EACH ROW EXECUTE FUNCTION fp_acc_documents_posted_guard();

-- ── Граф связей документов ──
-- Связь пишется, только если оба документа — одной организации (чужая ссылка в граф не попадает).
CREATE OR REPLACE FUNCTION fp_doc_org(p_type text, p_id text) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE p_type
    WHEN 'TRADE' THEN (SELECT COALESCE(d.organization_id, s.organization_id) FROM documents d LEFT JOIN stores s ON s.id = d.store_id WHERE d.id = p_id)
    WHEN 'ACC'   THEN (SELECT organization_id FROM acc_documents WHERE id = p_id)
    WHEN 'ESF'   THEN (SELECT organization_id FROM esf_invoices WHERE id = p_id)
  END
$$;

CREATE OR REPLACE FUNCTION fp_set_links(p_from_type text, p_from_id text, p_kinds text[], p_targets jsonb) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  org text := fp_doc_org(p_from_type, p_from_id);
  t jsonb;
BEGIN
  DELETE FROM document_links WHERE from_type = p_from_type AND from_id = p_from_id AND kind = ANY (p_kinds);
  IF org IS NULL THEN
    RETURN;
  END IF;
  FOR t IN SELECT * FROM jsonb_array_elements(p_targets) LOOP
    IF t->>'id' IS NOT NULL AND fp_doc_org(t->>'type', t->>'id') = org THEN
      INSERT INTO document_links (id, organization_id, from_type, from_id, to_type, to_id, kind)
      VALUES (gen_random_uuid()::text, org, p_from_type, p_from_id, t->>'type', t->>'id', t->>'kind')
      ON CONFLICT (from_type, from_id, to_type, to_id, kind) DO NOTHING;
    END IF;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION fp_acc_documents_links() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM fp_set_links('ACC', NEW.id, ARRAY['BASED_ON', 'REVERSAL_OF'], jsonb_build_array(
    jsonb_build_object('type', 'ACC', 'id', CASE WHEN NEW.base_document_id IS DISTINCT FROM NEW.reversal_of_id THEN NEW.base_document_id END, 'kind', 'BASED_ON'),
    jsonb_build_object('type', 'ACC', 'id', NEW.reversal_of_id, 'kind', 'REVERSAL_OF')));
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS fp_acc_documents_links_trg ON acc_documents;
CREATE TRIGGER fp_acc_documents_links_trg AFTER INSERT OR UPDATE OF base_document_id, reversal_of_id ON acc_documents
  FOR EACH ROW EXECUTE FUNCTION fp_acc_documents_links();

CREATE OR REPLACE FUNCTION fp_documents_links() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM fp_set_links('TRADE', NEW.id, ARRAY['BASED_ON'], jsonb_build_array(
    jsonb_build_object('type', 'TRADE', 'id', NEW.attributes->>'baseId', 'kind', 'BASED_ON')));
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS fp_documents_links_trg ON documents;
CREATE TRIGGER fp_documents_links_trg AFTER INSERT OR UPDATE OF attributes, organization_id, store_id ON documents
  FOR EACH ROW EXECUTE FUNCTION fp_documents_links();

CREATE OR REPLACE FUNCTION fp_esf_links() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM fp_set_links('ESF', NEW.id, ARRAY['ESF_FOR', 'CORRECTION_OF'], jsonb_build_array(
    jsonb_build_object('type', 'TRADE', 'id', NEW.source_doc_id, 'kind', 'ESF_FOR'),
    jsonb_build_object('type', 'ESF', 'id', NEW.related_invoice_id, 'kind', 'CORRECTION_OF')));
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS fp_esf_links_trg ON esf_invoices;
CREATE TRIGGER fp_esf_links_trg AFTER INSERT OR UPDATE OF source_doc_id, related_invoice_id ON esf_invoices
  FOR EACH ROW EXECUTE FUNCTION fp_esf_links();

-- Перенос существующих связей (повторный запуск ничего не дублирует).
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT id, base_document_id, reversal_of_id FROM acc_documents WHERE base_document_id IS NOT NULL OR reversal_of_id IS NOT NULL LOOP
    PERFORM fp_set_links('ACC', r.id, ARRAY['BASED_ON', 'REVERSAL_OF'], jsonb_build_array(
      jsonb_build_object('type', 'ACC', 'id', CASE WHEN r.base_document_id IS DISTINCT FROM r.reversal_of_id THEN r.base_document_id END, 'kind', 'BASED_ON'),
      jsonb_build_object('type', 'ACC', 'id', r.reversal_of_id, 'kind', 'REVERSAL_OF')));
  END LOOP;
  FOR r IN SELECT id, attributes->>'baseId' AS base FROM documents WHERE attributes ? 'baseId' LOOP
    PERFORM fp_set_links('TRADE', r.id, ARRAY['BASED_ON'], jsonb_build_array(jsonb_build_object('type', 'TRADE', 'id', r.base, 'kind', 'BASED_ON')));
  END LOOP;
  FOR r IN SELECT id, source_doc_id, related_invoice_id FROM esf_invoices WHERE source_doc_id IS NOT NULL OR related_invoice_id IS NOT NULL LOOP
    PERFORM fp_set_links('ESF', r.id, ARRAY['ESF_FOR', 'CORRECTION_OF'], jsonb_build_array(
      jsonb_build_object('type', 'TRADE', 'id', r.source_doc_id, 'kind', 'ESF_FOR'),
      jsonb_build_object('type', 'ESF', 'id', r.related_invoice_id, 'kind', 'CORRECTION_OF')));
  END LOOP;
END $$;

-- Проведённая версия у уже проведённых документов — текущая.
UPDATE documents SET posted_version = version WHERE status = 'POSTED' AND posted_version IS NULL;
UPDATE acc_documents SET posted_version = version WHERE status = 'POSTED' AND posted_version IS NULL;
