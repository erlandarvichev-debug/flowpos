import { Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

/** День по Казахстану (UTC+5) в виде ГГГГ-ММ-ДД. */
export const kzDay = (d: Date) => new Date(d.getTime() + 5 * 3600_000).toISOString().slice(0, 10);
export const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
/** Дней от a до b (b − a), обе — ГГГГ-ММ-ДД. */
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400_000);

export const DUE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_PAYMENT_DAYS = 365;

/** Отсрочка оплаты из запроса: целое 0…365 или null (не задана). */
export function parsePaymentDays(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > MAX_PAYMENT_DAYS) throw new Error(`Отсрочка оплаты — целое число дней от 0 до ${MAX_PAYMENT_DAYS}`);
  return n;
}

export interface TermsDoc { id: string; date: Date; counterpartyId?: string | null; contractId?: string | null; attributes?: any }
export interface Terms {
  /** Срок оплаты, ГГГГ-ММ-ДД по Казахстану. */
  dueDate: string;
  /** Отсрочка, дней (null — срок задан в документе вручную). */
  days: number | null;
  /** Откуда срок: DOC — «Оплатить до» в документе, CONTRACT — отсрочка договора, COUNTERPARTY — контрагента, NONE — в день документа. */
  source: 'DOC' | 'CONTRACT' | 'COUNTERPARTY' | 'NONE';
}

/**
 * Срок оплаты документов: «Оплатить до» в самом документе, иначе дата документа + отсрочка договора,
 * иначе + отсрочка контрагента, иначе — в день документа (оплата при отгрузке).
 */
export async function termsFor(tx: Tx, docs: TermsDoc[]): Promise<Map<string, Terms>> {
  const res = new Map<string, Terms>();
  if (!docs.length) return res;
  const contractIds = [...new Set(docs.map((d) => d.contractId).filter(Boolean))] as string[];
  const cpIds = [...new Set(docs.map((d) => d.counterpartyId).filter(Boolean))] as string[];
  type Row = { id: string; paymentDays: number | null };
  const [contracts, cps]: [Row[], Row[]] = await Promise.all([
    contractIds.length ? tx.contract.findMany({ where: { id: { in: contractIds } }, select: { id: true, paymentDays: true } }) : Promise.resolve([]),
    cpIds.length ? tx.counterparty.findMany({ where: { id: { in: cpIds } }, select: { id: true, paymentDays: true } }) : Promise.resolve([]),
  ]);
  const kDays = new Map<string, number | null>(contracts.map((c) => [c.id, c.paymentDays]));
  const cDays = new Map<string, number | null>(cps.map((c) => [c.id, c.paymentDays]));
  for (const d of docs) {
    const own = d.attributes?.dueDate;
    if (typeof own === 'string' && DUE_DATE_RE.test(own)) { res.set(d.id, { dueDate: own, days: null, source: 'DOC' }); continue; }
    const k = d.contractId ? kDays.get(d.contractId) : null;
    const c = d.counterpartyId ? cDays.get(d.counterpartyId) : null;
    const [days, source]: [number, Terms['source']] = k != null ? [k, 'CONTRACT'] : c != null ? [c, 'COUNTERPARTY'] : [0, 'NONE'];
    res.set(d.id, { dueDate: addDays(kzDay(d.date), days), days, source });
  }
  return res;
}

/** Корзины просрочки для отчёта «Долги по срокам». */
export const AGING_BUCKETS = ['notDue', 'd1_30', 'd31_60', 'd61_90', 'd90plus'] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];
export const bucketOf = (overdueDays: number): AgingBucket =>
  overdueDays <= 0 ? 'notDue' : overdueDays <= 30 ? 'd1_30' : overdueDays <= 60 ? 'd31_60' : overdueDays <= 90 ? 'd61_90' : 'd90plus';
