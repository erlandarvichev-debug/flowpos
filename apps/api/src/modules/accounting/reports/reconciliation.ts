// Акт сверки взаимных расчётов с контрагентом за период: сальдо на начало, обороты по документам, сальдо на конец —
// по счетам расчётов (покупатели 1210, авансы полученные 3510, поставщики 3310, авансы выданные 1710; счета из учётной
// политики). Знак — с точки зрения организации: «+» — контрагент должен нам, «−» — мы должны контрагенту.
// Обязательной формы нет; печатная форма — в две стороны («по данным организации» / «по данным контрагента»).
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AccError } from '../common/acc-error';
import { OrgContext } from '../access/org-context';
import { D } from '../common/money';
import { DEFAULT_ACCOUNTS } from '../autopilot/accounts';

type Dec = Prisma.Decimal;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const TRADE_LABEL: Record<string, string> = {
  DEMAND: 'Реализация', SALES_RETURN: 'Возврат от покупателя', RETAIL_DEMAND: 'Розничная продажа', RETAIL_RETURN: 'Возврат по чеку',
  SUPPLY: 'Поступление', PURCHASE_RETURN: 'Возврат поставщику', LANDED_COST: 'Доп. расходы', PAYMENT_IN: 'Оплата от покупателя', PAYMENT_OUT: 'Оплата поставщику',
};
const ACC_LABEL: Record<string, string> = {
  BANK_IN: 'Поступление на счёт', BANK_OUT: 'Списание со счёта', CASH_IN: 'Приходный кассовый ордер', CASH_OUT: 'Расходный кассовый ордер',
  MANUAL_OPERATION: 'Операция', OPENING_BALANCE: 'Ввод остатков', STORNO: 'Сторно',
};

export interface ReconciliationRow { date: string; document: string; sourceType: string; sourceId: string; debit: string; credit: string }
export interface Reconciliation {
  organization: { name: string; bin: string | null };
  counterparty: { id: string; name: string; bin: string | null };
  contract: { id: string; number: string } | null;
  period: { from: string; to: string };
  opening: string;
  rows: ReconciliationRow[];
  turnover: { debit: string; credit: string };
  closing: string;
  accounts: string[];
}

export async function reconciliation(prisma: PrismaService, ctx: OrgContext, q: { counterpartyId?: string; contractId?: string; from?: string; to?: string }): Promise<Reconciliation> {
  if (!q.counterpartyId) throw new AccError('COUNTERPARTY_REQUIRED', 'Укажите контрагента');
  if (!q.from || !q.to || !DATE.test(q.from) || !DATE.test(q.to) || q.from > q.to) throw new AccError('BAD_PERIOD', 'Период: дата начала и окончания (ГГГГ-ММ-ДД)');
  const cp = await prisma.counterparty.findFirst({ where: { id: q.counterpartyId, tenantId: ctx.tenantId, OR: [{ organizationId: null }, { organizationId: ctx.organizationId }] }, select: { id: true, name: true, inn: true } });
  if (!cp) throw new AccError('NOT_FOUND', 'Контрагент не найден', { status: 404 });
  const contract = q.contractId ? await prisma.contract.findFirst({ where: { id: q.contractId, counterpartyId: cp.id }, select: { id: true, number: true } }) : null;
  if (q.contractId && !contract) throw new AccError('NOT_FOUND', 'Договор не найден у этого контрагента', { status: 404 });

  const from = new Date(`${q.from}T00:00:00.000Z`), toNext = new Date(new Date(`${q.to}T00:00:00.000Z`).getTime() + 86_400_000);
  const policy = await prisma.accPolicy.findFirst({ where: { organizationId: ctx.organizationId, validFrom: { lte: toNext } }, orderBy: { validFrom: 'desc' } });
  const acc = { ...DEFAULT_ACCOUNTS, ...(((policy?.params as any) ?? {}).accounts ?? {}) };
  const codes = [...new Set([acc.receivable, acc.advanceReceived, acc.payable, acc.advancePaid])];
  const accounts = await prisma.accAccount.findMany({ where: { OR: codes.map((c) => ({ code: { startsWith: c } })), AND: { OR: [{ organizationId: null }, { organizationId: ctx.organizationId }] } }, select: { id: true } });
  const base: Prisma.AccPostingWhereInput = {
    organizationId: ctx.organizationId, isActive: true, ledger: 'BU', counterpartyId: cp.id, accountId: { in: accounts.map((a) => a.id) },
    entry: { status: 'ACTIVE' }, ...(contract ? { contractId: contract.id } : {}),
  };
  const signed = (side: string, amount: Prisma.Decimal | number) => (side === 'D' ? new D(amount) : new D(amount).neg());

  const before = await prisma.accPosting.groupBy({ by: ['side'], where: { ...base, date: { lt: from } }, _sum: { amount: true } });
  const opening = before.reduce((s, r) => s.plus(signed(r.side, r._sum.amount ?? 0)), new D(0));

  const postings = await prisma.accPosting.findMany({
    where: { ...base, date: { gte: from, lt: toNext } },
    select: { side: true, amount: true, date: true, entryId: true, entry: { select: { sourceType: true, sourceId: true } } },
    orderBy: [{ date: 'asc' }, { entryId: 'asc' }],
  });
  // Строка акта — документ (запись): дебет — долг контрагента вырос, кредит — уменьшился.
  const byEntry = new Map<string, { date: Date; sourceType: string; sourceId: string; net: Dec }>();
  for (const p of postings) {
    const cur = byEntry.get(p.entryId) ?? { date: p.date, sourceType: p.entry.sourceType, sourceId: p.entry.sourceId, net: new D(0) };
    cur.net = cur.net.plus(signed(p.side, p.amount));
    byEntry.set(p.entryId, cur);
  }
  const ids = (t: string) => [...byEntry.values()].filter((e) => e.sourceType === t).map((e) => e.sourceId);
  const [trade, accDocs] = await Promise.all([
    prisma.document.findMany({ where: { id: { in: ids('TRADE_DOCUMENT') } }, select: { id: true, number: true, docType: true, date: true } }),
    prisma.accDocument.findMany({ where: { id: { in: ids('ACC_DOCUMENT') }, organizationId: ctx.organizationId }, select: { id: true, number: true, docType: true, date: true } }),
  ]);
  const label = (t: string, id: string) => {
    if (t === 'TRADE_DOCUMENT') { const d = trade.find((x) => x.id === id); return d ? `${TRADE_LABEL[d.docType] ?? d.docType} № ${d.number ?? ''}` : 'Документ'; }
    if (t === 'ACC_DOCUMENT') { const d = accDocs.find((x) => x.id === id); return d ? `${ACC_LABEL[d.docType] ?? d.docType} № ${d.number ?? ''}` : 'Документ'; }
    return t;
  };
  let td = new D(0), tc = new D(0);
  const rows: ReconciliationRow[] = [];
  for (const e of byEntry.values()) {
    if (e.net.isZero()) continue; // зачёт аванса внутри одного документа — на сальдо не влияет
    const debit = e.net.gt(0) ? e.net : new D(0), credit = e.net.lt(0) ? e.net.neg() : new D(0);
    td = td.plus(debit); tc = tc.plus(credit);
    rows.push({ date: e.date.toISOString().slice(0, 10), document: label(e.sourceType, e.sourceId), sourceType: e.sourceType, sourceId: e.sourceId, debit: debit.toFixed(2), credit: credit.toFixed(2) });
  }
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { name: true, inn: true } });
  return {
    organization: { name: org.name, bin: org.inn }, counterparty: { id: cp.id, name: cp.name, bin: cp.inn }, contract,
    period: { from: q.from, to: q.to }, opening: opening.toFixed(2), rows, turnover: { debit: td.toFixed(2), credit: tc.toFixed(2) },
    closing: opening.plus(td).minus(tc).toFixed(2), accounts: codes,
  };
}
