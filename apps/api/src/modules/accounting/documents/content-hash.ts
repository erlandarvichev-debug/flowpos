// FP-028/FP-029: каноническое содержимое документа и его хэш — одно определение для истории версий, согласований
// и проверки при проведении (иначе согласование «того же» документа могло бы не совпасть по хэшу).
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';

const D = Prisma.Decimal;
const sha256 = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex');

/** Торговый документ: шапка и строки в фиксированном порядке, без статуса и версии. */
export function tradeContent(doc: any) {
  return {
    docType: doc.docType, number: doc.number, date: new Date(doc.date).toISOString(), counterpartyId: doc.counterpartyId ?? null,
    contractId: doc.contractId ?? null, storeId: doc.storeId ?? null, storeToId: doc.storeToId ?? null,
    total: doc.total == null ? null : new D(doc.total).toFixed(2), comment: doc.comment ?? null, attributes: doc.attributes ?? null,
    lines: [...(doc.lines ?? [])].sort((a: any, b: any) => a.lineNo - b.lineNo).map((l: any) => ({
      lineNo: l.lineNo, productId: l.productId, qty: new D(l.qty).toString(), price: l.price == null ? null : new D(l.price).toFixed(2),
      discount: l.discount == null ? null : new D(l.discount).toString(), amount: l.amount == null ? null : new D(l.amount).toFixed(2), vatRate: l.vatRate == null ? null : new D(l.vatRate).toString(),
    })),
  };
}

export const tradeHash = (doc: any) => sha256(tradeContent(doc));

/** Бухгалтерский документ: реквизиты и тело, без статуса и версии. */
export function accContent(doc: any) {
  return {
    docType: doc.docType, number: doc.number, date: new Date(doc.date).toISOString(), currency: doc.currency,
    amount: new D(doc.amount ?? 0).toFixed(2), comment: doc.comment ?? null, body: doc.body ?? null,
    baseDocumentId: doc.baseDocumentId ?? null, reversalOfId: doc.reversalOfId ?? null,
  };
}

export const accHash = (doc: any) => sha256(accContent(doc));
