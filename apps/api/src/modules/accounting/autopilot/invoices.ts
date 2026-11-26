import { Prisma } from '@prisma/client';
import { D } from '../common/money';
import { daysBetween, kzDay, termsFor } from './payment-terms';

type Tx = Prisma.TransactionClient;

/** Счёт покупателю / счёт поставщика: коммерческий документ без проводок (как заказ). */
export const INVOICE_TYPES = ['INVOICE_OUT', 'INVOICE_IN'] as const;
export const isInvoice = (t: string) => t === 'INVOICE_OUT' || t === 'INVOICE_IN';
/** Документ отгрузки/приёмки по счёту. */
export const invoiceTarget = (t: string) => (t === 'INVOICE_OUT' ? 'DEMAND' : 'SUPPLY');

export interface InvoiceState {
  /** PAID — оплачен полностью, PARTIAL — частично, UNPAID — нет оплат. */
  status: 'PAID' | 'PARTIAL' | 'UNPAID';
  paid: string;
  /** Осталось оплатить. */
  left: string;
  /** Отгружено (принято) по счёту — сумма проведённых реализаций (поступлений) на его основании. */
  shipped: string;
  dueDate: string;
  termSource: string;
  overdueDays: number;
  /** Платежи по счёту (банк/касса с пометкой «по счёту»). */
  payments: { id: string; number: string; date: Date; docType: string; amount: string }[];
}

/**
 * Состояние счетов: оплачено — проведённые платежи банка/кассы, созданные «по счёту» (body.invoiceId),
 * отгружено — проведённые документы на основании счёта. Сам платёж разносится по долгам как обычно (или аванс).
 */
export async function invoiceStates(tx: Tx, organizationId: string, docs: { id: string; docType: string; status: string; deleted: boolean; total: Prisma.Decimal | null; date: Date; counterpartyId?: string | null; contractId?: string | null; attributes?: any }[]) {
  const res = new Map<string, InvoiceState>();
  const list = docs.filter((d) => isInvoice(d.docType) && !d.deleted && d.status !== 'CANCELLED');
  if (!list.length) return res;
  const ids = list.map((d) => d.id);
  const [pays, children, terms] = await Promise.all([
    tx.accDocument.findMany({
      where: { organizationId, status: 'POSTED', OR: ids.map((id) => ({ body: { path: ['invoiceId'], equals: id } })) },
      select: { id: true, number: true, date: true, docType: true, amount: true, body: true }, orderBy: { date: 'asc' },
    }),
    tx.document.findMany({
      where: { status: 'POSTED', deleted: false, docType: { in: ['DEMAND', 'SUPPLY'] as any }, OR: ids.map((id) => ({ attributes: { path: ['baseId'], equals: id } })) },
      select: { total: true, attributes: true },
    }),
    termsFor(tx, list),
  ]);
  const today = kzDay(new Date());
  for (const d of list) {
    const mine = pays.filter((p) => (p.body as any)?.invoiceId === d.id);
    const paid = mine.reduce((s, p) => s.plus(new D(p.amount ?? 0).abs()), new D(0));
    const shipped = children.filter((c) => (c.attributes as any)?.baseId === d.id).reduce((s, c) => s.plus(c.total ?? 0), new D(0));
    const total = new D(d.total ?? 0);
    const left = D.max(total.minus(paid), new D(0));
    const t = terms.get(d.id)!;
    const open = left.gt(0.004);
    res.set(d.id, {
      status: !open ? 'PAID' : paid.gt(0) ? 'PARTIAL' : 'UNPAID', paid: paid.toFixed(2), left: left.toFixed(2), shipped: shipped.toFixed(2),
      dueDate: t.dueDate, termSource: t.source, overdueDays: open ? Math.max(0, daysBetween(t.dueDate, today)) : 0,
      payments: mine.map((p) => ({ id: p.id, number: p.number, date: p.date, docType: p.docType, amount: new D(p.amount ?? 0).abs().toFixed(2) })),
    });
  }
  return res;
}
