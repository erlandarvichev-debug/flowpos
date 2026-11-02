-- FP-032: резервы. Свободно = факт − резервы (по товару и складу, все ячейки). Резервируется только свободное —
-- проверка в БД под блокировкой строки остатка без ячейки (точка сериализации: два параллельных резерва не займут одно
-- и то же количество). stock.reserved меняется только этими триггерами. Идемпотентно.

DROP TRIGGER IF EXISTS fp_stock_reservations_insert_trg ON stock_reservations;
DROP TRIGGER IF EXISTS fp_stock_reservations_update_trg ON stock_reservations;
DROP TRIGGER IF EXISTS fp_stock_reservations_delete_trg ON stock_reservations;

-- Резерв строки документа — один действующий.
CREATE UNIQUE INDEX IF NOT EXISTS stock_reservations_one_active_per_line ON stock_reservations (source_type, source_id, source_line) WHERE remaining > 0;
DO $$ BEGIN
  ALTER TABLE stock_reservations ADD CONSTRAINT stock_reservations_qty_chk CHECK (qty > 0 AND remaining >= 0 AND remaining <= qty);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE stock ADD CONSTRAINT stock_reserved_chk CHECK (reserved >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Резерв в stock до FP-032 никто не вёл — приводим к сумме действующих резервов (обычно 0).
SELECT set_config('flowpos.stock_maintenance', 'on', false);
UPDATE stock s SET reserved = 0 WHERE s.reserved <> 0 AND s.bin_id IS NOT NULL;
UPDATE stock s SET reserved = coalesce(r.rem, 0)
FROM (SELECT st.id, (SELECT sum(remaining) FROM stock_reservations x WHERE x.product_id = st.product_id AND x.store_id = st.store_id) AS rem
      FROM stock st WHERE st.bin_id IS NULL) r
WHERE r.id = s.id AND s.reserved IS DISTINCT FROM coalesce(r.rem, 0);
SELECT set_config('flowpos.stock_maintenance', '', false);

/** Свободный остаток товара на складе (все ячейки). */
CREATE OR REPLACE FUNCTION fp_stock_available(p_product text, p_store text) RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT coalesce(sum(qty), 0) - coalesce(sum(reserved), 0) FROM stock WHERE product_id = p_product AND store_id = p_store
$$;

CREATE OR REPLACE FUNCTION fp_stock_reservations_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  avail numeric;
BEGIN
  NEW.remaining := NEW.qty;
  IF NEW.qty <= 0 THEN
    RAISE EXCEPTION 'RESERVE_QTY: количество резерва должно быть больше нуля' USING ERRCODE = 'P0001';
  END IF;
  -- Точка сериализации: строка остатка без ячейки (создаётся с нулём, если её нет) — под блокировкой.
  INSERT INTO stock (id, tenant_id, product_id, store_id, bin_id, qty, reserved, updated_at)
  VALUES (gen_random_uuid()::text, NEW.tenant_id, NEW.product_id, NEW.store_id, NULL, 0, 0, now())
  ON CONFLICT (product_id, store_id) WHERE bin_id IS NULL DO NOTHING;
  PERFORM 1 FROM stock WHERE product_id = NEW.product_id AND store_id = NEW.store_id AND bin_id IS NULL FOR UPDATE;
  avail := fp_stock_available(NEW.product_id, NEW.store_id);
  IF NEW.qty > avail THEN
    RAISE EXCEPTION 'RESERVE_INSUFFICIENT: свободно %, нужно %', greatest(avail, 0), NEW.qty USING ERRCODE = 'P0001';
  END IF;
  UPDATE stock SET reserved = reserved + NEW.qty, updated_at = now()
  WHERE product_id = NEW.product_id AND store_id = NEW.store_id AND bin_id IS NULL;
  RETURN NEW;
END $$;
CREATE TRIGGER fp_stock_reservations_insert_trg BEFORE INSERT ON stock_reservations FOR EACH ROW EXECUTE FUNCTION fp_stock_reservations_insert();

CREATE OR REPLACE FUNCTION fp_stock_reservations_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.qty, NEW.product_id, NEW.store_id, NEW.organization_id, NEW.source_type, NEW.source_id, NEW.source_line)
     IS DISTINCT FROM (OLD.qty, OLD.product_id, OLD.store_id, OLD.organization_id, OLD.source_type, OLD.source_id, OLD.source_line) THEN
    RAISE EXCEPTION 'RESERVE_IMMUTABLE: резерв меняется только уменьшением остатка резерва' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.remaining > OLD.remaining THEN
    RAISE EXCEPTION 'RESERVE_IMMUTABLE: резерв нельзя увеличить — оформите новый' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.remaining < OLD.remaining THEN
    UPDATE stock SET reserved = reserved - (OLD.remaining - NEW.remaining), updated_at = now()
    WHERE product_id = NEW.product_id AND store_id = NEW.store_id AND bin_id IS NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fp_stock_reservations_update_trg BEFORE UPDATE ON stock_reservations FOR EACH ROW EXECUTE FUNCTION fp_stock_reservations_update();

CREATE OR REPLACE FUNCTION fp_stock_reservations_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF fp_stock_maintenance() THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'RESERVE_IMMUTABLE: резерв не удаляется — снимите его (остаток резерва 0)' USING ERRCODE = 'P0001';
END $$;
CREATE TRIGGER fp_stock_reservations_delete_trg BEFORE DELETE ON stock_reservations FOR EACH ROW EXECUTE FUNCTION fp_stock_reservations_delete();
