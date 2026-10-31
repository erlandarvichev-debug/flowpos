import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { contractPeriodProblem } from '../../catalog/requisites';
import { AccError } from '../common/acc-error';
import { D, money } from '../common/money';
import { DIM_COLUMNS, Dim, KZ_CHART_CODE, KZ_CHART_VERSION } from '../chart/kz-chart.data';
import { EntryInput, PostingInput } from './posting.types';
import { OrgContext } from '../access/org-context';

const DIM_LABEL: Record<Dim, string> = {
  COUNTERPARTY: 'контрагент', CONTRACT: 'договор', SETTLEMENT_DOC: 'документ расчётов', PRODUCT: 'номенклатура',
  STORE: 'склад', EMPLOYEE: 'сотрудник', DEPARTMENT: 'подразделение', BANK_ACCOUNT: 'банковский счёт',
  CASHBOX: 'касса', PROJECT: 'проект', ITEM: 'статья',
};

/**
 * Ядро двойной записи. Все движения создаются только здесь.
 * Проверки: счета существуют и не групповые, обязательные аналитики, количество/валюта, Дт = Кт по разрезу.
 * БД дополнительно гарантирует баланс (deferred trigger) и неизменяемость проводок.
 */
@Injectable()
export class PostingService {
  constructor(private prisma: PrismaService) {}

  async chartIdFor(tx: Prisma.TransactionClient, organizationId: string, date: Date): Promise<string> {
    const policy = await tx.accPolicy.findFirst({
      where: { organizationId, validFrom: { lte: date } },
      orderBy: { validFrom: 'desc' },
    });
    if (policy?.chartId) return policy.chartId;
    const chart = await tx.accChart.findUnique({ where: { code_version: { code: KZ_CHART_CODE, version: KZ_CHART_VERSION } } });
    if (!chart) throw new AccError('CHART_MISSING', 'План счетов не загружен', { fix: 'Перезапустите API — план счетов загрузится автоматически.' });
    return chart.id;
  }

  async resolveAccounts(tx: Prisma.TransactionClient, organizationId: string, chartId: string, codes: string[]) {
    const accounts = await tx.accAccount.findMany({
      where: { chartId, code: { in: codes }, OR: [{ organizationId: null }, { organizationId }] },
    });
    const map = new Map<string, (typeof accounts)[number]>();
    // Субсчёт организации имеет приоритет над типовым
    for (const a of accounts) if (!map.has(a.code) || a.organizationId) map.set(a.code, a);
    return map;
  }

  /** Проверяет и нормализует проводки, не записывая их. */
  async validate(tx: Prisma.TransactionClient, organizationId: string, date: Date, postings: PostingInput[], allowEmpty = false) {
    if (!postings.length && allowEmpty) return [];
    if (!postings.length) throw new AccError('NO_POSTINGS', 'Документ не формирует ни одной проводки', { fix: 'Заполните строки документа.' });
    const chartId = await this.chartIdFor(tx, organizationId, date);
    const accounts = await this.resolveAccounts(tx, organizationId, chartId, [...new Set(postings.map((p) => p.account))]);
    const withChildren = await tx.accAccount.findMany({
      where: { parentId: { in: [...accounts.values()].map((a) => a.id) }, organizationId, isActive: true },
      select: { parentId: true },
    });
    const orgGroups = new Set(withChildren.map((c) => c.parentId!));
    const totals: Record<string, Prisma.Decimal> = {};
    const rows = postings.map((p, i) => {
      const n = i + 1;
      const acc = accounts.get(p.account);
      if (!acc) throw new AccError('ACCOUNT_NOT_FOUND', `Строка ${n}: счёт ${p.account} не найден в плане счетов`, { fix: 'Выберите счёт из плана счетов.', link: '/accounting/chart' });
      if (acc.isGroup || orgGroups.has(acc.id)) throw new AccError('ACCOUNT_IS_GROUP', `Строка ${n}: счёт ${acc.code} «${acc.name}» групповой — проводки по нему запрещены`, { fix: 'Выберите субсчёт.' });
      if (!acc.isActive) throw new AccError('ACCOUNT_INACTIVE', `Строка ${n}: счёт ${acc.code} не используется`);
      let amount: Prisma.Decimal;
      try { amount = money(p.amount); } catch (e: any) { throw new AccError('BAD_AMOUNT', `Строка ${n}: ${e.message}`); }
      if (amount.isZero()) throw new AccError('ZERO_AMOUNT', `Строка ${n}: сумма проводки не может быть нулевой`);
      const dims = p.dims || {};
      for (const k of Object.keys(dims) as Dim[]) {
        if (dims[k] && !acc.dims.includes(k)) {
          throw new AccError('DIM_NOT_ALLOWED', `Строка ${n}: у счёта ${acc.code} нет аналитики «${DIM_LABEL[k] || k}»`);
        }
      }
      for (const k of acc.requiredDims as Dim[]) {
        if (!dims[k]) throw new AccError('DIM_REQUIRED', `Строка ${n}: для счёта ${acc.code} обязательна аналитика «${DIM_LABEL[k] || k}»`, { fix: `Заполните «${DIM_LABEL[k] || k}» в строке ${n}.` });
      }
      let quantity: Prisma.Decimal | null = null;
      if (p.quantity !== undefined && p.quantity !== null && p.quantity !== '') {
        if (!acc.isQuantitative) throw new AccError('QTY_NOT_ALLOWED', `Строка ${n}: по счёту ${acc.code} не ведётся количественный учёт`);
        quantity = money(p.quantity, 3, 'количество');
      } else if (acc.isQuantitative && dims.PRODUCT) {
        throw new AccError('QTY_REQUIRED', `Строка ${n}: по счёту ${acc.code} укажите количество`);
      }
      let currency: string | null = null;
      let currencyAmount: Prisma.Decimal | null = null;
      if (p.currency && p.currency !== 'KZT') {
        if (!acc.isCurrency) throw new AccError('CURRENCY_NOT_ALLOWED', `Строка ${n}: по счёту ${acc.code} не ведётся валютный учёт`);
        currency = p.currency;
        currencyAmount = money(p.currencyAmount, 2, 'валютная сумма');
      }
      const ledger = p.ledger || 'BU';
      const key = ledger;
      totals[key] = (totals[key] || new D(0)).plus(p.side === 'D' ? amount : amount.neg());
      const dimCols: Record<string, string | null> = {};
      for (const [dim, col] of Object.entries(DIM_COLUMNS)) dimCols[col] = (dims as any)[dim] || null;
      return {
        ledger, lineNo: n, side: p.side, accountId: acc.id, amount, currency, currencyAmount, quantity,
        memo: p.memo || null, ...dimCols,
      };
    });
    for (const [ledger, diff] of Object.entries(totals)) {
      if (!diff.isZero()) {
        throw new AccError('UNBALANCED', `Дебет не равен кредиту (${ledger === 'BU' ? 'бухгалтерский' : 'налоговый'} учёт): разница ${diff.toFixed(2)} ₸`, { fix: 'Проверьте суммы строк документа.' });
      }
    }
    return rows;
  }

  /**
   * Аналитики проводок принадлежат клиенту и организации записи (FP-007). Справочник клиента без организации
   * (товар, контрагент) — общий для его организаций; объекты организации (склад, счёт, касса, проект, статья,
   * подразделение, сотрудник) — только свои. Документ расчётов (SETTLEMENT_DOC) не проверяется: ссылается на документы разных видов.
   */
  private async checkDimOwnership(tx: Prisma.TransactionClient, ctx: OrgContext, rows: Record<string, any>[], date?: Date) {
    const ids = (col: string) => [...new Set(rows.map((r) => r[col]).filter(Boolean) as string[])];
    const org = ctx.organizationId;
    const tenantShared = { tenantId: ctx.tenantId, OR: [{ organizationId: null }, { organizationId: org }] };
    const checks: [Dim, string[], (x: string[]) => Promise<number>][] = [
      ['COUNTERPARTY', ids('counterpartyId'), (x) => tx.counterparty.count({ where: { id: { in: x }, ...tenantShared } })],
      ['PRODUCT', ids('productId'), (x) => tx.product.count({ where: { id: { in: x }, ...tenantShared } })],
      // FP-026: договор — своей организации (договор заключает организация, а не клиент).
      ['CONTRACT', ids('contractId'), (x) => tx.contract.count({ where: { id: { in: x }, tenantId: ctx.tenantId, organizationId: org } })],
      ['STORE', ids('storeId'), (x) => tx.store.count({ where: { id: { in: x }, organizationId: org } })],
      ['DEPARTMENT', ids('departmentId'), (x) => tx.department.count({ where: { id: { in: x }, organizationId: org } })],
      ['EMPLOYEE', ids('employeeId'), (x) => tx.employee.count({ where: { id: { in: x }, organizationId: org } })],
      ['BANK_ACCOUNT', ids('bankAccountId'), (x) => tx.orgBankAccount.count({ where: { id: { in: x }, organizationId: org } })],
      ['CASHBOX', ids('cashboxId'), (x) => tx.cashbox.count({ where: { id: { in: x }, organizationId: org } })],
      ['PROJECT', ids('projectId'), (x) => tx.project.count({ where: { id: { in: x }, organizationId: org } })],
      ['ITEM', ids('itemId'), (x) => tx.accItem.count({ where: { id: { in: x }, organizationId: org } })],
    ];
    for (const [dim, list, count] of checks) {
      if (list.length && (await count(list)) !== list.length) {
        throw new AccError('REF_FOREIGN', `Аналитика «${DIM_LABEL[dim]}»: указан объект, которого нет в этой организации`, {
          fix: `Выберите «${DIM_LABEL[dim]}» из справочника текущей организации.`,
          details: { dim },
        });
      }
    }
    // FP-026: договор в строке — с тем же контрагентом и действует на дату записи.
    const cids = ids('contractId');
    if (cids.length) {
      const cs = new Map((await tx.contract.findMany({ where: { id: { in: cids } }, select: { id: true, number: true, counterpartyId: true, startDate: true, date: true, endDate: true } })).map((c) => [c.id, c]));
      for (const r of rows) {
        const c = r.contractId ? cs.get(r.contractId) : undefined;
        if (!c) continue;
        if (r.counterpartyId && c.counterpartyId !== r.counterpartyId) {
          throw new AccError('CONTRACT_COUNTERPARTY', `Договор № ${c.number} заключён с другим контрагентом`, { fix: 'Выберите договор этого контрагента.', details: { contractId: c.id } });
        }
        const problem = date ? contractPeriodProblem(c, date) : null;
        if (problem) throw new AccError('CONTRACT_NOT_EFFECTIVE', problem, { fix: 'Выберите договор, действующий на дату документа, или продлите срок договора.', details: { contractId: c.id } });
      }
    }
  }

  /**
   * Записывает движения источника. Идемпотентно: если активная запись той же версии источника и правила
   * уже есть — возвращает её. Иначе предыдущая запись помечается SUPERSEDED (история сохраняется).
   */
  async writeEntry(tx: Prisma.TransactionClient, ctx: OrgContext, input: EntryInput) {
    const existing = await tx.accEntry.findFirst({
      where: { organizationId: ctx.organizationId, sourceType: input.sourceType, sourceId: input.sourceId, status: 'ACTIVE' },
    });
    if (existing && existing.sourceVersion === input.sourceVersion && existing.ruleVersion === input.ruleVersion) {
      return { entry: existing, reused: true };
    }
    const rows = await this.validate(tx, ctx.organizationId, input.date, input.postings, input.allowEmpty);
    await this.checkDimOwnership(tx, ctx, rows, input.date);
    if (existing) await this.closeEntry(tx, existing.id, 'SUPERSEDED');
    const entry = await tx.accEntry.create({
      data: {
        organizationId: ctx.organizationId, sourceType: input.sourceType, sourceId: input.sourceId,
        sourceVersion: input.sourceVersion, ruleCode: input.ruleCode, ruleVersion: input.ruleVersion,
        date: input.date, createdById: ctx.userId,
      },
    });
    if (rows.length) {
      await tx.accPosting.createMany({
        data: rows.map((r) => ({ ...r, entryId: entry.id, organizationId: ctx.organizationId, date: input.date })),
      });
    }
    if (input.moves?.length) {
      await tx.accStockMove.createMany({
        data: input.moves.map((m) => ({
          organizationId: ctx.organizationId, entryId: entry.id, sourceType: input.sourceType, sourceId: input.sourceId,
          lineNo: m.lineNo, date: input.date, productId: m.productId, storeId: m.storeId, account: m.account,
          direction: m.direction, kind: m.kind, quantity: new D(m.quantity), knownCost: m.knownCost != null ? new D(m.knownCost) : null,
          costAccount: m.costAccount ?? null, pairKey: m.pairKey ?? null, meta: m.meta ?? undefined,
        })),
      });
    }
    return { entry, reused: false };
  }

  async cancelSource(tx: Prisma.TransactionClient, organizationId: string, sourceType: string, sourceId: string) {
    const existing = await tx.accEntry.findFirst({ where: { organizationId, sourceType, sourceId, status: 'ACTIVE' } });
    if (existing) await this.closeEntry(tx, existing.id, 'CANCELLED');
    return existing;
  }

  private async closeEntry(tx: Prisma.TransactionClient, entryId: string, status: 'SUPERSEDED' | 'CANCELLED') {
    await tx.accEntry.update({ where: { id: entryId }, data: { status, closedAt: new Date() } });
    await tx.accPosting.updateMany({ where: { entryId }, data: { isActive: false } });
    await tx.accStockMove.updateMany({ where: { entryId }, data: { isActive: false } });
  }

  /** Сальдо счёта (со субсчетами) по аналитикам на дату включительно, без записи текущего источника. Дт − Кт. */
  async balance(
    tx: Prisma.TransactionClient,
    organizationId: string,
    accountCode: string,
    date: Date,
    dims: Partial<Record<Dim, string>> = {},
    exclude?: { sourceType: string; sourceId: string },
  ): Promise<Prisma.Decimal> {
    const chartId = await this.chartIdFor(tx, organizationId, date);
    const root = await tx.accAccount.findFirst({ where: { chartId, code: accountCode, OR: [{ organizationId: null }, { organizationId }] } });
    if (!root) return new D(0);
    const ids = [root.id];
    let frontier = [root.id];
    while (frontier.length) {
      const kids = await tx.accAccount.findMany({ where: { parentId: { in: frontier }, OR: [{ organizationId: null }, { organizationId }] }, select: { id: true } });
      frontier = kids.map((k) => k.id);
      ids.push(...frontier);
    }
    const where: Prisma.AccPostingWhereInput = { organizationId, isActive: true, ledger: 'BU', accountId: { in: ids }, date: { lte: date } };
    for (const [dim, v] of Object.entries(dims)) if (v) (where as any)[DIM_COLUMNS[dim as Dim]] = v;
    if (exclude) where.entry = { NOT: { sourceType: exclude.sourceType, sourceId: exclude.sourceId } };
    const [d, c] = await Promise.all([
      tx.accPosting.aggregate({ where: { ...where, side: 'D' }, _sum: { amount: true } }),
      tx.accPosting.aggregate({ where: { ...where, side: 'C' }, _sum: { amount: true } }),
    ]);
    return new D(d._sum.amount ?? 0).minus(c._sum.amount ?? 0);
  }

  async activePostings(tx: Prisma.TransactionClient, organizationId: string, sourceType: string, sourceId: string) {
    const entry = await tx.accEntry.findFirst({
      where: { organizationId, sourceType, sourceId, status: 'ACTIVE' },
      include: { postings: { include: { account: true }, orderBy: [{ ledger: 'asc' }, { lineNo: 'asc' }] } },
    });
    return entry;
  }
}

