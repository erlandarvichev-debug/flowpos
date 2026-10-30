// FP-019: распределение входного НДС по ЭСФ — частичный зачёт по кварталам и корректировки.
//
// Проводка поступления относит НДС на 1420 («НДС по приобретённым»), но что и в каком квартале принимается к зачёту,
// решает не она: это налоговый регистр vat_credit_allocations. Строка регистра появляется только явной командой
// (право acc.tax.manage, MFA) с основанием, методом, правилом и его версией. Получение ЭСФ ничего не зачитывает.
// Строки неизменяемы; исправление — сторно (REVERSAL) со ссылкой на исходную строку.
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { AccError } from '../common/acc-error';
import { D } from '../common/money';
import { OrgContext } from '../access/org-context';
import { PostingService } from '../core/posting.service';
import { PeriodsService } from '../periods/periods.service';

type Tx = Prisma.TransactionClient;

/**
 * Правило отнесения входного НДС в зачёт. Версия хранится в каждой строке регистра.
 * Статус — METHODOLOGIST_REVIEW: проверки ниже — общие условия (зарегистрированный, не отозванный ЭСФ; плательщик НДС;
 * не раньше квартала оборота). Сроки и пропорции по Налоговому кодексу в правило не зашиты — их задаёт методолог.
 */
export const VAT_CREDIT_RULE = {
  code: 'KZ_VAT_INPUT_CREDIT',
  version: '1.0.0-draft',
  status: 'METHODOLOGIST_REVIEW',
  source: 'ТЗ FLOWPOS ERP 2.1, раздел «Отчётность»; требует подтверждения методологом',
} as const;

const NOT_ELIGIBLE_STATUS = ['REVOKED', 'DECLINED', 'CANCELED', 'CANCELED_BY_OGD', 'CANCELED_BY_SNT_DECLINE', 'CANCELED_BY_SNT_REVOKE', 'DELETED', 'FAILED', 'DELETED_BIOMETRICS_VERIFICATION', 'FAILED_BIOMETRICS_VERIFICATION', 'WAITING_CUSTOMER_REVOKE_CONFIRMATION'];
const quarterOf = (d: Date) => ({ year: d.getUTCFullYear(), quarter: Math.floor(d.getUTCMonth() / 3) + 1 });
const qIndex = (y: number, q: number) => y * 4 + (q - 1);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export interface AllocateInput {
  esfInvoiceId: string;
  kind: 'CREDIT' | 'NON_CREDITABLE';
  year: number;
  quarter: number;
  method: 'FULL' | 'PROPORTIONAL' | 'MANUAL';
  amount?: string; // MANUAL
  shareNumerator?: string; // PROPORTIONAL: например, облагаемый оборот
  shareDenominator?: string; // PROPORTIONAL: общий оборот
  basis: string;
  /** NON_CREDITABLE: счёт расходов и дата проводки (в пределах квартала). */
  expenseAccount?: string;
  date?: string;
}

@Injectable()
export class VatCreditService {
  constructor(private prisma: PrismaService, private posting: PostingService, private periods: PeriodsService) {}

  /** ЭСФ и его распределения: НДС, распределено, остаток. */
  async ledger(ctx: OrgContext, esfInvoiceId: string, db: Tx | PrismaService = this.prisma) {
    const inv = await db.esfInvoice.findFirst({ where: { id: esfInvoiceId, organizationId: ctx.organizationId } });
    if (!inv) throw new AccError('NOT_FOUND', 'ЭСФ не найден', { status: 404 });
    const rows = await db.vatCreditAllocation.findMany({ where: { organizationId: ctx.organizationId, esfInvoiceId }, orderBy: { createdAt: 'asc' } });
    const sum = (k?: string) => rows.filter((r) => !k || r.kind === k || (r.kind === 'REVERSAL' && rows.find((o) => o.id === r.reversedId)?.kind === k)).reduce((s, r) => s.plus(r.amount), new D(0));
    const vat = new D(inv.totalNds);
    const allocated = sum();
    return {
      invoice: { id: inv.id, num: inv.num, registrationNumber: inv.registrationNumber, invoiceType: inv.invoiceType, status: inv.status, turnoverDate: inv.turnoverDate, totalNds: vat.toFixed(2) },
      credited: sum('CREDIT').toFixed(2),
      nonCreditable: sum('NON_CREDITABLE').toFixed(2),
      remainder: vat.minus(allocated).toFixed(2),
      rule: VAT_CREDIT_RULE,
      allocations: rows,
    };
  }

  /** Условия правила для ЭСФ (FP-019): что не выполнено — понятным списком. */
  private async eligibility(tx: Tx, ctx: OrgContext, inv: any, year: number, quarter: number) {
    const problems: string[] = [];
    if (inv.direction !== 'INBOUND') problems.push('к зачёту относится только НДС по входящим ЭСФ');
    if (!inv.registrationNumber) problems.push('ЭСФ не зарегистрирован в ИС ЭСФ');
    if (NOT_ELIGIBLE_STATUS.includes(inv.esfStatus ?? inv.status)) problems.push(`ЭСФ в статусе ${inv.esfStatus ?? inv.status}`);
    if (inv.invoiceType !== 'ORDINARY_INVOICE' && inv.businessDecision !== 'APPROVED') problems.push('исправленный/дополнительный ЭСФ ещё не подтверждён решением (FP-018)');
    const turnover = quarterOf(inv.turnoverDate);
    if (qIndex(year, quarter) < qIndex(turnover.year, turnover.quarter)) problems.push(`квартал ${quarter}/${year} раньше квартала оборота ${turnover.quarter}/${turnover.year}`);
    const policy = await tx.accPolicy.findFirst({ where: { organizationId: ctx.organizationId, validFrom: { lte: inv.turnoverDate } }, orderBy: { validFrom: 'desc' } });
    if (!policy?.vatPayer) problems.push('организация не плательщик НДС на дату оборота');
    return problems;
  }

  async allocate(ctx: OrgContext, b: AllocateInput) {
    const basis = String(b?.basis ?? '').trim();
    if (basis.length < 5) throw new AccError('VAT_BASIS', 'Укажите основание: на чём основано решение о зачёте');
    if (!['CREDIT', 'NON_CREDITABLE'].includes(b?.kind)) throw new AccError('VAT_KIND', 'Вид: CREDIT (к зачёту) или NON_CREDITABLE (не принимается к зачёту)');
    if (!Number.isInteger(b.year) || b.year < 2000 || !Number.isInteger(b.quarter) || b.quarter < 1 || b.quarter > 4) throw new AccError('VAT_PERIOD', 'Укажите год и квартал (1–4)');
    if (!['FULL', 'PROPORTIONAL', 'MANUAL'].includes(b.method)) throw new AccError('VAT_METHOD', 'Метод: FULL, PROPORTIONAL или MANUAL');

    return this.prisma.$transaction(async (tx) => {
      // Одновременные распределения одного ЭСФ — по очереди: остаток считается под блокировкой строки ЭСФ.
      await tx.$queryRaw`SELECT id FROM esf_invoices WHERE id = ${b.esfInvoiceId} AND organization_id = ${ctx.organizationId} FOR UPDATE`;
      const led = await this.ledger(ctx, b.esfInvoiceId, tx);
      const inv = await tx.esfInvoice.findUniqueOrThrow({ where: { id: b.esfInvoiceId } });
      const problems = await this.eligibility(tx, ctx, inv, b.year, b.quarter);
      if (problems.length) throw new AccError('VAT_NOT_ELIGIBLE', `НДС по ЭСФ № ${inv.num} нельзя распределить: ${problems.join('; ')}`, { details: { problems, rule: VAT_CREDIT_RULE } });

      const vat = new D(inv.totalNds);
      const remainder = new D(led.remainder);
      let amount: Prisma.Decimal;
      let num: Prisma.Decimal | null = null;
      let den: Prisma.Decimal | null = null;
      if (b.method === 'FULL') amount = remainder;
      else if (b.method === 'PROPORTIONAL') {
        num = new D(String(b.shareNumerator ?? ''));
        den = new D(String(b.shareDenominator ?? ''));
        if (den.lte(0) || num.lt(0) || num.gt(den)) throw new AccError('VAT_SHARE', 'Доля: 0 ≤ числитель ≤ знаменатель, знаменатель > 0');
        // Доля от всего НДС ЭСФ, до тиына (half-up); остаток округления остаётся в remainder и виден.
        amount = vat.times(num).div(den).toDecimalPlaces(2, D.ROUND_HALF_UP);
      } else {
        if (b.amount == null || !/^-?\d+(\.\d{1,2})?$/.test(String(b.amount))) throw new AccError('VAT_AMOUNT', 'Сумма — число с точностью до тиына');
        amount = new D(String(b.amount));
      }
      if (amount.isZero()) throw new AccError('VAT_AMOUNT', 'Распределять нечего: сумма ноль');
      // Знак — как у НДС ЭСФ (дополнительный ЭСФ на уменьшение — отрицательный); по модулю не больше остатка.
      if (amount.isNegative() !== vat.isNegative() || amount.abs().gt(remainder.abs())) {
        throw new AccError('VAT_OVER_ALLOCATION', `Нельзя распределить ${amount.toFixed(2)}: остаток нераспределённого НДС ${remainder.toFixed(2)}`, { details: { remainder: remainder.toFixed(2) } });
      }

      let entryId: string | null = null;
      if (b.kind === 'NON_CREDITABLE') {
        // Не принимается к зачёту — НДС переносится с 1420 в расходы проводкой (дата — в пределах квартала).
        if (!b.expenseAccount || !b.date) throw new AccError('VAT_EXPENSE', 'Для НДС, не принимаемого к зачёту, укажите счёт расходов и дату');
        const date = new Date(String(b.date).slice(0, 10) + 'T00:00:00.000Z');
        const q = quarterOf(date);
        if (q.year !== b.year || q.quarter !== b.quarter) throw new AccError('VAT_PERIOD', 'Дата проводки должна быть в том же квартале');
        await this.periods.assertOpen(tx, ctx, [date], undefined, 'отнесение НДС в расходы');
        const dims = { COUNTERPARTY: inv.counterpartyId ?? undefined, SETTLEMENT_DOC: inv.sourceDocId ?? undefined };
        const pos = amount.isPositive();
        const { entry } = await this.posting.writeEntry(tx, ctx, {
          sourceType: 'VAT_ALLOCATION', sourceId: `${inv.id}:${Date.now()}`, sourceVersion: 1, ruleCode: VAT_CREDIT_RULE.code, ruleVersion: VAT_CREDIT_RULE.version, date,
          postings: [
            { side: pos ? 'D' : 'C', account: b.expenseAccount, amount: amount.abs().toFixed(2), memo: `НДС не к зачёту, ЭСФ № ${inv.num}` },
            { side: pos ? 'C' : 'D', account: '1420', amount: amount.abs().toFixed(2), dims, memo: `НДС не к зачёту, ЭСФ № ${inv.num}` },
          ],
        });
        entryId = entry.id;
      }

      const row = await tx.vatCreditAllocation.create({
        data: {
          organizationId: ctx.organizationId, esfInvoiceId: inv.id, kind: b.kind, year: b.year, quarter: b.quarter, amount, method: b.method,
          shareNumerator: num, shareDenominator: den, ruleCode: VAT_CREDIT_RULE.code, ruleVersion: VAT_CREDIT_RULE.version, basis,
          expenseAccount: b.kind === 'NON_CREDITABLE' ? b.expenseAccount : null, entryId,
          esfSnapshot: sha(JSON.stringify({ bodyHash: inv.bodyHash, status: inv.esfStatus ?? inv.status, totalNds: vat.toFixed(2), decision: inv.businessDecision })),
          createdBy: ctx.userId,
        },
      });
      await tx.auditLog.create({ data: { userId: ctx.userId, organizationId: ctx.organizationId, action: 'VAT_ALLOCATION', entity: 'vat_credit_allocation', entityId: row.id, after: { esfInvoiceId: inv.id, kind: b.kind, year: b.year, quarter: b.quarter, amount: amount.toFixed(2), method: b.method, rule: `${VAT_CREDIT_RULE.code}@${VAT_CREDIT_RULE.version}` } as any, reason: basis } });
      return row;
    });
  }

  /**
   * Сторно строки — в своём квартале (год/квартал корректировки — текущие или указанные), исходная строка не меняется.
   * Для NON_CREDITABLE сторнируется и проводка.
   */
  async reverse(ctx: OrgContext, id: string, b: { basis: string; year: number; quarter: number; date?: string }) {
    const basis = String(b?.basis ?? '').trim();
    if (basis.length < 5) throw new AccError('VAT_BASIS', 'Укажите основание корректировки');
    if (!Number.isInteger(b?.year) || !Number.isInteger(b?.quarter) || b.quarter < 1 || b.quarter > 4) throw new AccError('VAT_PERIOD', 'Укажите год и квартал корректировки');
    return this.prisma.$transaction(async (tx) => {
      const orig = await tx.vatCreditAllocation.findFirst({ where: { id, organizationId: ctx.organizationId } });
      if (!orig) throw new AccError('NOT_FOUND', 'Строка регистра не найдена', { status: 404 });
      if (orig.kind === 'REVERSAL') throw new AccError('VAT_REVERSAL', 'Сторно не сторнируется — сделайте новое распределение');
      if (qIndex(b.year, b.quarter) < qIndex(orig.year, orig.quarter)) throw new AccError('VAT_PERIOD', 'Корректировка не может быть раньше исходного квартала');
      let entryId: string | null = null;
      if (orig.kind === 'NON_CREDITABLE' && orig.entryId) {
        if (!b.date) throw new AccError('VAT_EXPENSE', 'Укажите дату сторнирующей проводки');
        const date = new Date(String(b.date).slice(0, 10) + 'T00:00:00.000Z');
        await this.periods.assertOpen(tx, ctx, [date], undefined, 'сторно отнесения НДС в расходы');
        const src = await tx.accPosting.findMany({ where: { entryId: orig.entryId }, include: { account: true } });
        const { entry } = await this.posting.writeEntry(tx, ctx, {
          sourceType: 'VAT_ALLOCATION', sourceId: `reverse:${orig.id}`, sourceVersion: 1, ruleCode: VAT_CREDIT_RULE.code, ruleVersion: VAT_CREDIT_RULE.version, date,
          postings: src.map((p) => ({ side: p.side === 'D' ? 'C' : 'D', account: p.account.code, amount: p.amount.toFixed(2), dims: { COUNTERPARTY: p.counterpartyId ?? undefined, SETTLEMENT_DOC: p.settlementDocId ?? undefined }, memo: `Сторно: ${p.memo ?? ''}` })),
        });
        entryId = entry.id;
      }
      const row = await tx.vatCreditAllocation.create({
        data: {
          organizationId: ctx.organizationId, esfInvoiceId: orig.esfInvoiceId, kind: 'REVERSAL', year: b.year, quarter: b.quarter, amount: new D(orig.amount).neg(), method: orig.method,
          ruleCode: VAT_CREDIT_RULE.code, ruleVersion: VAT_CREDIT_RULE.version, basis, reversedId: orig.id, expenseAccount: orig.expenseAccount, entryId,
          esfSnapshot: orig.esfSnapshot, createdBy: ctx.userId,
        },
      }).catch((e: any) => {
        if (e?.code === 'P2002') throw new AccError('VAT_REVERSAL', 'Эта строка уже сторнирована', { status: 409 });
        throw e;
      });
      await tx.auditLog.create({ data: { userId: ctx.userId, organizationId: ctx.organizationId, action: 'VAT_ALLOCATION_REVERSED', entity: 'vat_credit_allocation', entityId: row.id, before: { id: orig.id, amount: orig.amount.toFixed(2) } as any, reason: basis } });
      return row;
    });
  }

  /** Регистр за квартал: к зачёту, не к зачёту, сторно — по ЭСФ, с итогами. */
  async register(ctx: OrgContext, year: number, quarter: number) {
    const rows = await this.prisma.vatCreditAllocation.findMany({ where: { organizationId: ctx.organizationId, year: Number(year), quarter: Number(quarter) }, orderBy: { createdAt: 'asc' } });
    const total = (pred: (r: any) => boolean) => rows.filter(pred).reduce((s, r) => s.plus(r.amount), new D(0)).toFixed(2);
    const kindOf = (r: any) => (r.kind === 'REVERSAL' ? rows.find((o) => o.id === r.reversedId)?.kind ?? 'REVERSAL' : r.kind);
    return { year: Number(year), quarter: Number(quarter), rule: VAT_CREDIT_RULE, credited: total((r) => kindOf(r) === 'CREDIT'), nonCreditable: total((r) => kindOf(r) === 'NON_CREDITABLE'), rows };
  }
}
