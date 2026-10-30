import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService, runAsSystem } from '../../prisma.service';

@Injectable()
export class MartService {
  private readonly logger = new Logger(MartService.name);

  constructor(private prisma: PrismaService) {}

  /** Оперативные марты — каждые 5 минут: продажи сегодня, остатки */
  @Cron('*/5 * * * *')
  async refreshOperational() {
    // Витрины служебные (по всем клиентам, RLS — только системный режим), поэтому пересчёт — системно (FP-009).
    await runAsSystem(() => Promise.all([
      this.refreshSalesToday(),
      this.refreshStockSnapshot(),
    ]));
  }

  /** Тяжёлые марты — раз в ночь в 03:00 */
  @Cron('0 3 * * *')
  async refreshNightly() {
    await runAsSystem(() => Promise.all([
      this.refreshSalesDaily(),
      this.refreshPayroll(),
      this.refreshShiftCoverage(),
    ]));
  }

  /** MartSalesDaily — свёртка по дням за последние 90 дней */
  private async refreshSalesDaily() {
    const start = performance.now();
    try {
      await this.prisma.$executeRaw`
        INSERT INTO analytics.mart_sales_daily (date, organization_id, store_id, product_id, qty, revenue, cost, margin)
        SELECT
          d.date::date                       AS date,
          d.organization_id,
          d.store_id,
          dl.product_id,
          SUM(dl.qty)                        AS qty,
          SUM(dl.qty * dl.price)             AS revenue,
          SUM(dl.qty * COALESCE(p.cost, 0))  AS cost,
          SUM(dl.qty * (dl.price - COALESCE(p.cost, 0))) AS margin
        FROM documents d
        JOIN document_lines dl ON dl.document_id = d.id
        JOIN products p ON p.id = dl.product_id
        WHERE d.doc_type IN ('DEMAND', 'RETAIL_DEMAND')
          AND d.status = 'POSTED'
          AND d.date >= CURRENT_DATE - INTERVAL '90 days'
        GROUP BY d.date::date, d.organization_id, d.store_id, dl.product_id
        ON CONFLICT (date, organization_id, store_id, product_id)
        DO UPDATE SET
          qty      = EXCLUDED.qty,
          revenue  = EXCLUDED.revenue,
          cost     = EXCLUDED.cost,
          margin   = EXCLUDED.margin,
          refreshed_at = NOW()
      `;
      this.logger.log(`MartSalesDaily refreshed in ${Math.round(performance.now() - start)}ms`);
    } catch (err: any) {
      this.logger.error(`MartSalesDaily error: ${err.message}`);
    }
  }

  /** MartSalesDaily за сегодня — быстрый инкремент */
  private async refreshSalesToday() {
    try {
      await this.prisma.$executeRaw`
        INSERT INTO analytics.mart_sales_daily (date, organization_id, store_id, product_id, qty, revenue, cost, margin)
        SELECT
          CURRENT_DATE,
          d.organization_id,
          d.store_id,
          dl.product_id,
          SUM(dl.qty),
          SUM(dl.qty * dl.price),
          SUM(dl.qty * COALESCE(p.cost, 0)),
          SUM(dl.qty * (dl.price - COALESCE(p.cost, 0)))
        FROM documents d
        JOIN document_lines dl ON dl.document_id = d.id
        JOIN products p ON p.id = dl.product_id
        WHERE d.doc_type IN ('DEMAND', 'RETAIL_DEMAND')
          AND d.status = 'POSTED'
          AND d.date::date = CURRENT_DATE
        GROUP BY d.organization_id, d.store_id, dl.product_id
        ON CONFLICT (date, organization_id, store_id, product_id)
        DO UPDATE SET
          qty      = EXCLUDED.qty,
          revenue  = EXCLUDED.revenue,
          cost     = EXCLUDED.cost,
          margin   = EXCLUDED.margin,
          refreshed_at = NOW()
      `;
    } catch (err: any) {
      this.logger.error(`MartSalesDaily (today) error: ${err.message}`);
    }
  }

  /** MartStockSnapshot — снапшот остатков */
  private async refreshStockSnapshot() {
    try {
      await this.prisma.$executeRaw`
        INSERT INTO analytics.mart_stock_snapshot (snapped_at, organization_id, store_id, product_id, qty, reserved, available)
        SELECT
          NOW(),
          p.organization_id,
          s.store_id,
          s.product_id,
          s.qty,
          s.reserved,
          s.qty - s.reserved
        FROM stocks s
        JOIN products p ON p.id = s.product_id
        ON CONFLICT (store_id, product_id)
        DO UPDATE SET
          snapped_at  = EXCLUDED.snapped_at,
          qty         = EXCLUDED.qty,
          reserved    = EXCLUDED.reserved,
          available   = EXCLUDED.available
      `;
    } catch (err: any) {
      this.logger.error(`MartStockSnapshot error: ${err.message}`);
    }
  }

  /** MartPayroll — начисления за последние 3 месяца */
  private async refreshPayroll() {
    try {
      await this.prisma.$executeRaw`
        INSERT INTO analytics.mart_payroll (year, month, organization_id, department_id, employee_id, hours_fact, gross, deductions, net)
        SELECT
          EXTRACT(YEAR  FROM p.period)::int,
          EXTRACT(MONTH FROM p.period)::int,
          e.organization_id,
          e.department_id,
          p.employee_id,
          COALESCE(ts_agg.hours, 0),
          p.gross,
          p.deductions,
          p.net
        FROM payrolls p
        JOIN employees e ON e.id = p.employee_id
        LEFT JOIN (
          SELECT tr.employee_id,
                 DATE_TRUNC('month', tr.period) AS month,
                 SUM(tr.hours_fact) AS hours
          FROM time_sheet_rows tr
          GROUP BY tr.employee_id, DATE_TRUNC('month', tr.period)
        ) ts_agg ON ts_agg.employee_id = p.employee_id
          AND ts_agg.month = DATE_TRUNC('month', p.period)
        WHERE p.period >= CURRENT_DATE - INTERVAL '3 months'
        ON CONFLICT (year, month, employee_id)
        DO UPDATE SET
          hours_fact    = EXCLUDED.hours_fact,
          gross         = EXCLUDED.gross,
          deductions    = EXCLUDED.deductions,
          net           = EXCLUDED.net,
          refreshed_at  = NOW()
      `;
    } catch (err: any) {
      this.logger.error(`MartPayroll error: ${err.message}`);
    }
  }

  /** MartShiftCoverage — покрытие смен */
  private async refreshShiftCoverage() {
    try {
      await this.prisma.$executeRaw`
        INSERT INTO analytics.mart_shift_coverage (date, organization_id, store_id, planned, filled, open_shifts)
        SELECT
          sp.date,
          sp.organization_id,
          sp.store_id,
          COUNT(*)                                             AS planned,
          COUNT(*) FILTER (WHERE sp.employee_id IS NOT NULL)  AS filled,
          COUNT(*) FILTER (WHERE sp.employee_id IS NULL)      AS open_shifts
        FROM shift_plans sp
        WHERE sp.date >= CURRENT_DATE - INTERVAL '30 days'
        GROUP BY sp.date, sp.organization_id, sp.store_id
        ON CONFLICT (date, organization_id, store_id)
        DO UPDATE SET
          planned     = EXCLUDED.planned,
          filled      = EXCLUDED.filled,
          open_shifts = EXCLUDED.open_shifts,
          refreshed_at = NOW()
      `;
    } catch (err: any) {
      this.logger.error(`MartShiftCoverage error: ${err.message}`);
    }
  }
}
