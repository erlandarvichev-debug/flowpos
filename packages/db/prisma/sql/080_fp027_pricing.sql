-- FP-027: снимок цен для кассы неизменяем — новая цена или скидка публикуются новой версией снимка.
CREATE OR REPLACE FUNCTION fp_pricing_snapshot_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Снимок цен неизменяем: опубликуйте новую версию';
END $$;
DROP TRIGGER IF EXISTS fp_pricing_snapshot_immutable_trg ON pricing_snapshots;
CREATE TRIGGER fp_pricing_snapshot_immutable_trg BEFORE UPDATE OR DELETE ON pricing_snapshots
  FOR EACH ROW EXECUTE FUNCTION fp_pricing_snapshot_immutable();
