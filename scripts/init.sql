-- Initialize FlowPOS database schemas
CREATE SCHEMA IF NOT EXISTS mirror;
CREATE SCHEMA IF NOT EXISTS analytics;

-- Enable extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ─── Analytics Mart Tables ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS analytics.mart_sales_daily (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  date            DATE NOT NULL,
  organization_id UUID NOT NULL,
  store_id        UUID,
  product_id      UUID NOT NULL,
  qty             NUMERIC(14, 4) NOT NULL DEFAULT 0,
  revenue         NUMERIC(14, 2) NOT NULL DEFAULT 0,
  cost            NUMERIC(14, 2) NOT NULL DEFAULT 0,
  margin          NUMERIC(14, 2) NOT NULL DEFAULT 0,
  refreshed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (date, organization_id, store_id, product_id)
);

CREATE TABLE IF NOT EXISTS analytics.mart_stock_snapshot (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  snapped_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  organization_id UUID,
  store_id        UUID NOT NULL,
  product_id      UUID NOT NULL,
  qty             NUMERIC(14, 4) NOT NULL DEFAULT 0,
  reserved        NUMERIC(14, 4) NOT NULL DEFAULT 0,
  available       NUMERIC(14, 4) NOT NULL DEFAULT 0,
  UNIQUE (store_id, product_id)
);

CREATE TABLE IF NOT EXISTS analytics.mart_payroll (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  year            SMALLINT NOT NULL,
  month           SMALLINT NOT NULL,
  organization_id UUID,
  department_id   UUID,
  employee_id     UUID NOT NULL,
  hours_fact      NUMERIC(8, 2) NOT NULL DEFAULT 0,
  gross           NUMERIC(14, 2) NOT NULL DEFAULT 0,
  deductions      NUMERIC(14, 2) NOT NULL DEFAULT 0,
  net             NUMERIC(14, 2) NOT NULL DEFAULT 0,
  refreshed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (year, month, employee_id)
);

CREATE TABLE IF NOT EXISTS analytics.mart_shift_coverage (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  date            DATE NOT NULL,
  organization_id UUID,
  store_id        UUID NOT NULL,
  planned         INT NOT NULL DEFAULT 0,
  filled          INT NOT NULL DEFAULT 0,
  open_shifts     INT NOT NULL DEFAULT 0,
  refreshed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (date, organization_id, store_id)
);

-- Индексы для аналитических запросов
CREATE INDEX IF NOT EXISTS idx_mart_sales_daily_date ON analytics.mart_sales_daily (date);
CREATE INDEX IF NOT EXISTS idx_mart_sales_daily_org ON analytics.mart_sales_daily (organization_id, date);
CREATE INDEX IF NOT EXISTS idx_mart_stock_snapshot_store ON analytics.mart_stock_snapshot (store_id);
CREATE INDEX IF NOT EXISTS idx_mart_payroll_period ON analytics.mart_payroll (year, month, organization_id);
CREATE INDEX IF NOT EXISTS idx_mart_shift_coverage_date ON analytics.mart_shift_coverage (date, organization_id);
