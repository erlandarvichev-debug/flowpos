-- Печатные формы: текст версии шаблона неизменен — новая редакция сохраняется новой версией; меняются только признаки
-- «по умолчанию» и «в архиве». Удаление — только при обслуживании. Одна версия по умолчанию на вид. Идемпотентно.
CREATE OR REPLACE FUNCTION fp_print_template_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF fp_stock_maintenance() THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'ACC_IMMUTABLE: шаблон не удаляется — отправьте его в архив' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.organization_id, NEW.kind, NEW.name, NEW.html, NEW.version, NEW.family, NEW.based_on, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.organization_id, OLD.kind, OLD.name, OLD.html, OLD.version, OLD.family, OLD.based_on, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'ACC_IMMUTABLE: версия шаблона не меняется — сохраните новую версию' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS fp_print_template_guard_trg ON print_templates;
CREATE TRIGGER fp_print_template_guard_trg BEFORE UPDATE OR DELETE ON print_templates FOR EACH ROW EXECUTE FUNCTION fp_print_template_guard();
CREATE UNIQUE INDEX IF NOT EXISTS print_templates_one_default ON print_templates (organization_id, kind) WHERE is_default AND status = 'ACTIVE';
