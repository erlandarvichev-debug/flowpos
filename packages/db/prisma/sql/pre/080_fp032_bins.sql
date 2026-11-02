-- FP-032: составной ключ ячейки «склад + ячейка» (ячейка строки документа — ячейка своего склада) до db push.
DO $$ BEGIN
  IF to_regclass('public.bins') IS NOT NULL THEN
    CREATE UNIQUE INDEX IF NOT EXISTS bins_store_id_id_key ON bins (store_id, id);
  END IF;
END $$;
