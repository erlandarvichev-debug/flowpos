import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AccError } from '../common/acc-error';
import { OrgContext } from '../access/org-context';
import { KZ_CHART, KZ_CHART_CODE, KZ_CHART_VERSION, DIM_COLUMNS, Dim } from './kz-chart.data';
import { PostingService } from '../core/posting.service';

const CURRENCIES = [
  { code: 'KZT', numericCode: '398', name: 'Казахстанский тенге', nameKk: 'Қазақстан теңгесі' },
  { code: 'USD', numericCode: '840', name: 'Доллар США', nameKk: 'АҚШ доллары' },
  { code: 'EUR', numericCode: '978', name: 'Евро', nameKk: 'Еуро' },
  { code: 'RUB', numericCode: '643', name: 'Российский рубль', nameKk: 'Ресей рублі' },
  { code: 'CNY', numericCode: '156', name: 'Китайский юань', nameKk: 'Қытай юані' },
];

@Injectable()
export class ChartService implements OnModuleInit {
  private log = new Logger('Accounting');
  constructor(private prisma: PrismaService, private posting: PostingService) {}

  /** Идемпотентная загрузка типового плана счетов, валют, ставок НДС и политик по умолчанию. */
  async onModuleInit() {
    try {
      await this.bootstrap();
    } catch (e: any) {
      this.log.error(`Bootstrap бухгалтерии не выполнен: ${e.message}`);
    }
  }

  async bootstrap() {
    const chart = await this.prisma.accChart.upsert({
      where: { code_version: { code: KZ_CHART_CODE, version: KZ_CHART_VERSION } },
      create: {
        code: KZ_CHART_CODE, version: KZ_CHART_VERSION, name: 'Типовой план счетов РК (ред. приказа МФ № 860 от 20.12.2024)', validFrom: new Date('2025-01-01'),
        source: 'Приказ МФ РК от 23.05.2007 № 185 в ред. № 860 от 20.12.2024; zakon.uchet.kz/rus/docs/V070004771_ (проверено 18.10.2026)',
      },
      update: {},
    });
    const byCode = new Map<string, string>();
    for (const a of KZ_CHART) {
      const parentId = a.parent ? byCode.get(a.parent) ?? null : null;
      const data = {
        name: a.name, nameKk: a.nameKk ?? null, parentId, kind: a.kind ?? 'AP', isGroup: !!a.isGroup,
        isQuantitative: !!a.qty, isCurrency: !!a.cur, dims: a.dims ?? [], requiredDims: a.req ?? [],
      };
      const existing = await this.prisma.accAccount.findFirst({ where: { chartId: chart.id, organizationId: null, code: a.code } });
      const row = existing
        ? await this.prisma.accAccount.update({ where: { id: existing.id }, data })
        : await this.prisma.accAccount.create({ data: { ...data, chartId: chart.id, code: a.code } });
      byCode.set(a.code, row.id);
    }
    for (const c of CURRENCIES) await this.prisma.currency.upsert({ where: { code: c.code }, create: c, update: { name: c.name, nameKk: c.nameKk } });
    const vat = [
      { code: 'STANDARD', rate: '12', validFrom: new Date('2009-01-01'), validTo: new Date('2025-12-31') },
      { code: 'STANDARD', rate: '16', validFrom: new Date('2026-01-01'), validTo: null },
      { code: 'ZERO', rate: '0', validFrom: new Date('2009-01-01'), validTo: null },
    ];
    for (const v of vat) {
      await this.prisma.vatRate.upsert({
        where: { code_validFrom: { code: v.code, validFrom: v.validFrom } },
        create: { ...v, source: 'НК РК — см. NORMATIVE_REGISTRY.md', verified: false },
        update: {},
      });
    }
    await this.prisma.accPolicy.updateMany({ where: { chartId: null }, data: { chartId: chart.id } });
    const orgs = await this.prisma.organization.findMany({ select: { id: true } });
    for (const o of orgs) {
      const has = await this.prisma.accPolicy.findFirst({ where: { organizationId: o.id } });
      if (!has) {
        await this.prisma.accPolicy.create({ data: { organizationId: o.id, validFrom: new Date('2020-01-01'), chartId: chart.id } });
      }
    }
    this.log.log(`План счетов ${KZ_CHART_CODE} v${KZ_CHART_VERSION}: ${KZ_CHART.length} счетов`);
  }

  async list(ctx: OrgContext, date?: string) {
    const chartId = await this.posting.chartIdFor(this.prisma, ctx.organizationId, date ? new Date(date) : new Date());
    const accounts = await this.prisma.accAccount.findMany({
      where: { chartId, OR: [{ organizationId: null }, { organizationId: ctx.organizationId }] },
      orderBy: { code: 'asc' },
    });
    const parentsWithOrgKids = new Set(accounts.filter((a) => a.organizationId).map((a) => a.parentId));
    return accounts.map((a) => ({ ...a, isGroup: a.isGroup || parentsWithOrgKids.has(a.id), isOrgSubaccount: !!a.organizationId }));
  }

  dims() {
    return Object.keys(DIM_COLUMNS) as Dim[];
  }

  /** Субсчёт организации. Родитель должен быть без проводок организации. */
  async createSubaccount(ctx: OrgContext, input: { parentCode: string; code: string; name: string; nameKk?: string; dims?: Dim[]; requiredDims?: Dim[] }) {
    const chartId = await this.posting.chartIdFor(this.prisma, ctx.organizationId, new Date());
    const parent = await this.prisma.accAccount.findFirst({ where: { chartId, code: input.parentCode, OR: [{ organizationId: null }, { organizationId: ctx.organizationId }] } });
    if (!parent) throw new AccError('ACCOUNT_NOT_FOUND', `Счёт ${input.parentCode} не найден`);
    if (!input.code?.startsWith(parent.code)) throw new AccError('BAD_SUBACCOUNT_CODE', `Код субсчёта должен начинаться с ${parent.code} (например ${parent.code}.01)`);
    const used = await this.prisma.accPosting.count({ where: { accountId: parent.id, organizationId: ctx.organizationId } });
    if (used) throw new AccError('PARENT_HAS_POSTINGS', `По счёту ${parent.code} уже есть проводки — субсчёт добавить нельзя`, { fix: 'Перенесите остатки на субсчета операцией после создания нового плана счетов или используйте аналитику.' });
    const dims = (input.dims ?? parent.dims) as string[];
    const created = await this.prisma.accAccount.create({
      data: {
        chartId, organizationId: ctx.organizationId, code: input.code, name: input.name, nameKk: input.nameKk, parentId: parent.id,
        kind: parent.kind, isQuantitative: parent.isQuantitative, isCurrency: parent.isCurrency, dims,
        requiredDims: (input.requiredDims ?? parent.requiredDims.filter((d) => dims.includes(d))) as string[],
      },
    });
    await this.prisma.auditLog.create({ data: { userId: ctx.userId, organizationId: ctx.organizationId, action: 'SUBACCOUNT_CREATE', entity: 'AccAccount', entityId: created.id, after: created as any } });
    return created;
  }
}
