-- Этап 2: складские движения — допустимые значения и неизменяемость (кроме is_active)
DO $$ BEGIN
  ALTER TABLE acc_stock_moves ADD CONSTRAINT acc_stock_moves_dir_chk CHECK (direction IN ('IN','OUT'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE acc_stock_moves ADD CONSTRAINT acc_stock_moves_qty_chk CHECK (quantity > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION acc_stock_moves_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'ACC_IMMUTABLE: удаление складских движений запрещено'; END IF;
  IF (NEW.entry_id, NEW.product_id, NEW.store_id, NEW.direction, NEW.quantity, NEW.known_cost, NEW.date)
     IS DISTINCT FROM (OLD.entry_id, OLD.product_id, OLD.store_id, OLD.direction, OLD.quantity, OLD.known_cost, OLD.date) THEN
    RAISE EXCEPTION 'ACC_IMMUTABLE: изменение складских движений запрещено';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS acc_stock_moves_immutable_trg ON acc_stock_moves;
CREATE TRIGGER acc_stock_moves_immutable_trg BEFORE UPDATE OR DELETE ON acc_stock_moves
  FOR EACH ROW EXECUTE FUNCTION acc_stock_moves_immutable();
