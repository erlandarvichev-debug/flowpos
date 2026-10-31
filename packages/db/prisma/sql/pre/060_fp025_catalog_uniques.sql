-- FP-025 (expand): уникальности каталога, которые `db push` без --accept-data-loss сам не поставит.
--  • штрихкод уникален в пределах клиента (было — во всей БД): строго слабее прежнего, данные ему не противоречат;
--  • PLU весового товара и ключ варианта — новые столбцы (у существующих строк NULL, уникальности не мешают).
-- Индексы создаются под именами Prisma, чтобы db push увидел их готовыми. На новой БД ничего не делает.
DO $$
BEGIN
  IF to_regclass('public.products') IS NULL THEN
    RETURN;
  END IF;
  ALTER TABLE products ADD COLUMN IF NOT EXISTS plu text;
  ALTER TABLE products ADD COLUMN IF NOT EXISTS variant_key text;
  CREATE UNIQUE INDEX IF NOT EXISTS products_tenant_id_plu_key ON products (tenant_id, plu);
  CREATE UNIQUE INDEX IF NOT EXISTS products_tenant_id_parent_id_variant_key_key ON products (tenant_id, parent_id, variant_key);
  IF to_regclass('public.product_barcodes') IS NOT NULL THEN
    CREATE UNIQUE INDEX IF NOT EXISTS product_barcodes_tenant_id_barcode_key ON product_barcodes (tenant_id, barcode);
  END IF;
END $$;
