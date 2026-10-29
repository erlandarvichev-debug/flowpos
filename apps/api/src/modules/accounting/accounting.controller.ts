import { Body, Controller, Get, Param, Post, Put, Query, Res, UseGuards, UseInterceptors } from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Org, OrgContext, OrgGuard, RequirePermission } from './access/org-context';
import { IdempotencyInterceptor } from './common/idempotency.interceptor';
import { DocumentsService } from './documents/documents.service';
import { ReportsService } from './reports/reports.service';
import { ChartService } from './chart/chart.service';
import { RefsService } from './refs/refs.service';
import { PeriodsService } from './periods/periods.service';
import { AutopilotService } from './autopilot/autopilot.service';
import { TradeDocumentsService } from './autopilot/trade-documents.service';
import { BankImportService } from './bank/bank-import.service';
import { EsfService } from './esf/esf.service';
import { StatementsService } from './statements/statements.service';
import { fileName, toPdf, toXlsx, trialBalanceXlsx } from './statements/statement-export';
import { AccError } from './common/acc-error';
import { ClosingService } from './closing/closing.service';
import { PayrollService } from './payroll/payroll.service';
import { payrollRegistryXlsx } from './payroll/payroll-export';
import { MONEY_OPERATIONS, MONEY_OPERATION_LABELS } from './core/rules/money-rules';

const ORG_HEADER = { name: 'X-Organization-Id', required: false, description: 'Организация (по умолчанию — организация пользователя)' };
const IDEMP_HEADER = { name: 'Idempotency-Key', required: false, description: 'Ключ идемпотентности для безопасного повтора' };

@ApiTags('accounting')
@ApiBearerAuth()
@ApiHeader(ORG_HEADER)
@UseGuards(JwtAuthGuard, OrgGuard)
@UseInterceptors(IdempotencyInterceptor)
@Controller('accounting')
export class AccountingController {
  constructor(
    private docs: DocumentsService,
    private reports: ReportsService,
    private chart: ChartService,
    private refs: RefsService,
    private periods: PeriodsService,
    private autopilot: AutopilotService,
    private trade: TradeDocumentsService,
    private bank: BankImportService,
    private esf: EsfService,
    private statements: StatementsService,
    private closing: ClosingService,
    private payroll: PayrollService,
  ) {}

  // ── Кадры и зарплата ──
  @Get('hr/employees') @RequirePermission('hr.read')
  hrEmployees(@Org() ctx: OrgContext) { return this.payroll.employees(ctx); }

  @Post('hr/hire') @RequirePermission('hr.manage') @ApiHeader(IDEMP_HEADER)
  hrHire(@Org() ctx: OrgContext, @Body() b: any) { return this.payroll.hire(ctx, b); }

  @Post('hr/contracts/:id/change') @RequirePermission('hr.manage')
  hrChange(@Org() ctx: OrgContext, @Param('id') id: string, @Body() b: any) { return this.payroll.change(ctx, id, b); }

  @Post('hr/contracts/:id/terminate') @RequirePermission('hr.manage')
  hrTerminate(@Org() ctx: OrgContext, @Param('id') id: string, @Body() b: any) { return this.payroll.terminate(ctx, id, b); }

  @Post('hr/contracts/:id/accruals') @RequirePermission('hr.manage')
  hrAccrual(@Org() ctx: OrgContext, @Param('id') id: string, @Body() b: any) { return this.payroll.addAccrual(ctx, id, b); }

  @Get('payroll/:period') @RequirePermission('hr.read')
  payrollGet(@Org() ctx: OrgContext, @Param('period') period: string) { return this.payroll.get(ctx, period); }

  @Post('payroll/:period/calculate') @RequirePermission('hr.manage')
  payrollCalc(@Org() ctx: OrgContext, @Param('period') period: string, @Body() b: any) { return this.payroll.calculate(ctx, period, b?.overrides ?? {}); }

  @Post('payroll/:period/approve') @RequirePermission('payroll.approve') @ApiHeader(IDEMP_HEADER)
  payrollApprove(@Org() ctx: OrgContext, @Param('period') period: string) { return this.payroll.approve(ctx, period); }

  @Post('payroll/:period/unapprove') @RequirePermission('payroll.approve')
  payrollUnapprove(@Org() ctx: OrgContext, @Param('period') period: string, @Body() b: any) { return this.payroll.unapprove(ctx, period, b?.reason); }

  @Get('payroll/:period/payout') @RequirePermission('hr.read')
  payrollPayoutLines(@Org() ctx: OrgContext, @Param('period') period: string) { return this.payroll.payoutLines(ctx, period); }

  @Post('payroll/:period/payout') @RequirePermission('acc.doc.write') @ApiHeader(IDEMP_HEADER)
  payrollPayout(@Org() ctx: OrgContext, @Param('period') period: string, @Body() b: any) { return this.payroll.createPayout(ctx, period, b); }

  /** Реестры: salary (ведомость для банка), pension (ОПВ/ОПВР), so (СО), osms (ВОСМС/ООСМС). */
  @Get('payroll/:period/registry/:kind') @RequirePermission('hr.read')
  async payrollRegistry(@Org() ctx: OrgContext, @Param('period') period: string, @Param('kind') kind: string, @Res() res: Response) {
    const p = await this.payroll.get(ctx, period);
    const org = await this.statements.organizationInfo(ctx);
    const emps = await this.payroll.employees(ctx);
    const { buf, name } = await payrollRegistryXlsx(kind, period, p, org, emps);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.send(buf);
  }

  // ── Финансовая отчётность (формы приказа № 404) ──
  @Get('statements/balance') @RequirePermission('acc.reports.read')
  stBalance(@Org() ctx: OrgContext, @Query() q: any) { return this.statements.balance(ctx, q); }

  @Get('statements/profit-loss') @RequirePermission('acc.reports.read')
  stPl(@Org() ctx: OrgContext, @Query() q: any) { return this.statements.profitLoss(ctx, q); }

  @Get('statements/cash-flow') @RequirePermission('acc.reports.read')
  stCf(@Org() ctx: OrgContext, @Query() q: any) { return this.statements.cashFlow(ctx, q); }

  /** Выгрузка формы: form = balance | profit-loss | cash-flow, format = xlsx | pdf. */
  @Get('statements/:form/export') @RequirePermission('acc.reports.read')
  async stExport(@Org() ctx: OrgContext, @Param('form') form: string, @Query() q: any, @Res() res: Response) {
    const st = form === 'balance' ? await this.statements.balance(ctx, q) : form === 'profit-loss' ? await this.statements.profitLoss(ctx, q) : form === 'cash-flow' ? await this.statements.cashFlow(ctx, q) : null;
    if (!st) throw new AccError('BAD_FORM', 'Форма: balance, profit-loss или cash-flow');
    const pdf = q.format === 'pdf';
    const buf = pdf ? await toPdf(st) : await toXlsx(st);
    res.setHeader('Content-Type', pdf ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName(st, pdf ? 'pdf' : 'xlsx')}"`);
    res.send(buf);
  }

  @Get('reports/trial-balance/export') @RequirePermission('acc.reports.read')
  async tbExport(@Org() ctx: OrgContext, @Query() q: any, @Res() res: Response) {
    const tb = await this.reports.trialBalance(ctx, q);
    const org = await this.statements.organizationInfo(ctx);
    const buf = await trialBalanceXlsx(tb, org, { from: tb.from, to: tb.to }, tb.ledger);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="osv_${org.bin ?? 'org'}_${tb.from}_${tb.to}.xlsx"`);
    res.send(buf);
  }

  // ── Закрытие месяца ──
  @Get('closing') @RequirePermission('acc.reports.read')
  closingHistory(@Org() ctx: OrgContext) { return this.closing.history(ctx); }

  @Get('closing/:period') @RequirePermission('acc.reports.read')
  closingStatus(@Org() ctx: OrgContext, @Param('period') period: string) { return this.closing.status(ctx, period); }

  @Post('closing/:period/close') @RequirePermission('acc.period.lock') @ApiHeader(IDEMP_HEADER)
  closingClose(@Org() ctx: OrgContext, @Param('period') period: string) { return this.closing.close(ctx, period); }

  @Post('closing/:period/reopen') @RequirePermission('acc.period.override')
  closingReopen(@Org() ctx: OrgContext, @Param('period') period: string, @Body() b: any) { return this.closing.reopen(ctx, period, b?.reason); }

  // ── ЭСФ (ИС ЭСФ КГД) ──
  @Get('esf/settings') @RequirePermission('acc.esf.read')
  esfSettings(@Org() ctx: OrgContext) { return this.esf.settings(ctx); }

  @Put('esf/settings') @RequirePermission('acc.policy.manage')
  esfSettingsUpdate(@Org() ctx: OrgContext, @Body() b: any) { return this.esf.updateSettings(ctx, b); }

  @Get('esf/summary') @RequirePermission('acc.esf.read')
  esfSummary(@Org() ctx: OrgContext) { return this.esf.summary(ctx); }

  @Get('esf/invoices') @RequirePermission('acc.esf.read')
  esfList(@Org() ctx: OrgContext, @Query() q: any) { return this.esf.list(ctx, q); }

  @Get('esf/invoices/:id') @RequirePermission('acc.esf.read')
  esfGet(@Org() ctx: OrgContext, @Param('id') id: string) { return this.esf.get(ctx, id); }

  @Post('esf/prepare/:docId') @RequirePermission('acc.esf.send')
  esfPrepare(@Org() ctx: OrgContext, @Param('docId') docId: string) { return this.esf.prepare(ctx, docId); }

  @Post('esf/invoices/:id/discard') @RequirePermission('acc.esf.send')
  esfDiscard(@Org() ctx: OrgContext, @Param('id') id: string) { return this.esf.discard(ctx, id); }

  @Post('esf/session/ticket') @RequirePermission('acc.esf.send')
  esfTicket(@Org() ctx: OrgContext) { return this.esf.ticket(ctx); }

  @Post('esf/session') @RequirePermission('acc.esf.send')
  esfOpen(@Org() ctx: OrgContext, @Body() b: any) { return this.esf.openSession(ctx, b?.signedTicket); }

  @Post('esf/session/close') @RequirePermission('acc.esf.send')
  esfClose(@Org() ctx: OrgContext) { return this.esf.closeSession(ctx); }

  @Post('esf/sign-data') @RequirePermission('acc.esf.send')
  esfSignData(@Org() ctx: OrgContext, @Body() b: any) { return this.esf.signData(ctx, b?.ids ?? []); }

  @Post('esf/upload') @RequirePermission('acc.esf.send')
  esfUpload(@Org() ctx: OrgContext, @Body() b: any) { return this.esf.upload(ctx, b); }

  /** Отзыв (исходящие), подтверждение/отклонение исправленных и дополнительных, подтверждение отзыва (входящие). */
  @Post('esf/actions/data') @RequirePermission('acc.esf.send')
  esfActionData(@Org() ctx: OrgContext, @Body() b: any) { return this.esf.actionData(ctx, b); }

  @Post('esf/actions') @RequirePermission('acc.esf.send')
  esfAction(@Org() ctx: OrgContext, @Body() b: any) { return this.esf.action(ctx, b); }

  @Post('esf/invoices/:id/release-unknown') @RequirePermission('acc.esf.send')
  esfReleaseUnknown(@Org() ctx: OrgContext, @Param('id') id: string, @Body() b: any) { return this.esf.releaseUnknown(ctx, id, b?.reason); }

  @Post('esf/refresh') @RequirePermission('acc.esf.read')
  esfRefresh(@Org() ctx: OrgContext) { return this.esf.refresh(ctx); }

  // ── Торговые документы (автопилот) ──
  @Get('trade-documents') @RequirePermission('acc.doc.read')
  tradeList(@Org() ctx: OrgContext, @Query() q: any) { return this.trade.list(ctx, q); }

  @Get('trade-documents/:id') @RequirePermission('acc.doc.read')
  tradeGet(@Org() ctx: OrgContext, @Param('id') id: string) { return this.trade.get(ctx, id); }

  @Post('trade-documents') @RequirePermission('acc.doc.write') @ApiHeader(IDEMP_HEADER)
  tradeCreate(@Org() ctx: OrgContext, @Body() b: any) {
    if (b?.status === 'POSTED' && !ctx.can('acc.doc.post')) throw new (require('./common/acc-error').AccError)('FORBIDDEN', 'Нет права проводить документы', { status: 403 });
    return this.trade.create(ctx, b, b?.override);
  }

  @Put('trade-documents/:id') @RequirePermission('acc.doc.write') @ApiHeader(IDEMP_HEADER)
  tradeUpdate(@Org() ctx: OrgContext, @Param('id') id: string, @Body() b: any) { return this.trade.update(ctx, id, b, b?.override); }

  @Post('trade-documents/:id/post') @RequirePermission('acc.doc.post') @ApiHeader(IDEMP_HEADER)
  tradePost(@Org() ctx: OrgContext, @Param('id') id: string, @Body() b: any) { return this.trade.post(ctx, id, b?.override); }

  @Post('trade-documents/:id/unpost') @RequirePermission('acc.doc.post') @ApiHeader(IDEMP_HEADER)
  tradeUnpost(@Org() ctx: OrgContext, @Param('id') id: string, @Body() b: any) { return this.trade.unpost(ctx, id, b?.override); }

  @Post('trade-documents/:id/cancel') @RequirePermission('acc.doc.cancel') @ApiHeader(IDEMP_HEADER)
  tradeCancel(@Org() ctx: OrgContext, @Param('id') id: string, @Body() b: any) { return this.trade.cancel(ctx, id, b?.override); }

  @Post('trade-documents/:id/restore') @RequirePermission('acc.doc.cancel') @ApiHeader(IDEMP_HEADER)
  tradeRestore(@Org() ctx: OrgContext, @Param('id') id: string) { return this.trade.restore(ctx, id); }

  @Get('contracts') @RequirePermission('acc.refs.read')
  contracts(@Query('counterpartyId') counterpartyId?: string) {
    return this.refs.contracts(counterpartyId);
  }

  @Post('trade-documents/:id/create-based') @RequirePermission('acc.doc.write') @ApiHeader(IDEMP_HEADER)
  tradeBased(@Org() ctx: OrgContext, @Param('id') id: string, @Body() b: { docType: string; date?: string }) { return this.trade.fromBase(ctx, id, b.docType, b.date); }

  // ── Автопилот ──
  @Get('autopilot/status') @RequirePermission('acc.doc.read')
  apStatus(@Org() ctx: OrgContext) { return this.autopilot.status(ctx); }

  @Get('autopilot/issues') @RequirePermission('acc.doc.read')
  apIssues(@Org() ctx: OrgContext, @Query('all') all?: string) { return this.autopilot.issues(ctx, all === 'true'); }

  @Post('autopilot/documents/:id/retry') @RequirePermission('acc.doc.post')
  apRetry(@Org() ctx: OrgContext, @Param('id') id: string) { return this.autopilot.process(id, { userId: ctx.userId, organizationId: ctx.organizationId }); }

  @Post('autopilot/resync') @RequirePermission('acc.doc.post')
  apResync(@Org() ctx: OrgContext) { return this.autopilot.resync(ctx); }

  // ── Банк ──
  @Get('money-operations') @RequirePermission('acc.doc.read')
  moneyOps() { return { operations: MONEY_OPERATIONS, labels: MONEY_OPERATION_LABELS }; }

  @Post('bank/statement/preview') @RequirePermission('acc.doc.write')
  bankPreview(@Org() ctx: OrgContext, @Body() b: any) { return this.bank.preview(ctx, b); }

  @Post('bank/statement/import') @RequirePermission('acc.doc.write') @ApiHeader(IDEMP_HEADER)
  bankImport(@Org() ctx: OrgContext, @Body() b: any) {
    if (b?.autoPost !== false && !ctx.can('acc.doc.post')) b.autoPost = false;
    return this.bank.commit(ctx, b);
  }

  // ── Отчёты: склад и расчёты ──
  @Get('reports/stock') @RequirePermission('acc.reports.read')
  stock(@Org() ctx: OrgContext, @Query() q: any) { return this.reports.stock(ctx, q); }

  @Get('reports/settlements') @RequirePermission('acc.reports.read')
  settlements(@Org() ctx: OrgContext, @Query() q: any) { return this.reports.settlements(ctx, q); }

  // ── Контекст ──
  @Get('context')
  context(@Org() ctx: OrgContext) {
    return { organizationId: ctx.organizationId, role: ctx.role, permissions: this.refs.roles().find((r) => r.code === ctx.role)?.permissions ?? [] };
  }

  // ── План счетов ──
  @Get('chart') @RequirePermission('acc.chart.read')
  chartList(@Org() ctx: OrgContext, @Query('date') date?: string) { return this.chart.list(ctx, date); }

  @Get('chart/dims') @RequirePermission('acc.chart.read')
  chartDims() { return this.chart.dims(); }

  @Post('chart/subaccounts') @RequirePermission('acc.chart.manage') @ApiHeader(IDEMP_HEADER)
  createSub(@Org() ctx: OrgContext, @Body() b: any) { return this.chart.createSubaccount(ctx, b); }

  // ── Документы ──
  @Get('document-types') @RequirePermission('acc.doc.read')
  docTypes() { return this.docs.docTypes(); }

  @Get('documents') @RequirePermission('acc.doc.read')
  list(@Org() ctx: OrgContext, @Query() q: any) { return this.docs.list(ctx, q); }

  @Get('documents/:id') @RequirePermission('acc.doc.read')
  get(@Org() ctx: OrgContext, @Param('id') id: string) { return this.docs.get(ctx, id); }

  @Post('documents') @RequirePermission('acc.doc.write') @ApiHeader(IDEMP_HEADER)
  create(@Org() ctx: OrgContext, @Body() b: any) { return this.docs.create(ctx, b); }

  @Put('documents/:id') @RequirePermission('acc.doc.write') @ApiHeader(IDEMP_HEADER)
  update(@Org() ctx: OrgContext, @Param('id') id: string, @Body() b: any) { return this.docs.update(ctx, id, b); }

  @Post('documents/:id/post') @RequirePermission('acc.doc.post') @ApiHeader(IDEMP_HEADER)
  post(@Org() ctx: OrgContext, @Param('id') id: string, @Body() b: any) { return this.docs.post(ctx, id, b || {}); }

  @Post('documents/:id/unpost') @RequirePermission('acc.doc.post') @ApiHeader(IDEMP_HEADER)
  unpost(@Org() ctx: OrgContext, @Param('id') id: string, @Body() b: any) { return this.docs.unpost(ctx, id, b || {}); }

  @Post('documents/:id/cancel') @RequirePermission('acc.doc.cancel') @ApiHeader(IDEMP_HEADER)
  cancel(@Org() ctx: OrgContext, @Param('id') id: string, @Body() b: any) { return this.docs.cancel(ctx, id, b || {}); }

  @Post('documents/:id/restore') @RequirePermission('acc.doc.cancel') @ApiHeader(IDEMP_HEADER)
  restore(@Org() ctx: OrgContext, @Param('id') id: string) { return this.docs.restore(ctx, id); }

  @Post('documents/:id/storno') @RequirePermission('acc.doc.post') @ApiHeader(IDEMP_HEADER)
  storno(@Org() ctx: OrgContext, @Param('id') id: string, @Body() b: any) { return this.docs.storno(ctx, id, b); }

  // ── Отчёты ──
  @Get('reports/trial-balance') @RequirePermission('acc.reports.read')
  tb(@Org() ctx: OrgContext, @Query() q: any) { return this.reports.trialBalance(ctx, q); }

  @Get('reports/account-card') @RequirePermission('acc.reports.read')
  card(@Org() ctx: OrgContext, @Query() q: any) { return this.reports.accountCard(ctx, q); }

  @Get('reports/journal') @RequirePermission('acc.reports.read')
  journal(@Org() ctx: OrgContext, @Query() q: any) { return this.reports.journal(ctx, q); }

  // ── Периоды ──
  @Get('periods/lock') @RequirePermission('acc.doc.read')
  getLock(@Org() ctx: OrgContext) { return this.periods.getLock(ctx.organizationId); }

  @Put('periods/lock') @RequirePermission('acc.period.lock') @ApiHeader(IDEMP_HEADER)
  setLock(@Org() ctx: OrgContext, @Body() b: { lockedUntil: string | null; reason?: string }) {
    return this.periods.setLock(ctx, b.lockedUntil, b.reason);
  }

  // ── Справочники ──
  @Get('refs/currencies') @RequirePermission('acc.refs.read')
  currencies() { return this.refs.currencies(); }

  @Get('refs/rates') @RequirePermission('acc.refs.read')
  rates(@Query() q: any) { return this.refs.rates(q); }

  @Post('refs/rates') @RequirePermission('acc.refs.manage')
  setRate(@Org() ctx: OrgContext, @Body() b: any) { return this.refs.setRate(ctx, b); }

  @Get('refs/vat-rates') @RequirePermission('acc.refs.read')
  vat() { return this.refs.vatRates(); }

  @Get('refs/:kind') @RequirePermission('acc.refs.read')
  refList(@Org() ctx: OrgContext, @Param('kind') kind: string, @Query() q: any) { return this.refs.list(ctx, this.model(kind), q); }

  @Post('refs/:kind') @RequirePermission('acc.refs.manage') @ApiHeader(IDEMP_HEADER)
  refCreate(@Org() ctx: OrgContext, @Param('kind') kind: string, @Body() b: any) { return this.refs.create(ctx, this.model(kind), b); }

  @Put('refs/:kind/:id') @RequirePermission('acc.refs.manage')
  refUpdate(@Org() ctx: OrgContext, @Param('kind') kind: string, @Param('id') id: string, @Body() b: any) {
    return this.refs.update(ctx, this.model(kind), id, b);
  }

  private model(kind: string) {
    const m: Record<string, any> = { 'bank-accounts': 'orgBankAccount', cashboxes: 'cashbox', items: 'accItem', projects: 'project' };
    if (!m[kind]) throw new (require('./common/acc-error').AccError)('UNKNOWN_REF', `Неизвестный справочник: ${kind}`, { status: 404 });
    return m[kind];
  }

  // ── Учётная политика ──
  @Get('policy') @RequirePermission('acc.refs.read')
  policies(@Org() ctx: OrgContext) { return this.refs.policies(ctx); }

  @Post('policy') @RequirePermission('acc.policy.manage')
  addPolicy(@Org() ctx: OrgContext, @Body() b: any) { return this.refs.addPolicy(ctx, b); }

  // ── Организации, роли, доступ, аудит ──
  @Get('organizations/mine')
  mine(@CurrentUser('sub') userId: string) { return this.refs.myOrganizations(userId); }

  @Post('organizations')
  createOrg(@CurrentUser('sub') userId: string, @Body() b: any) { return this.refs.createOrganization(userId, b); }

  @Get('roles')
  roles() { return this.refs.roles(); }

  @Get('members') @RequirePermission('org.members.manage')
  members(@Org() ctx: OrgContext) { return this.refs.members(ctx); }

  @Post('members') @RequirePermission('org.members.manage')
  setMember(@Org() ctx: OrgContext, @Body() b: any) { return this.refs.setMember(ctx, b); }

  @Get('audit') @RequirePermission('acc.audit.read')
  audit(@Org() ctx: OrgContext, @Query() q: any) { return this.refs.audit_log(ctx, q); }
}
