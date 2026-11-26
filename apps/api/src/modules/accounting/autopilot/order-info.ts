import { Prisma } from '@prisma/client';
import { D } from '../common/money';

/**
 * Этапы заказа, которые ставит человек. «Отгружен/получен частично», «отгружен/получен», «закрыт» — не ставятся руками:
 * их считает сервер по проведённым реализациям/поступлениям на основании заказа и по закрытию заказа.
 */
export const ORDER_STAGES: Record<string, string[]> = {
  CUSTOMER_ORDER: ['NEW', 'CONFIRMED', 'ASSEMBLING', 'ASSEMBLED'],
  PURCHASE_ORDER: ['NEW', 'SENT', 'CONFIRMED'],
};
export const isOrder = (docType: string) => docType === 'CUSTOMER_ORDER' || docType === 'PURCHASE_ORDER';

export type FulfillState = 'OPEN' | 'PARTIAL' | 'FULFILLED' | 'CLOSED';

/** Исполнение заказа по строкам: исполненное распределяется по строкам одного товара по порядку. */
export function fulfillLines(orderLines: { lineNo: number; productId: string; qty: any }[], doneByProduct: Map<string, Prisma.Decimal>) {
  const done = new Map(doneByProduct);
  const lines = orderLines.map((l) => {
    const ordered = new D(l.qty);
    const avail = done.get(l.productId) ?? new D(0);
    const take = D.min(avail, ordered);
    done.set(l.productId, avail.minus(take));
    return { lineNo: l.lineNo, productId: l.productId, ordered: ordered.toString(), fulfilled: take.toString(), remaining: ordered.minus(take).toString() };
  });
  return { lines, extra: [...done.entries()].filter(([, q]) => q.gt(0)) };
}

export function fulfillState(lines: { fulfilled: string; remaining: string }[], closed: unknown): FulfillState {
  return lines.every((l) => new D(l.remaining).isZero()) ? 'FULFILLED' : closed ? 'CLOSED' : lines.some((l) => new D(l.fulfilled).gt(0)) ? 'PARTIAL' : 'OPEN';
}

/**
 * Статус заказа для журнала и карточки: закрыт / исполнен (SHIPPED — отгружен, RECEIVED — получен) / частично /
 * этап, поставленный человеком (по умолчанию «Новый»). Черновик и помеченный на удаление — как есть.
 */
export function orderStatus(docType: string, attrs: any, state: FulfillState): string {
  if (state === 'FULFILLED') return docType === 'PURCHASE_ORDER' ? 'RECEIVED' : 'SHIPPED';
  if (state === 'CLOSED') return 'CLOSED';
  if (state === 'PARTIAL') return docType === 'PURCHASE_ORDER' ? 'PARTLY_RECEIVED' : 'PARTLY_SHIPPED';
  const stage = attrs?.stage;
  return ORDER_STAGES[docType]?.includes(stage) ? stage : 'NEW';
}
