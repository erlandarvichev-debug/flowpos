-- FP-033: партии. Остаток партии (товар, склад, ячейка, партия) не уходит в минус — проверка после применения движения:
-- триггер применения уже заблокировал строку остатка (apply < lot по имени — порядок триггеров), поэтому параллельные
-- расходы одной партии идут по очереди и второй видит движение первого. Движения без партии не проверяются. Идемпотентно.
DROP TRIGGER IF EXISTS fp_stock_movements_lot_trg ON stock_movements;

CREATE OR REPLACE FUNCTION fp_stock_movements_lot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  bal numeric;
BEGIN
  IF NEW.lot_number IS NULL OR NEW.qty >= 0 OR NEW.source_type = 'BACKFILL' THEN
    RETURN NULL;
  END IF;
  SELECT coalesce(sum(qty), 0) INTO bal FROM stock_movements
  WHERE product_id = NEW.product_id AND store_id = NEW.store_id AND bin_id IS NOT DISTINCT FROM NEW.bin_id AND lot_number = NEW.lot_number;
  IF bal < 0 THEN
    RAISE EXCEPTION 'LOT_INSUFFICIENT: партии % не хватает %', NEW.lot_number, -bal USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER fp_stock_movements_lot_trg AFTER INSERT ON stock_movements FOR EACH ROW EXECUTE FUNCTION fp_stock_movements_lot();
