import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { AccError } from '../common/acc-error';
import { D } from '../common/money';
import { OrgContext } from '../access/org-context';
import { PostingService } from '../core/posting.service';
import { PostingInput } from '../core/posting.types';
import { PeriodsService } from '../periods/periods.service';
import { CostService } from '../inventory/cost.service';
import { DIM_COLUMNS, Dim } from '../chart/kz-chart.data';
import { NO_ACCOUNTING, TRADE_SOURCE, isSupported } from '../autopilot/trade-rules';
import { FIN_RESULT_RULE, REVAL_RULE, StatementsService } from '../statements/statements.service';

type Tx = Prisma.TransactionClient;
type Dec = Prisma.Decimal;

export const CLOSE_SOURCE = 'PERIOD_CLOSE';
const CLOSE_RULE_VERSION = '1';
/** Денежные статьи для переоценки (МСФО (IAS) 21): деньги, финансовые активы, дебиторская и кредиторская задолженность, займы. Авансы (17xx, 35xx, 29xx, 44xx) — неденежные, не переоцениваются. */
const MONETARY_PREFIXES = ['10', '11', '12', '20', '21', '30', '33', '40', '41'];
const GAIN_ACCOUNT = '6130';
const LOSS_ACCOUNT = '7130';
const RESULT_ACCOUNT = '5710';
const RETAINED_ACCOUNT = '5610';

export type StepStatus = 'ok' | 'warn' | 'error' | 'todo';
export interface Step { code: string; title: string; status: StepStatus; message: string; fix?: string; link?: string; count?: number }

const iso = (d: Date) => d.toISOString().slice(0, 10);
function bounds(period: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new AccError('BAD_PERIOD', 'Период — в формате ГГГГ-ММ');
  const [y, m] = period.split('-').map(Number);
  const from = new Date(Date.UTC(y, m - 1, 1));
  const to = new Date(Date.UTC(y, m, 0));
  const next = new Date(Date.UTC(y, m, 1));
  return { y, m, from, to, next };
}
const prevPeriod = (period: string) => { const { y, m } = bounds(period); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; };
const version = (postings: PostingInput[]) => createHash('sha1').update(JSON.stringify(postings)).digest().readUInt32BE(0) & 0x7fffffff;

@Injectable()
export class ClosingService {
  constructor(
    private prisma: PrismaService,
    private posting: PostingService,
    private periods: PeriodsService,
    private cost: CostService,
    private statements: StatementsService,
  ) {}

  private async finResultMode(organizationId: string, date: Date): Promise<'YEAR' | 'MONTH'> {
    const p = await this.prisma.accPolicy.findFirst({ where: { organizationId, validFrom: { lte: date } }, orderBy: { validFrom: 'desc' } });
    return (p?.params as any)?.closing?.finResult === 'MONTH' ? 'MONTH' : 'YEAR';
  }

  // ── Проверки ──

  async status(ctx: OrgContext, period: string) {
    const { from, to, next, m } = bounds(period);
    const org = ctx.organizationId;
    const lock = await this.periods.getLock(org);
    const closed = !!lock && lock.lockedUntil.getTime() >= to.getTime();
    const steps: Step[] = [];
    const push = (s: Step) => steps.push(s);

    // 1. Черновики учётных документов
    const drafts = await this.prisma.accDocument.count({ where: { organizationId: org, status: 'DRAFT', date: { gte: from, lt: next } } });
    push({ code: 'DRAFTS', title: 'Черновики документов учёта', status: drafts ? 'warn' : 'ok', count: drafts, message: drafts ? `${drafts} черновиков за месяц не попадут в учёт` : 'Черновиков нет', link: '/accounting/documents?status=DRAFT' });

    // 2. Торговые документы: непроведённые и не отражённые автопилотом
    const tradeDrafts = await this.prisma.document.count({ where: { organizationId: org, status: 'DRAFT', deleted: false, date: { gte: from, lt: next }, docType: { notIn: NO_ACCOUNTING as any } } });
    push({ code: 'TRADE_DRAFTS', title: 'Непроведённые торговые документы', status: tradeDrafts ? 'warn' : 'ok', count: tradeDrafts, message: tradeDrafts ? `${tradeDrafts} документов торговли за месяц не проведены` : 'Все торговые документы проведены', link: '/accounting/trade' });
    const lagRows = await this.prisma.$queryRaw<{ id: string; doc_type: string }[]>`
      SELECT d.id, d.doc_type FROM documents d
       WHERE d.organization_id = ${org} AND d.status = 'POSTED' AND d.deleted = false AND d.date < ${iso(next)}::timestamp
         AND NOT EXISTS (SELECT 1 FROM acc_entries e WHERE e.organization_id = d.organization_id AND e.source_type = ${TRADE_SOURCE} AND e.source_id = d.id AND e.status = 'ACTIVE')`;
    const lag = lagRows.filter((r) => isSupported(r.doc_type)).length;
    const issues = await this.prisma.accAutopilotIssue.count({ where: { organizationId: org, resolvedAt: null } });
    push({ code: 'AUTOPILOT', title: 'Все документы отражены в учёте', status: lag || issues ? 'error' : 'ok', count: lag + issues, message: lag || issues ? `Не отражено документов: ${lag}; открытых проблем автопилота: ${issues}` : 'Автопилот отразил все проведённые документы', fix: 'Исправьте проблемы в разделе «Автопилот» — иначе отчётность будет неполной.', link: '/accounting/autopilot' });

    // 3. Отрицательные остатки товаров и денег на конец месяца
    const negStock = await this.prisma.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*)::bigint AS n FROM (
        SELECT p.product_id, p.store_id FROM acc_postings p JOIN acc_accounts a ON a.id = p.account_id
         WHERE p.organization_id = ${org} AND p.is_active AND p.ledger = 'BU' AND a.code LIKE '13%' AND p.date < ${iso(next)}::timestamp AND p.product_id IS NOT NULL
         GROUP BY 1, 2 HAVING SUM(CASE WHEN p.side='D' THEN p.amount ELSE -p.amount END) < 0) x`;
    const ns = Number(negStock[0]?.n ?? 0);
    push({ code: 'NEGATIVE_STOCK', title: 'Нет отрицательных остатков товаров', status: ns ? 'error' : 'ok', count: ns, message: ns ? `Отрицательная стоимость остатка по ${ns} позициям` : 'Остатки неотрицательные', link: '/accounting/reports/stock' });
    const negCash = await this.prisma.$queryRaw<{ code: string; bal: Prisma.Decimal }[]>`
      SELECT a.code, SUM(CASE WHEN p.side='D' THEN p.amount ELSE -p.amount END) AS bal
        FROM acc_postings p JOIN acc_accounts a ON a.id = p.account_id
       WHERE p.organization_id = ${org} AND p.is_active AND p.ledger = 'BU' AND (a.code LIKE '1010%' OR a.code LIKE '1030%') AND p.date < ${iso(next)}::timestamp
       GROUP BY a.code, p.cashbox_id, p.bank_account_id HAVING SUM(CASE WHEN p.side='D' THEN p.amount ELSE -p.amount END) < 0`;
    push({ code: 'NEGATIVE_CASH', title: 'Нет отрицательных остатков денег', status: negCash.length ? 'error' : 'ok', count: negCash.length, message: negCash.length ? `Кредитовое сальдо по кассе/банку: ${negCash.map((r) => `${r.code} ${new D(r.bal).toFixed(2)}`).join('; ')}` : 'Касса и банк неотрицательные', fix: 'Проверьте, все ли поступления введены (выписка, ПКО).', link: '/accounting/reports/account-card' });

    // 4. Деньги в пути (эквайринг, инкассация) и счёт ввода остатков
    const transit = await this.posting.balance(this.prisma as any, org, '1020', to);
    push({ code: 'CASH_IN_TRANSIT', title: 'Деньги в пути зачислены', status: transit.isZero() ? 'ok' : 'warn', message: transit.isZero() ? 'Остатка на 1020 нет' : `На 1020 «Деньги в пути» ${transit.toFixed(2)} ₸ — проверьте зачисления эквайринга/инкассации`, link: '/accounting/reports/account-card?account=1020' });
    const opening = await this.posting.balance(this.prisma as any, org, '0000', to);
    push({ code: 'OPENING_ACCOUNT', title: 'Ввод остатков сбалансирован', status: opening.isZero() ? 'ok' : 'warn', message: opening.isZero() ? 'Счёт 0000 закрыт' : `Сальдо счёта ввода остатков 0000: ${opening.toFixed(2)} ₸`, fix: 'Ввод начальных остатков должен быть сбалансирован по активам и пассивам.' });

    // 5. Курсы валют для переоценки
    const curBalances = await this.currencyBalances(this.prisma as any, org, to);
    const currencies = [...new Set(curBalances.map((c) => c.currency))];
    const missing: string[] = [];
    for (const c of currencies) if (!(await this.rateOn(this.prisma as any, c, to))) missing.push(c);
    push({ code: 'RATES', title: 'Курсы валют на конец месяца', status: missing.length ? 'error' : 'ok', message: !currencies.length ? 'Валютных остатков нет' : missing.length ? `Нет курса на ${iso(to)}: ${missing.join(', ')}` : `Курсы есть: ${currencies.join(', ')}`, fix: 'Добавьте курсы НБРК в «Справочники → Курсы валют».', link: '/accounting/refs' });

    // 6. ЭСФ по реализациям месяца (не блокирует)
    const esfPending = await this.prisma.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*)::bigint AS n FROM documents d
       WHERE d.organization_id = ${org} AND d.doc_type = 'DEMAND' AND d.status = 'POSTED' AND d.deleted = false AND d.date >= ${iso(from)}::timestamp AND d.date < ${iso(next)}::timestamp
         AND NOT EXISTS (SELECT 1 FROM esf_invoices i WHERE i.source_doc_id = d.id AND i.direction = 'OUTBOUND' AND i.status NOT IN ('READY','REJECTED','CANCELLED'))`;
    const ep = Number(esfPending[0]?.n ?? 0);
    push({ code: 'ESF', title: 'ЭСФ по реализациям отправлены', status: ep ? 'warn' : 'ok', count: ep, message: ep ? `${ep} реализаций месяца без отправленного ЭСФ` : 'ЭСФ отправлены', link: '/accounting/esf' });

    // 7. Предыдущий месяц
    const prev = prevPeriod(period);
    const prevClosed = !!lock && lock.lockedUntil.getTime() >= bounds(prev).to.getTime();
    push({ code: 'PREVIOUS', title: `Предыдущий месяц (${prev}) закрыт`, status: prevClosed ? 'ok' : 'warn', message: prevClosed ? 'Закрыт' : 'Не закрыт — при закрытии этого месяца закроется и он (без переоценки за тот месяц)' });

    // Что сделает закрытие
    const fin = (await this.finResultMode(org, to)) === 'MONTH' || m === 12;
    const actions = [
      'пересчитать себестоимость списаний (FIFO/средняя) — повторно воспроизводимо',
      currencies.length ? `переоценить валютные остатки по курсу на ${iso(to)} (курсовые разницы 6130/7130)` : null,
      fin ? 'закрыть доходы и расходы на 5710 «Итоговая прибыль» и перенести результат на 5610' : null,
      `запретить изменения по ${iso(to)} включительно`,
    ].filter(Boolean);

    const record = await this.prisma.accPeriodClose.findFirst({ where: { organizationId: org, period }, orderBy: { closedAt: 'desc' } });
    return {
      period, from: iso(from), to: iso(to), closed, lockedUntil: lock ? iso(lock.lockedUntil) : null,
      canClose: !closed && !steps.some((s) => s.status === 'error'),
      steps, actions,
      last: record ? { status: record.status, closedAt: record.closedAt, reopenedAt: record.reopenedAt, reopenReason: record.reopenReason, summary: record.summary } : null,
    };
  }

  private async rateOn(tx: Tx, currency: string, date: Date) {
    const r = await tx.currencyRate.findFirst({ where: { currencyCode: currency, date: { lte: date } }, orderBy: { date: 'desc' } });
    return r ? new D(r.rate).div(r.multiplier || 1) : null;
  }

  /** Валютные остатки денежных статей по счёту, валюте и аналитикам: валютная сумма и тенге. */
  private async currencyBalances(tx: Tx, organizationId: string, to: Date) {
    const rows = await tx.$queryRaw<any[]>`
      SELECT a.code, p.currency, p.bank_account_id, p.cashbox_id, p.counterparty_id, p.contract_id, p.settlement_doc_id, p.employee_id,
             SUM(CASE WHEN p.side='D' THEN COALESCE(p.currency_amount,0) ELSE -COALESCE(p.currency_amount,0) END) AS cur,
             SUM(CASE WHEN p.side='D' THEN p.amount ELSE -p.amount END) AS kzt
        FROM acc_postings p JOIN acc_accounts a ON a.id = p.account_id
       WHERE p.organization_id = ${organizationId} AND p.is_active AND p.ledger = 'BU' AND p.currency IS NOT NULL AND p.currency <> 'KZT'
         AND p.date < ${iso(new Date(to.getTime() + 86400000))}::timestamp
       GROUP BY 1, 2, 3, 4, 5, 6, 7, 8
       ORDER BY 1, 2, 3, 4, 5, 6, 7, 8`;
    return rows
      .filter((r) => MONETARY_PREFIXES.some((p) => r.code.startsWith(p)) && !/^(17|35|29|44)/.test(r.code))
      .map((r) => ({ ...r, cur: new D(r.cur), kzt: new D(r.kzt) }));
  }

  // ── Закрывающие операции ──

  private async revaluation(tx: Tx, ctx: OrgContext, period: string, to: Date) {
    const postings: PostingInput[] = [];
    let gain = new D(0), loss = new D(0);
    for (const b of await this.currencyBalances(tx, ctx.organizationId, to)) {
      const rate = await this.rateOn(tx, b.currency, to);
      if (!rate) throw new AccError('RATE_MISSING', `Нет курса ${b.currency} на ${iso(to)}`, { link: '/accounting/refs' });
      const target = b.cur.times(rate).toDecimalPlaces(2);
      const diff = target.minus(b.kzt);
      if (diff.isZero()) continue;
      const dims: Partial<Record<Dim, string>> = {};
      if (b.bank_account_id) dims.BANK_ACCOUNT = b.bank_account_id;
      if (b.cashbox_id) dims.CASHBOX = b.cashbox_id;
      if (b.counterparty_id) dims.COUNTERPARTY = b.counterparty_id;
      if (b.contract_id) dims.CONTRACT = b.contract_id;
      if (b.settlement_doc_id) dims.SETTLEMENT_DOC = b.settlement_doc_id;
      if (b.employee_id) dims.EMPLOYEE = b.employee_id;
      const memo = `Переоценка ${b.currency} по курсу ${rate.toFixed(4)} на ${iso(to)}`;
      postings.push({ side: diff.gt(0) ? 'D' : 'C', account: b.code, amount: diff.abs().toFixed(2), currency: b.currency, currencyAmount: '0', dims, memo });
      if (diff.gt(0)) gain = gain.plus(diff); else loss = loss.plus(diff.abs());
    }
    if (gain.gt(0)) postings.push({ side: 'C', account: GAIN_ACCOUNT, amount: gain.toFixed(2), memo: `Курсовая разница (доход) ${period}` });
    if (loss.gt(0)) postings.push({ side: 'D', account: LOSS_ACCOUNT, amount: loss.toFixed(2), memo: `Курсовая разница (расход) ${period}` });
    const sourceId = `REVAL:${period}`;
    if (!postings.length) {
      await this.posting.cancelSource(tx, ctx.organizationId, CLOSE_SOURCE, sourceId);
      return { gain: '0.00', loss: '0.00', entryId: null };
    }
    const { entry } = await this.posting.writeEntry(tx, ctx, { sourceType: CLOSE_SOURCE, sourceId, sourceVersion: version(postings), ruleCode: REVAL_RULE, ruleVersion: CLOSE_RULE_VERSION, date: to, postings });
    return { gain: gain.toFixed(2), loss: loss.toFixed(2), entryId: entry.id };
  }

  /** Закрытие доходов и расходов (разделы 6–7) на 5710 и перенос итога на 5610. */
  private async finResult(tx: Tx, ctx: OrgContext, key: string, to: Date) {
    const dimCols = Object.entries(DIM_COLUMNS) as [Dim, string][];
    const sqlCols = dimCols.map(([, c]) => `p.${c.replace(/[A-Z]/g, (x) => '_' + x.toLowerCase())}`);
    const rows = await tx.$queryRawUnsafe<any[]>(
      `SELECT a.code, ${sqlCols.map((c, i) => `${c} AS d${i}`).join(', ')}, SUM(CASE WHEN p.side='D' THEN p.amount ELSE -p.amount END) AS bal
         FROM acc_postings p JOIN acc_accounts a ON a.id = p.account_id
        WHERE p.organization_id = $1 AND p.is_active AND p.ledger = 'BU' AND (a.code LIKE '6%' OR a.code LIKE '7%') AND p.date < $2::timestamp
          AND NOT (p.entry_id IN (SELECT id FROM acc_entries WHERE organization_id = $1 AND source_type = $3 AND source_id = $4 AND status = 'ACTIVE'))
        GROUP BY ${['a.code', ...sqlCols].join(', ')}
       HAVING SUM(CASE WHEN p.side='D' THEN p.amount ELSE -p.amount END) <> 0
        ORDER BY ${['a.code', ...sqlCols].join(', ')}`,
      ctx.organizationId, iso(new Date(to.getTime() + 86400000)), CLOSE_SOURCE, `FIN:${key}`,
    );
    const postings: PostingInput[] = [];
    let result = new D(0); // Кт−Дт закрываемых счетов = прибыль (+) / убыток (−)
    for (const r of rows) {
      const bal = new D(r.bal); // Дт−Кт
      const dims: Partial<Record<Dim, string>> = {};
      dimCols.forEach(([dim], i) => { if (r[`d${i}`]) dims[dim] = r[`d${i}`]; });
      postings.push({ side: bal.gt(0) ? 'C' : 'D', account: r.code, amount: bal.abs().toFixed(2), dims, memo: `Закрытие счёта ${r.code} на итоговую прибыль` });
      result = result.minus(bal);
    }
    if (!postings.length) {
      await this.posting.cancelSource(tx, ctx.organizationId, CLOSE_SOURCE, `FIN:${key}`);
      return { result: '0.00', entryId: null };
    }
    // Свернуть на 5710 и перенести на 5610
    const incomeToResult = postings.filter((p) => p.side === 'D').reduce((a, p) => a.plus(p.amount), new D(0));
    const expenseToResult = postings.filter((p) => p.side === 'C').reduce((a, p) => a.plus(p.amount), new D(0));
    if (incomeToResult.gt(0)) postings.push({ side: 'C', account: RESULT_ACCOUNT, amount: incomeToResult.toFixed(2), memo: 'Доходы периода' });
    if (expenseToResult.gt(0)) postings.push({ side: 'D', account: RESULT_ACCOUNT, amount: expenseToResult.toFixed(2), memo: 'Расходы периода' });
    if (!result.isZero()) {
      postings.push({ side: result.gt(0) ? 'D' : 'C', account: RESULT_ACCOUNT, amount: result.abs().toFixed(2), memo: result.gt(0) ? 'Перенос прибыли' : 'Перенос убытка' });
      postings.push({ side: result.gt(0) ? 'C' : 'D', account: RETAINED_ACCOUNT, amount: result.abs().toFixed(2), memo: result.gt(0) ? 'Нераспределённая прибыль отчётного года' : 'Непокрытый убыток отчётного года' });
    }
    const { entry } = await this.posting.writeEntry(tx, ctx, { sourceType: CLOSE_SOURCE, sourceId: `FIN:${key}`, sourceVersion: version(postings), ruleCode: FIN_RESULT_RULE, ruleVersion: CLOSE_RULE_VERSION, date: to, postings });
    return { result: result.toFixed(2), entryId: entry.id };
  }

  /** Итоги на конец месяца — для сверки и проверки воспроизводимости повторного закрытия. */
  private async summary(ctx: OrgContext, period: string) {
    const { from, to } = bounds(period);
    const org = ctx.organizationId;
    const sum = async (prefix: string) => this.posting.balance(this.prisma as any, org, prefix, to);
    const tb = await this.prisma.$queryRaw<{ d: Prisma.Decimal; c: Prisma.Decimal }[]>`
      SELECT COALESCE(SUM(CASE WHEN side='D' THEN amount END),0) AS d, COALESCE(SUM(CASE WHEN side='C' THEN amount END),0) AS c
        FROM acc_postings WHERE organization_id = ${org} AND is_active AND ledger = 'BU' AND date >= ${iso(from)}::timestamp AND date < ${iso(new Date(to.getTime() + 86400000))}::timestamp`;
    const pl = await this.statements.profitLoss(ctx, { from: `${period.slice(0, 4)}-01-01`, to: iso(to) });
    const plLine = (code: string) => pl.lines.find((l) => l.code === code)?.current ?? '0.00';
    const entries = await this.prisma.accEntry.findMany({ where: { organizationId: org, sourceType: CLOSE_SOURCE, status: 'ACTIVE', sourceId: { in: [`REVAL:${period}`, `FIN:${period}`, `FIN:${period.slice(0, 4)}`] } }, include: { postings: { orderBy: { lineNo: 'asc' }, include: { account: { select: { code: true } } } } } });
    const fingerprint = createHash('sha1').update(JSON.stringify(entries.map((e) => [e.sourceId, e.postings.map((p) => [p.account.code, p.side, p.amount.toFixed(2)])]).sort())).digest('hex');
    return {
      turnover: { debit: new D(tb[0].d).toFixed(2), credit: new D(tb[0].c).toFixed(2) },
      cash: (await sum('1000')).toFixed(2),
      stock: (await sum('1300')).toFixed(2),
      receivables: (await sum('1210')).toFixed(2),
      payables: (await sum('3310')).neg().toFixed(2),
      vatPayable: (await sum('3130')).neg().minus(await sum('1420')).toFixed(2),
      revenueYtd: plLine('010'),
      grossProfitYtd: plLine('012'),
      profitYtd: plLine('300'),
      closingEntries: fingerprint,
    };
  }

  /** Закрыть месяц: проверки → себестоимость → переоценка → финрезультат → запрет изменений. */
  async close(ctx: OrgContext, period: string) {
    const st = await this.status(ctx, period);
    if (st.closed) throw new AccError('ALREADY_CLOSED', `Месяц ${period} уже закрыт`, { fix: 'Чтобы изменить закрытый месяц, сначала откройте его (с указанием причины).' });
    const blocking = st.steps.filter((s) => s.status === 'error');
    if (blocking.length) throw new AccError('CLOSE_BLOCKED', `Месяц ${period} нельзя закрыть: ${blocking.map((b) => b.title.toLowerCase()).join('; ')}`, { fix: blocking.map((b) => `• ${b.message}${b.fix ? ` — ${b.fix}` : ''}`).join('\n'), details: { steps: blocking } });
    const { to, m } = bounds(period);
    const fin = (await this.finResultMode(ctx.organizationId, to)) === 'MONTH' ? period : m === 12 ? period.slice(0, 4) : null;

    const done = await this.prisma.$transaction(async (tx) => {
      // Эксклюзивно по организации: проведения ждут, пока идёт закрытие
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${'acc-period:' + ctx.organizationId}))::text`;
      const products = await tx.accStockMove.findMany({ where: { organizationId: ctx.organizationId, isActive: true, date: { lte: to } }, distinct: ['productId'], select: { productId: true } });
      await this.cost.recalcProducts(tx, ctx, products.map((p) => p.productId));
      const reval = await this.revaluation(tx, ctx, period, to);
      const finRes = fin ? await this.finResult(tx, ctx, fin, to) : null;
      return { recalculated: products.length, reval, finRes };
    }, { timeout: 120000 });

    await this.periods.setLock(ctx, iso(to));
    const summary = { ...(await this.summary(ctx, period)), recalculatedProducts: done.recalculated, revaluation: done.reval, finResult: done.finRes };
    const prevRecord = await this.prisma.accPeriodClose.findFirst({ where: { organizationId: ctx.organizationId, period }, orderBy: { closedAt: 'desc' } });
    const rec = await this.prisma.accPeriodClose.create({ data: { organizationId: ctx.organizationId, period, status: 'CLOSED', summary: summary as any, closedBy: ctx.userId } });
    await this.prisma.auditLog.create({ data: { userId: ctx.userId, organizationId: ctx.organizationId, action: 'PERIOD_CLOSE', entity: 'acc_period_close', entityId: rec.id, after: summary as any } });
    // Повторное закрытие без изменений в учёте должно дать те же итоги
    // jsonb в БД переставляет ключи — сравниваем канонический вид (ключи по алфавиту), без id записей
    const canon = (v: any): any => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().filter((k) => k !== 'entryId' && v[k] !== undefined).map((k) => [k, canon(v[k])])) : v);
    const comparable = (s: any) => JSON.stringify(canon({ ...s, recalculatedProducts: undefined }));
    const reproducible = prevRecord ? comparable(prevRecord.summary) === comparable(summary) : null;
    return { period, closed: true, summary, previous: prevRecord?.summary ?? null, reproducible };
  }

  /** Открыть последний закрытый месяц: снять запрет, отменить закрывающие проводки месяца. */
  async reopen(ctx: OrgContext, period: string, reason: string) {
    if (!reason?.trim()) throw new AccError('REASON_REQUIRED', 'Укажите причину открытия месяца');
    const { to, m } = bounds(period);
    const lock = await this.periods.getLock(ctx.organizationId);
    if (!lock || lock.lockedUntil.getTime() < to.getTime()) throw new AccError('NOT_CLOSED', `Месяц ${period} не закрыт`);
    if (lock.lockedUntil.getTime() > to.getTime()) throw new AccError('NOT_LAST_CLOSED', `Сначала откройте более поздние месяцы (закрыто по ${iso(lock.lockedUntil)})`);
    if (!ctx.can('acc.period.override')) throw new AccError('PERIOD_OVERRIDE_FORBIDDEN', 'Открыть закрытый месяц может главный бухгалтер или владелец', { status: 403 });
    const prevEnd = bounds(prevPeriod(period)).to;
    await this.periods.setLock(ctx, iso(prevEnd), reason);
    const fin = (await this.finResultMode(ctx.organizationId, to)) === 'MONTH' ? period : m === 12 ? period.slice(0, 4) : null;
    await this.prisma.$transaction(async (tx) => {
      await this.posting.cancelSource(tx, ctx.organizationId, CLOSE_SOURCE, `REVAL:${period}`);
      if (fin) await this.posting.cancelSource(tx, ctx.organizationId, CLOSE_SOURCE, `FIN:${fin}`);
    });
    const rec = await this.prisma.accPeriodClose.findFirst({ where: { organizationId: ctx.organizationId, period, status: 'CLOSED' }, orderBy: { closedAt: 'desc' } });
    if (rec) await this.prisma.accPeriodClose.update({ where: { id: rec.id }, data: { status: 'REOPENED', reopenedBy: ctx.userId, reopenedAt: new Date(), reopenReason: reason } });
    return { period, closed: false, lockedUntil: iso(prevEnd) };
  }

  async history(ctx: OrgContext) {
    return this.prisma.accPeriodClose.findMany({ where: { organizationId: ctx.organizationId }, orderBy: [{ period: 'desc' }, { closedAt: 'desc' }], take: 50 });
  }
}
