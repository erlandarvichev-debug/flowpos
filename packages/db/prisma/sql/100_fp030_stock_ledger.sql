-- FP-030: журнал складских движений — единственный путь изменения оперативного остатка. Идемпотентно.
--
-- stock.qty меняется только триггером на вставку движения в stock_movements: у каждого изменения остатка есть
-- источник (документ, строка, версия), количество и стоимость. Прямая запись количества в stock (старый модуль,
-- обмен, ручной SQL) — ошибка БД STOCK_LEDGER_ONLY. Движения неизменяемы: отмена — встречное движение.
--
-- Обслуживание (первичное заполнение, удаление данных клиента целиком) — только роль миграций (BYPASSRLS/superuser)
-- с SET LOCAL flowpos.stock_maintenance = 'on'; рабочая роль приложения так не может.

CREATE OR REPLACE FUNCTION fp_stock_maintenance() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('flowpos.stock_maintenance', true), '') = 'on'
     AND (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user)
$$;

-- На время заполнения и чистки — без триггеров (пересоздаются ниже).
DROP TRIGGER IF EXISTS fp_stock_guard_trg ON stock;
DROP TRIGGER IF EXISTS fp_stock_movements_check_trg ON stock_movements;
DROP TRIGGER IF EXISTS fp_stock_movements_apply_trg ON stock_movements;
DROP TRIGGER IF EXISTS fp_stock_movements_immutable_trg ON stock_movements;

-- Строка остатка без ячейки — одна на товар и склад. Уникальный ключ (product_id, store_id, bin_id) её не
-- обеспечивал: NULL не равен NULL, и «INSERT … ON CONFLICT» старого модуля добавлял дубли вместо прибавления.
-- Дубли (если есть) сливаются в одну строку.
WITH dup AS (
  SELECT product_id, store_id, min(id) AS keep_id, sum(qty) AS qty, sum(reserved) AS reserved
  FROM stock WHERE bin_id IS NULL GROUP BY product_id, store_id HAVING count(*) > 1
), upd AS (
  UPDATE stock s SET qty = d.qty, reserved = d.reserved, updated_at = now() FROM dup d WHERE s.id = d.keep_id RETURNING s.id
)
DELETE FROM stock s USING dup d WHERE s.bin_id IS NULL AND s.product_id = d.product_id AND s.store_id = d.store_id AND s.id <> d.keep_id;
CREATE UNIQUE INDEX IF NOT EXISTS stock_one_row_without_bin ON stock (product_id, store_id) WHERE bin_id IS NULL;

-- Первичное заполнение: остаток, накопленный до журнала, — одно движение OPENING (BACKFILL) на разницу между
-- остатком и суммой движений. Повторный запуск ничего не добавляет (разница 0).
INSERT INTO stock_movements (id, tenant_id, organization_id, product_id, store_id, bin_id, qty, value, value_basis, kind,
                             source_type, source_id, reason, occurred_at, created_at)
SELECT gen_random_uuid()::text, s.tenant_id, st.organization_id, s.product_id, s.store_id, s.bin_id, s.qty - coalesce(m.qty, 0),
       NULL, 'OPENING', 'OPENING', 'BACKFILL', 'fp030', 'Остаток на момент включения журнала движений', now(), now()
FROM stock s
JOIN stores st ON st.id = s.store_id
LEFT JOIN LATERAL (SELECT sum(qty) AS qty FROM stock_movements x
                   WHERE x.product_id = s.product_id AND x.store_id = s.store_id AND x.bin_id IS NOT DISTINCT FROM s.bin_id) m ON true
WHERE s.qty - coalesce(m.qty, 0) <> 0;

-- ── Проверка движения перед записью ──
CREATE OR REPLACE FUNCTION fp_stock_movements_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  o stock_movements%ROWTYPE;
BEGIN
  IF NEW.qty = 0 THEN
    RAISE EXCEPTION 'STOCK_MOVE_ZERO: движение без количества' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.source_type IS NULL OR NEW.source_id IS NULL OR NEW.kind IS NULL THEN
    RAISE EXCEPTION 'STOCK_MOVE_SOURCE: у движения нет источника' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.source_type = 'BACKFILL' AND NOT fp_stock_maintenance() THEN
    RAISE EXCEPTION 'STOCK_MOVE_SOURCE: первичное заполнение — только при обслуживании' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.reverses_id IS NOT NULL THEN
    SELECT * INTO o FROM stock_movements WHERE id = NEW.reverses_id;
    IF NOT FOUND OR o.reverses_id IS NOT NULL OR o.qty <> -NEW.qty OR o.product_id <> NEW.product_id OR o.store_id <> NEW.store_id
       OR o.bin_id IS DISTINCT FROM NEW.bin_id OR o.organization_id <> NEW.organization_id THEN
      RAISE EXCEPTION 'STOCK_MOVE_REVERSAL: встречное движение не совпадает с исходным %', NEW.reverses_id USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fp_stock_movements_check_trg BEFORE INSERT ON stock_movements FOR EACH ROW EXECUTE FUNCTION fp_stock_movements_check();

-- ── Движение меняет остаток ──
CREATE OR REPLACE FUNCTION fp_stock_movements_apply() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source_type = 'BACKFILL' THEN
    RETURN NULL; -- остаток уже есть, движение только объясняет его
  END IF;
  IF NEW.bin_id IS NULL THEN
    INSERT INTO stock (id, tenant_id, product_id, store_id, bin_id, qty, reserved, updated_at)
    VALUES (gen_random_uuid()::text, NEW.tenant_id, NEW.product_id, NEW.store_id, NULL, NEW.qty, 0, now())
    ON CONFLICT (product_id, store_id) WHERE bin_id IS NULL DO UPDATE SET qty = stock.qty + EXCLUDED.qty, updated_at = now();
  ELSE
    INSERT INTO stock (id, tenant_id, product_id, store_id, bin_id, qty, reserved, updated_at)
    VALUES (gen_random_uuid()::text, NEW.tenant_id, NEW.product_id, NEW.store_id, NEW.bin_id, NEW.qty, 0, now())
    ON CONFLICT (product_id, store_id, bin_id) DO UPDATE SET qty = stock.qty + EXCLUDED.qty, updated_at = now();
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER fp_stock_movements_apply_trg AFTER INSERT ON stock_movements FOR EACH ROW EXECUTE FUNCTION fp_stock_movements_apply();

-- ── Движения неизменяемы ──
CREATE OR REPLACE FUNCTION fp_stock_movements_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND fp_stock_maintenance() THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'ACC_IMMUTABLE: складские движения неизменяемы — отмена встречным движением' USING ERRCODE = 'P0001';
END $$;
CREATE TRIGGER fp_stock_movements_immutable_trg BEFORE UPDATE OR DELETE ON stock_movements FOR EACH ROW EXECUTE FUNCTION fp_stock_movements_immutable();

-- ── Количество в stock — только из журнала ──
-- pg_trigger_depth() > 1: запись пришла из триггера движения. Резерв (reserved) меняется напрямую.
CREATE OR REPLACE FUNCTION fp_stock_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() > 1 OR fp_stock_maintenance() THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF (TG_OP = 'INSERT' AND NEW.qty <> 0)
     OR (TG_OP = 'UPDATE' AND (NEW.qty IS DISTINCT FROM OLD.qty OR NEW.product_id <> OLD.product_id OR NEW.store_id <> OLD.store_id
                               OR NEW.bin_id IS DISTINCT FROM OLD.bin_id))
     OR (TG_OP = 'DELETE' AND OLD.qty <> 0) THEN
    RAISE EXCEPTION 'STOCK_LEDGER_ONLY: остаток меняется только складским движением с источником' USING ERRCODE = 'P0001';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER fp_stock_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON stock FOR EACH ROW EXECUTE FUNCTION fp_stock_guard();
