import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AccError } from '../common/acc-error';
import { D } from '../common/money';
import { OrgContext } from '../access/org-context';
import {
  BALANCE_LINES, BALANCE_RULES, BALANCE_SPLIT, CASH_PREFIX, CF_DEFAULT, CF_LINES, CF_RULES, FORMS_SOURCE, FormLine, PL_LINES, PL_RULES,
} from './forms.data';

type Dec = Prisma.Decimal;
export type Unit = 'TENGE' | 'THOUSANDS';
/** Проводки закрытия финрезультата не участвуют в ОПиУ (иначе обороты доходов/расходов обнулятся). */
export const FIN_RESULT_RULE = 'FIN_RESULT';
export const REVAL_RULE = 'REVAL';

export interface StatementLine { code: string; name: string; current: string | null; previous: string | null; bold?: boolean; header?: boolean; indent?: number }
export interface Statement {
  form: 'BALANCE' | 'PL' | 'CASHFLOW';
  title: string;
  source: string;
  organization: { name: string; bin: string | null };
  period: { from?: string; to: string; previousFrom?: string; previousTo: string };
  unit: Unit;
  lines: StatementLine[];
  checks: { code: string; ok: boolean; message: string }[];
  unmapped: { code: string; name: string; amount: string }[];
  note: string;
}

const day = (s: string) => new Date(`${s.slice(0, 10)}T00:00:00.000Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400000);
const minusYear = (s: string) => `${Number(s.slice(0, 4)) - 1}${s.slice(4, 10)}`;

/** Самое длинное совпадение префикса кода счёта. */
function bestRule<T extends { prefixes: string[] }>(rules: T[], code: string): T | undefined {
  let best: T | undefined, len = -1;
  for (const r of rules) for (const p of r.prefixes) if (code.startsWith(p) && p.length > len) { best = r; len = p.length; }
  return best;
}

/** Строки формы: листовые значения (уже в нужных единицах) → итоговые по формулам. */
function computeLines(lines: FormLine[], leaf: Map<string, Dec>): Map<string, Dec> {
  const v = new Map(leaf);
  for (const l of lines) {
    if (!l.formula) continue;
    let s = new D(0);
    for (const c of l.formula.plus ?? []) s = s.plus(v.get(c) ?? 0);
    for (const c of l.formula.minus ?? []) s = s.minus(v.get(c) ?? 0);
    v.set(l.code, s);
  }
  return v;
}

function scale(map: Map<string, Dec>, unit: Unit) {
  if (unit === 'TENGE') return map;
  const out = new Map<string, Dec>();
  for (const [k, val] of map) out.set(k, val.div(1000).toDecimalPlaces(0, D.ROUND_HALF_UP));
  return out;
}

@Injectable()
export class StatementsService {
  constructor(private prisma: PrismaService) {}

  organizationInfo(ctx: OrgContext) { return this.org(ctx); }

  private async org(ctx: OrgContext) {
    const o = await this.prisma.organization.findUnique({ where: { id: ctx.organizationId } });
    return { name: o?.name ?? '', bin: o?.inn ?? null };
  }

  private build(form: Statement['form'], lines: FormLine[], cur: Map<string, Dec>, prev: Map<string, Dec>, unit: Unit) {
    const c = computeLines(lines, scale(cur, unit));
    const p = computeLines(lines, scale(prev, unit));
    const fmt = (x?: Dec) => (x === undefined ? '0.00' : unit === 'TENGE' ? x.toFixed(2) : x.toFixed(0));
    return {
      values: { c, p },
      lines: lines.map((l) => ({ code: l.code, name: l.name, current: l.header ? null : fmt(c.get(l.code)), previous: l.header ? null : fmt(p.get(l.code)), bold: l.bold, header: l.header, indent: l.indent })),
    };
  }

  // ── Сальдо счетов на дату (Дт−Кт), с развёрнутым сальдо расчётов по контрагентам ──
  private async balancesAt(organizationId: string, date: Date) {
    const rows = await this.prisma.$queryRaw<{ code: string; name: string; cp: string | null; bal: Prisma.Decimal }[]>`
      SELECT a.code, a.name,
             CASE WHEN a.code LIKE '1210%' OR a.code LIKE '3510%' OR a.code LIKE '1710%' OR a.code LIKE '3310%' THEN p.counterparty_id ELSE NULL END AS cp,
             SUM(CASE WHEN p.side = 'D' THEN p.amount ELSE -p.amount END) AS bal
        FROM acc_postings p JOIN acc_accounts a ON a.id = p.account_id
       WHERE p.organization_id = ${organizationId} AND p.is_active AND p.ledger = 'BU' AND p.date < ${iso(addDays(date, 1))}::timestamp
       GROUP BY 1, 2, 3
      HAVING SUM(CASE WHEN p.side = 'D' THEN p.amount ELSE -p.amount END) <> 0`;
    return rows.map((r) => ({ ...r, bal: new D(r.bal) }));
  }

  private async balanceValues(organizationId: string, date: Date) {
    const leaf = new Map<string, Dec>();
    const add = (line: string, v: Dec) => leaf.set(line, (leaf.get(line) ?? new D(0)).plus(v));
    const unmapped: { code: string; name: string; amount: string }[] = [];
    for (const r of await this.balancesAt(organizationId, date)) {
      if (r.code.startsWith('0')) { unmapped.push({ code: r.code, name: r.name, amount: r.bal.toFixed(2) }); continue; } // счёт ввода остатков должен быть закрыт
      const split = Object.entries(BALANCE_SPLIT).find(([k]) => r.code.startsWith(k));
      if (split) {
        const [, s] = split;
        if (r.bal.gt(0)) add(s.debit, r.bal); // актив: Дт−Кт
        else add(s.credit, r.bal.neg()); // пассив: Кт−Дт
        continue;
      }
      const rule = bestRule(BALANCE_RULES, r.code);
      if (!rule) { unmapped.push({ code: r.code, name: r.name, amount: r.bal.toFixed(2) }); continue; }
      add(rule.line, rule.side === 'A' ? r.bal : r.bal.neg());
    }
    return { leaf, unmapped };
  }

  async balance(ctx: OrgContext, q: { date?: string; unit?: Unit }): Promise<Statement> {
    const to = q.date ? day(q.date) : day(new Date().toISOString());
    const prevTo = day(`${to.getUTCFullYear() - 1}-12-31`); // на начало года = конец предыдущего
    const unit = q.unit === 'THOUSANDS' ? 'THOUSANDS' : 'TENGE';
    const cur = await this.balanceValues(ctx.organizationId, to);
    const prev = await this.balanceValues(ctx.organizationId, prevTo);
    const { values, lines } = this.build('BALANCE', BALANCE_LINES, cur.leaf, prev.leaf, unit);
    const checks: Statement['checks'] = [];
    for (const [label, m] of [['на отчётную дату', values.c], ['на начало года', values.p]] as const) {
      const a = m.get('BA') ?? new D(0), p = m.get('BP') ?? new D(0);
      // в тысячах допустимо расхождение округления
      const tol = unit === 'THOUSANDS' ? 5 : 0;
      checks.push({ code: 'BALANCE_EQUAL', ok: a.minus(p).abs().lte(tol), message: `Актив = Пассив ${label}: ${a.toFixed(unit === 'TENGE' ? 2 : 0)} / ${p.toFixed(unit === 'TENGE' ? 2 : 0)}` });
    }
    if (cur.unmapped.length) checks.push({ code: 'UNMAPPED', ok: false, message: `Есть остатки на счетах вне форм отчётности: ${cur.unmapped.map((u) => u.code).join(', ')}` });
    return {
      form: 'BALANCE', title: 'Бухгалтерский баланс (форма № 1-Б)', source: FORMS_SOURCE, organization: await this.org(ctx),
      period: { to: iso(to), previousTo: iso(prevTo) }, unit, lines, checks, unmapped: cur.unmapped,
      note: 'Сопоставление строк со счетами — по пояснению к форме и плану счетов ред. 2025; требует проверки бухгалтером. Незакрытый финансовый результат текущего года показан в строке 414.',
    };
  }

  // ── Отчёт о прибылях и убытках ──
  private async plValues(organizationId: string, from: Date, to: Date) {
    const rows = await this.prisma.$queryRaw<{ code: string; name: string; net: Prisma.Decimal }[]>`
      SELECT a.code, a.name, SUM(CASE WHEN p.side = 'C' THEN p.amount ELSE -p.amount END) AS net
        FROM acc_postings p JOIN acc_accounts a ON a.id = p.account_id JOIN acc_entries e ON e.id = p.entry_id
       WHERE p.organization_id = ${organizationId} AND p.is_active AND p.ledger = 'BU'
         AND p.date >= ${iso(from)}::timestamp AND p.date < ${iso(addDays(to, 1))}::timestamp
         AND e.rule_code <> ${FIN_RESULT_RULE} AND (a.code LIKE '6%' OR a.code LIKE '7%')
       GROUP BY 1, 2`;
    const leaf = new Map<string, Dec>();
    const unmapped: { code: string; name: string; amount: string }[] = [];
    for (const r of rows) {
      const net = new D(r.net); // Кт−Дт
      let best: (typeof PL_RULES)[number] | undefined, len = -1;
      for (const rule of PL_RULES) for (const p of [...(rule.income ?? []), ...(rule.expense ?? [])]) if (r.code.startsWith(p) && p.length > len) { best = rule; len = p.length; }
      if (!best) { unmapped.push({ code: r.code, name: r.name, amount: net.toFixed(2) }); continue; }
      // income/expense — положительные величины; net — доходы минус расходы (Кт−Дт)
      const v = best.show === 'income' ? net : best.show === 'expense' ? net.neg() : net;
      leaf.set(best.line, (leaf.get(best.line) ?? new D(0)).plus(v));
    }
    return { leaf, unmapped };
  }

  async profitLoss(ctx: OrgContext, q: { from?: string; to?: string; unit?: Unit }): Promise<Statement> {
    const to = q.to ? day(q.to) : day(new Date().toISOString());
    const from = q.from ? day(q.from) : day(`${to.getUTCFullYear()}-01-01`);
    if (from > to) throw new AccError('BAD_PERIOD', 'Начало периода позже конца');
    const pFrom = day(minusYear(iso(from))), pTo = day(minusYear(iso(to)));
    const unit = q.unit === 'THOUSANDS' ? 'THOUSANDS' : 'TENGE';
    const cur = await this.plValues(ctx.organizationId, from, to);
    const prev = await this.plValues(ctx.organizationId, pFrom, pTo);
    const { lines } = this.build('PL', PL_LINES, cur.leaf, prev.leaf, unit);
    // Сверка: прибыль по отчёту = Σ (Кт−Дт) всех счетов 6–7 за период без закрывающих проводок
    const raw = await this.prisma.$queryRaw<{ net: Prisma.Decimal }[]>`
      SELECT COALESCE(SUM(CASE WHEN p.side = 'C' THEN p.amount ELSE -p.amount END), 0) AS net
        FROM acc_postings p JOIN acc_accounts a ON a.id = p.account_id JOIN acc_entries e ON e.id = p.entry_id
       WHERE p.organization_id = ${ctx.organizationId} AND p.is_active AND p.ledger = 'BU'
         AND p.date >= ${iso(from)}::timestamp AND p.date < ${iso(addDays(to, 1))}::timestamp
         AND e.rule_code <> ${FIN_RESULT_RULE} AND (a.code LIKE '6%' OR a.code LIKE '7%')`;
    const total = new D(raw[0]?.net ?? 0);
    const reported = computeLines(PL_LINES, cur.leaf).get('300') ?? new D(0);
    const checks = [{ code: 'PL_TOTAL', ok: reported.minus(total).abs().lte(0.005), message: `Прибыль за период по отчёту ${reported.toFixed(2)} = сальдо оборотов разделов 6–7 ${total.toFixed(2)}` }];
    if (cur.unmapped.length) checks.push({ code: 'UNMAPPED', ok: false, message: `Счета вне строк отчёта: ${cur.unmapped.map((u) => u.code).join(', ')}` });
    return {
      form: 'PL', title: 'Отчёт о прибылях и убытках (форма № 2-ОПУ)', source: FORMS_SOURCE, organization: await this.org(ctx),
      period: { from: iso(from), to: iso(to), previousFrom: iso(pFrom), previousTo: iso(pTo) }, unit, lines, checks, unmapped: cur.unmapped,
      note: 'Строки сопоставлены по смыслу со счетами разделов 6–7 плана ред. 2025 (пояснение к форме ссылается на старые коды); требует проверки бухгалтером. Проводки закрытия года не учитываются.',
    };
  }

  // ── Отчёт о движении денежных средств (прямой метод) ──
  private async cashValues(organizationId: string, from: Date, to: Date) {
    const rows = await this.prisma.$queryRaw<{ entry_id: string; rule_code: string; code: string; side: string; amount: Prisma.Decimal }[]>`
      SELECT p.entry_id, e.rule_code, a.code, p.side, p.amount
        FROM acc_postings p JOIN acc_accounts a ON a.id = p.account_id JOIN acc_entries e ON e.id = p.entry_id
       WHERE p.organization_id = ${organizationId} AND p.is_active AND p.ledger = 'BU'
         AND p.date >= ${iso(from)}::timestamp AND p.date < ${iso(addDays(to, 1))}::timestamp
         AND p.entry_id IN (
           SELECT p2.entry_id FROM acc_postings p2 JOIN acc_accounts a2 ON a2.id = p2.account_id
            WHERE p2.organization_id = ${organizationId} AND p2.is_active AND p2.ledger = 'BU' AND a2.code LIKE ${CASH_PREFIX + '%'}
              AND p2.date >= ${iso(from)}::timestamp AND p2.date < ${iso(addDays(to, 1))}::timestamp)`;
    const byEntry = new Map<string, typeof rows>();
    for (const r of rows) { const a = byEntry.get(r.entry_id) ?? []; a.push(r); byEntry.set(r.entry_id, a); }
    const leaf = new Map<string, Dec>();
    const add = (line: string, v: Dec) => leaf.set(line, (leaf.get(line) ?? new D(0)).plus(v));
    for (const ps of byEntry.values()) {
      const isCash = (c: string) => c.startsWith(CASH_PREFIX);
      const cashIn = ps.filter((p) => isCash(p.code) && p.side === 'D').reduce((a, p) => a.plus(p.amount), new D(0));
      const cashOut = ps.filter((p) => isCash(p.code) && p.side === 'C').reduce((a, p) => a.plus(p.amount), new D(0));
      const net = cashIn.minus(cashOut); // внутренние перемещения между денежными счетами взаимно сокращаются
      if (net.isZero()) continue;
      if (ps[0].rule_code === REVAL_RULE) { add('120', net); continue; }
      const inflow = net.gt(0);
      const corr = ps.filter((p) => !isCash(p.code) && p.side === (inflow ? 'C' : 'D'));
      const weight = corr.reduce((a, p) => a.plus(p.amount), new D(0));
      if (weight.isZero()) { add(inflow ? CF_DEFAULT.in : CF_DEFAULT.out, net.abs()); continue; }
      let left = net.abs();
      corr.forEach((p, i) => {
        const part = i === corr.length - 1 ? left : net.abs().times(p.amount).div(weight).toDecimalPlaces(2);
        left = left.minus(part);
        const rule = bestRule(CF_RULES, p.code);
        const line = inflow ? rule?.in ?? CF_DEFAULT.in : rule?.out ?? CF_DEFAULT.out;
        add(line, part);
      });
    }
    return leaf;
  }

  private async cashBalance(organizationId: string, date: Date) {
    const r = await this.prisma.$queryRaw<{ bal: Prisma.Decimal }[]>`
      SELECT COALESCE(SUM(CASE WHEN p.side = 'D' THEN p.amount ELSE -p.amount END), 0) AS bal
        FROM acc_postings p JOIN acc_accounts a ON a.id = p.account_id
       WHERE p.organization_id = ${organizationId} AND p.is_active AND p.ledger = 'BU' AND a.code LIKE ${CASH_PREFIX + '%'}
         AND p.date < ${iso(addDays(date, 1))}::timestamp`;
    return new D(r[0]?.bal ?? 0);
  }

  async cashFlow(ctx: OrgContext, q: { from?: string; to?: string; unit?: Unit }): Promise<Statement> {
    const to = q.to ? day(q.to) : day(new Date().toISOString());
    const from = q.from ? day(q.from) : day(`${to.getUTCFullYear()}-01-01`);
    if (from > to) throw new AccError('BAD_PERIOD', 'Начало периода позже конца');
    const pFrom = day(minusYear(iso(from))), pTo = day(minusYear(iso(to)));
    const unit = q.unit === 'THOUSANDS' ? 'THOUSANDS' : 'TENGE';
    const mk = async (f: Date, t: Date) => {
      const leaf = await this.cashValues(ctx.organizationId, f, t);
      leaf.set('150', await this.cashBalance(ctx.organizationId, addDays(f, -1)));
      leaf.set('160', await this.cashBalance(ctx.organizationId, t));
      return leaf;
    };
    const cur = await mk(from, to), prev = await mk(pFrom, pTo);
    const { values, lines } = this.build('CASHFLOW', CF_LINES, cur, prev, unit);
    const checks: Statement['checks'] = [];
    for (const [label, m] of [['отчётный период', values.c], ['предыдущий период', values.p]] as const) {
      const start = m.get('150') ?? new D(0), change = m.get('140') ?? new D(0), end = m.get('160') ?? new D(0);
      const tol = unit === 'THOUSANDS' ? 5 : 0;
      checks.push({ code: 'CASH_RECONCILE', ok: start.plus(change).minus(end).abs().lte(tol), message: `${label}: начало ${start} + изменение ${change} = конец ${end}` });
    }
    return {
      form: 'CASHFLOW', title: 'Отчёт о движении денежных средств, прямой метод (форма № 3-ДДС-П)', source: FORMS_SOURCE, organization: await this.org(ctx),
      period: { from: iso(from), to: iso(to), previousFrom: iso(pFrom), previousTo: iso(pTo) }, unit, lines, checks, unmapped: [],
      note: 'Строка определяется по корреспондирующему счёту движения денег (внутренние перемещения исключены, курсовые разницы — строка 120); требует проверки бухгалтером.',
    };
  }
}
