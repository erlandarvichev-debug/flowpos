-- FP-024 (expand): номер и дата входящего ЭСФ уникальны в пределах продавца (у разных поставщиков «№1 от 01.10»
-- законно совпадают). Новая уникальность строго слабее прежней (те же столбцы + seller_tin), поэтому существующие
-- данные ей не противоречат. Индекс создаётся здесь под именем Prisma, чтобы `db push` без --accept-data-loss
-- увидел его готовым и только снял прежний. На новой БД (таблицы ещё нет) ничего не делает.
DO $$
BEGIN
  IF to_regclass('public.esf_invoices') IS NULL THEN
    RETURN;
  END IF;
  CREATE UNIQUE INDEX IF NOT EXISTS esf_invoices_organization_id_environment_direction_seller_t_key
    ON esf_invoices (organization_id, environment, direction, seller_tin, num, date);
END $$;
