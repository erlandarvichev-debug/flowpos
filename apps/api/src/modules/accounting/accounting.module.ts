import { Module } from '@nestjs/common';
import { AccountingController } from './accounting.controller';
import { OrgGuard } from './access/org-context';
import { IdempotencyInterceptor } from './common/idempotency.interceptor';
import { DocumentsService } from './documents/documents.service';
import { ReportsService } from './reports/reports.service';
import { ChartService } from './chart/chart.service';
import { RefsService } from './refs/refs.service';
import { PeriodsService } from './periods/periods.service';
import { PostingService } from './core/posting.service';
import { CostService } from './inventory/cost.service';
import { AutopilotService } from './autopilot/autopilot.service';
import { TradeDocumentsService } from './autopilot/trade-documents.service';
import { BankImportService } from './bank/bank-import.service';
import { EsfService } from './esf/esf.service';
import { EsfMonitorService } from './esf/esf-monitor.service';
import { OpsMetricsController } from './esf/ops-metrics.controller';
import { VatCreditService } from './vat/vat-credit.service';
import { StatementsService } from './statements/statements.service';
import { ClosingService } from './closing/closing.service';
import { PayrollService } from './payroll/payroll.service';

@Module({
  controllers: [AccountingController, OpsMetricsController],
  providers: [OrgGuard, IdempotencyInterceptor, DocumentsService, ReportsService, ChartService, RefsService, PeriodsService, PostingService, CostService, AutopilotService, TradeDocumentsService, BankImportService, EsfService, EsfMonitorService, StatementsService, ClosingService, PayrollService, VatCreditService],
  exports: [PayrollService, StatementsService, ClosingService, EsfService, AutopilotService, TradeDocumentsService, CostService, DocumentsService, ReportsService, ChartService, RefsService, PeriodsService, PostingService, OrgGuard],
})
export class AccountingModule {}
