import { PrismaService } from '../../../prisma/prisma.service';
import { AccError } from '../common/acc-error';
import { D } from '../common/money';
import { OrgContext } from '../access/org-context';
import { DEFAULT_ACCOUNTS } from '../autopilot/accounts';
import { profitability } from './profitability';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const kz = (d: string) => new Date(`${d}T00:00:00+05:00`).toISOString();
const shift = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const pct = (cur: InstanceType<typeof D>, prev: InstanceType<typeof D>) => (prev.isZero() ? null : cur.minus(prev).div(prev.abs()).times(100).toDecimalPlaces(1).toNumber());

/**
 * «Пульс бизнеса» (как в УНФ): главные показатели фирмы за период со сравнением с прошлым периодом той же длины —
 * деньги (остаток, приход, расход, остаток по дням), выручка и валовая прибыль, расходы и чистая прибыль (оценка),
 * запасы. Всё по данным учёта (проводки). Долги — отдельно (отчёт «Долги по срокам»).
 */
export async function pulse(prisma: PrismaService, ctx: OrgContext, q: { from?: string; to?: string }) {
  const to = q.to ?? new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10);
  const from = q.from ?? `${to.slice(0, 8)}01`;
  if (!DAY.test(from) || !DAY.test(to) || from > to) throw new AccError('BAD_PERIOD', 'Период: даты ГГГГ-ММ-ДД, начало не позже конца');
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
  if (days > 400) throw new AccError('BAD_PERIOD', 'Период — не больше 400 дней');
  const prevTo = shift(from, -1), prevFrom = shift(prevTo, -(days - 1));
  const policy = await prisma.accPolicy.findFirst({ where: { organizationId: ctx.organizationId, validFrom: { lte: new Date(kz(to)) } }, orderBy: { validFrom: 'desc' } });
  const acc = { ...DEFAULT_ACCOUNTS, ...(((policy?.params as any) ?? {}).accounts ?? {}) } as typeof DEFAULT_ACCOUNTS;
  const end = new Date(Date.parse(kz(to)) + 86400000).toISOString();
  const start = kz(from), pstart = kz(prevFrom);

  // Деньги: остаток на начало, движение по дням (без переводов между своими счетами в приходе/расходе).
  const [moneyRows, moneyOpen, totals] = await Promise.all([
    prisma.$queryRaw<{ d: string; inflow: string; outflow: string; net: string }[]>`
      SELECT to_char(p.date + interval '5 hours', 'YYYY-MM-DD') AS d,
        SUM(CASE WHEN p.side = 'D' AND NOT t.transfer THEN p.amount ELSE 0 END)::text AS inflow,
        SUM(CASE WHEN p.side = 'C' AND NOT t.transfer THEN p.amount ELSE 0 END)::text AS outflow,
        SUM(CASE WHEN p.side = 'D' THEN p.amount ELSE -p.amount END)::text AS net
      FROM acc_postings p
      CROSS JOIN LATERAL (SELECT EXISTS (SELECT 1 FROM acc_postings x WHERE x.entry_id = p.entry_id AND x.is_active AND x.ledger = 'BU' AND x.side <> p.side
        AND (x.bank_account_id IS NOT NULL OR x.cashbox_id IS NOT NULL)) AS transfer) t
      WHERE p.organization_id = ${ctx.organizationId} AND p.is_active AND p.ledger = 'BU' AND (p.bank_account_id IS NOT NULL OR p.cashbox_id IS NOT NULL)
        AND p.date >= ${pstart}::timestamp AND p.date < ${end}::timestamp
      GROUP BY 1 ORDER BY 1`,
    prisma.$queryRaw<{ s: string | null }[]>`
      SELECT SUM(CASE WHEN p.side = 'D' THEN p.amount ELSE -p.amount END)::text AS s FROM acc_postings p
      WHERE p.organization_id = ${ctx.organizationId} AND p.is_active AND p.ledger = 'BU' AND (p.bank_account_id IS NOT NULL OR p.cashbox_id IS NOT NULL)
        AND p.date < ${pstart}::timestamp`,
    // Обороты по счетам за текущий и прошлый период + запасы и выручка по дням.
    prisma.$queryRaw<{ code: string; cur: boolean; d: string; s: string }[]>`
      SELECT a.code, p.date >= ${start}::timestamp AS cur, to_char(p.date + interval '5 hours', 'YYYY-MM-DD') AS d,
        SUM(CASE WHEN p.side = 'D' THEN p.amount ELSE -p.amount END)::text AS s
      FROM acc_postings p JOIN acc_accounts a ON a.id = p.account_id
      WHERE p.organization_id = ${ctx.organizationId} AND p.is_active AND p.ledger = 'BU' AND p.date >= ${pstart}::timestamp AND p.date < ${end}::timestamp
        AND (a.code LIKE '7%' OR a.code IN (${acc.revenue}, ${acc.salesReturn}))
      GROUP BY 1, 2, 3`,
  ]);
  const stockAt = async (before: string) => new D((await prisma.$queryRaw<{ s: string | null }[]>`
    SELECT SUM(CASE WHEN p.side = 'D' THEN p.amount ELSE -p.amount END)::text AS s FROM acc_postings p JOIN acc_accounts a ON a.id = p.account_id
    WHERE p.organization_id = ${ctx.organizationId} AND p.is_active AND p.ledger = 'BU' AND a.code LIKE '13%' AND p.date < ${before}::timestamp`)[0]?.s ?? 0);
  const [stockNow, stockStart, profitCur, profitPrev] = await Promise.all([
    stockAt(end), stockAt(start),
    profitability(prisma, ctx, { from, to }), profitability(prisma, ctx, { from: prevFrom, to: prevTo }),
  ]);

  // Деньги по дням текущего периода: остаток на конец каждого дня.
  let bal = new D(moneyOpen[0]?.s ?? 0);
  let inflow = new D(0), outflow = new D(0), pin = new D(0), pout = new D(0);
  const byDayMoney = new Map(moneyRows.map((r) => [r.d, r]));
  for (const r of moneyRows) {
    if (r.d < from) { bal = bal.plus(r.net); pin = pin.plus(r.inflow); pout = pout.plus(r.outflow); }
  }
  const moneyStart = bal;
  const series: { date: string; money: string; revenue: string }[] = [];
  const revByDay = new Map<string, InstanceType<typeof D>>();
  for (const r of totals) {
    if (!r.cur) continue;
    // выручка: кредит 6010 (знак −) минус возвраты 6020
    if (r.code === acc.revenue) revByDay.set(r.d, (revByDay.get(r.d) ?? new D(0)).minus(r.s));
    if (r.code === acc.salesReturn) revByDay.set(r.d, (revByDay.get(r.d) ?? new D(0)).minus(r.s));
  }
  for (let d = from; d <= to; d = shift(d, 1)) {
    const m = byDayMoney.get(d);
    if (m) { bal = bal.plus(m.net); inflow = inflow.plus(m.inflow); outflow = outflow.plus(m.outflow); }
    series.push({ date: d, money: bal.toFixed(2), revenue: (revByDay.get(d) ?? new D(0)).toFixed(2) });
  }

  // Расходы — счета 7xxx, кроме себестоимости продаж (она уже в валовой прибыли).
  const sumBy = (cur: boolean, f: (code: string) => boolean) => totals.filter((r) => r.cur === cur && f(r.code)).reduce((s, r) => s.plus(r.s), new D(0));
  const isExpense = (c: string) => c.startsWith('7') && c !== acc.cogs;
  const expCur = sumBy(true, isExpense), expPrev = sumBy(false, isExpense);
  const gross = new D(profitCur.totals.profit), grossPrev = new D(profitPrev.totals.profit);
  const net = gross.minus(expCur), netPrev = grossPrev.minus(expPrev);
  const rev = new D(profitCur.totals.netRevenue), revPrev = new D(profitPrev.totals.netRevenue);
  const topExpenses = await (async () => {
    const codes = [...new Set(totals.filter((r) => r.cur && isExpense(r.code)).map((r) => r.code))];
    const names = codes.length ? await prisma.accAccount.findMany({ where: { code: { in: codes } }, select: { code: true, name: true }, distinct: ['code'] }) : [];
    return codes.map((c) => ({ code: c, name: names.find((n) => n.code === c)?.name ?? c, amount: sumBy(true, (x) => x === c).toFixed(2) }))
      .filter((x) => new D(x.amount).gt(0)).sort((a, b) => new D(b.amount).cmp(new D(a.amount))).slice(0, 5);
  })();

  return {
    period: { from, to, prevFrom, prevTo, days },
    money: { start: moneyStart.toFixed(2), end: bal.toFixed(2), inflow: inflow.toFixed(2), outflow: outflow.toFixed(2), prevInflow: pin.toFixed(2), prevOutflow: pout.toFixed(2), inflowDelta: pct(inflow, pin) },
    revenue: { value: rev.toFixed(2), prev: revPrev.toFixed(2), delta: pct(rev, revPrev) },
    grossProfit: { value: gross.toFixed(2), prev: grossPrev.toFixed(2), delta: pct(gross, grossPrev), margin: profitCur.totals.margin, prevMargin: profitPrev.totals.margin },
    expenses: { value: expCur.toFixed(2), prev: expPrev.toFixed(2), delta: pct(expCur, expPrev), top: topExpenses },
    netProfit: { value: net.toFixed(2), prev: netPrev.toFixed(2), delta: pct(net, netPrev) },
    stock: { value: stockNow.toFixed(2), start: stockStart.toFixed(2), delta: pct(stockNow, stockStart) },
    series,
  };
}
