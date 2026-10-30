import { randomUUID } from 'crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { OrgContext } from '../src/modules/accounting/access/org-context';
import { hasPermission } from '../src/modules/accounting/access/roles';
import { PostingService } from '../src/modules/accounting/core/posting.service';
import { PeriodsService } from '../src/modules/accounting/periods/periods.service';
import { DocumentsService } from '../src/modules/accounting/documents/documents.service';
import { ReportsService } from '../src/modules/accounting/reports/reports.service';
import { ChartService } from '../src/modules/accounting/chart/chart.service';
import { RefsService } from '../src/modules/accounting/refs/refs.service';
import { CostService } from '../src/modules/accounting/inventory/cost.service';
import { AutopilotService } from '../src/modules/accounting/autopilot/autopilot.service';
import { TradeDocumentsService } from '../src/modules/accounting/autopilot/trade-documents.service';
import { BankImportService } from '../src/modules/accounting/bank/bank-import.service';
import { StatementsService } from '../src/modules/accounting/statements/statements.service';
import { ClosingService } from '../src/modules/accounting/closing/closing.service';

export function makeServices(prisma: PrismaService) {
  const posting = new PostingService(prisma);
  const periods = new PeriodsService(prisma);
  const cost = new CostService(posting, periods);
  const autopilot = new AutopilotService(prisma, posting, periods, cost);
  const docs = new DocumentsService(prisma, periods, posting);
  const statements = new StatementsService(prisma);
  return {
    statements,
    closing: new ClosingService(prisma, posting, periods, cost, statements),
    posting, periods, cost, autopilot,
    trade: new TradeDocumentsService(prisma, autopilot),
    bank: new BankImportService(prisma, docs),
    docs,
    reports: new ReportsService(prisma, posting),
    chart: new ChartService(prisma, posting),
    refs: new RefsService(prisma),
  };
}

/** Новая изолированная организация с пользователем заданной роли. */
export const DEFAULT_TENANT = '00000000-0000-0000-0000-000000000001';

/** Клиент по умолчанию тестовой БД (его же создаёт sql/pre для существующих баз). */
export async function defaultTenant(prisma: PrismaService) {
  return prisma.tenant.upsert({ where: { id: DEFAULT_TENANT }, create: { id: DEFAULT_TENANT, name: 'Основной клиент' }, update: {} });
}

export async function makeOrg(prisma: PrismaService, role = 'chief_accountant'): Promise<OrgContext> {
  const tenant = await defaultTenant(prisma);
  const org = await prisma.organization.create({ data: { tenantId: tenant.id, name: `Тест ТОО ${randomUUID().slice(0, 8)}` } });
  const user = await prisma.user.create({
    data: { email: `u-${randomUUID()}@test.local`, passwordHash: 'x', firstName: 'Тест', lastName: 'Бухгалтер', organizationId: org.id },
  });
  await prisma.orgMembership.create({ data: { userId: user.id, organizationId: org.id, role } });
  const chart = await prisma.accChart.findFirst({ where: { code: 'KZ-TYPICAL' } });
  await prisma.accPolicy.create({ data: { organizationId: org.id, validFrom: new Date('2020-01-01'), chartId: chart!.id } });
  return ctxFor(org.id, user.id, role);
}

export function ctxFor(organizationId: string, userId: string, role: string, tenantId = DEFAULT_TENANT): OrgContext {
  return { tenantId, organizationId, userId, role, can: (p) => hasPermission(role, p) };
}

export async function makeBankAndCash(prisma: PrismaService, ctx: OrgContext) {
  const bank = await prisma.orgBankAccount.create({
    data: { organizationId: ctx.organizationId, name: 'Банк', iban: 'KZ86125KZT5004100100', bic: 'HSBKKZKX', bankName: 'Тестовый банк' },
  });
  const cash = await prisma.cashbox.create({ data: { organizationId: ctx.organizationId, name: 'Касса' } });
  return { bank, cash };
}

export function manual(lines: { amount: string; dr: string; cr: string; drDims?: any; crDims?: any }[]) {
  return {
    lines: lines.map((l) => ({ amount: l.amount, debit: { account: l.dr, dims: l.drDims }, credit: { account: l.cr, dims: l.crDims } })),
  };
}

/** Торговый контур тестовой организации: склады, товар, услуга, контрагенты, банк. */
export async function makeTrade(prisma: PrismaService, ctx: OrgContext, opts: { vatPayer?: boolean; method?: 'FIFO' | 'AVERAGE'; allowNegative?: boolean } = {}) {
  await prisma.accPolicy.updateMany({
    where: { organizationId: ctx.organizationId },
    data: { vatPayer: opts.vatPayer ?? true, inventoryMethod: opts.method ?? 'FIFO', allowNegativeStock: !!opts.allowNegative },
  });
  const uom = await prisma.uom.create({ data: { tenantId: ctx.tenantId, name: 'штука', shortName: 'шт' } });
  const s1 = await prisma.store.create({ data: { name: 'Склад 1', organizationId: ctx.organizationId } });
  const s2 = await prisma.store.create({ data: { name: 'Магазин 2', organizationId: ctx.organizationId, isRetail: true } });
  const goods = await prisma.product.create({ data: { name: `Товар ${randomUUID().slice(0, 6)}`, uomId: uom.id, organizationId: ctx.organizationId } });
  const goods2 = await prisma.product.create({ data: { name: `Товар-2 ${randomUUID().slice(0, 6)}`, uomId: uom.id, organizationId: ctx.organizationId } });
  const service = await prisma.product.create({ data: { name: 'Доставка', kind: 'SERVICE', uomId: uom.id, organizationId: ctx.organizationId } });
  const bin = () => String(Math.floor(1e11 + Math.random() * 8.9e11));
  const supplier = await prisma.counterparty.create({ data: { name: 'ТОО Поставщик', type: 'SUPPLIER', inn: bin(), organizationId: ctx.organizationId } });
  const customer = await prisma.counterparty.create({ data: { name: 'ТОО Покупатель', type: 'CUSTOMER', inn: bin(), organizationId: ctx.organizationId } });
  const { bank, cash } = await makeBankAndCash(prisma, ctx);
  return { uom, s1, s2, goods, goods2, service, supplier, customer, bank, cash };
}
