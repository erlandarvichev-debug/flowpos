// FP-007: торговые документы старого модуля — только своей организации и только со ссылками своего клиента.
import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Scope, orgDocument, tenantCatalog } from '../../common/scope';

type Db = Prisma.TransactionClient;

/** Условие «документы организации», совместимое с собственным OR фильтра (поиск). */
export const orgDocs = (s: Scope, where: Prisma.DocumentWhereInput): Prisma.DocumentWhereInput => ({ AND: [orgDocument(s), where] });

const toDate = (v: any) => (typeof v === 'string' && !v.includes('T') ? new Date(v + 'T00:00:00.000Z') : v ? new Date(v) : undefined);

export interface DocHeader {
  tenantId: string;
  organizationId: string;
  counterpartyId?: string;
  storeId?: string;
  storeToId?: string;
  contractId?: string;
  projectId?: string;
  comment?: string;
  status?: Prisma.DocumentUncheckedCreateInput['status'];
  date?: Date;
}

/**
 * Шапка документа из тела запроса: только реквизиты документа. Клиент и организация — из области;
 * id, номер, итог, служебные поля и чужие связи из тела не принимаются.
 */
export function docHeader(s: Scope, b: any): DocHeader {
  const header: Record<string, any> = { tenantId: s.tenantId, organizationId: s.organizationId };
  for (const k of ['counterpartyId', 'storeId', 'storeToId', 'contractId', 'projectId', 'comment', 'status'] as const) {
    if (b?.[k] !== undefined) header[k] = b[k];
  }
  const date = toDate(b?.date);
  if (date) header.date = date;
  return header as DocHeader;
}

/** Ссылки документа принадлежат клиенту (справочник) и организации (склады). Иначе 400 REF_FOREIGN. */
export async function assertTradeRefs(db: Db, s: Scope, refs: { counterpartyId?: string | null; contractId?: string | null; storeIds?: (string | null | undefined)[]; productIds?: (string | null | undefined)[] }) {
  const fail = (what: string) => {
    throw new BadRequestException({ code: 'REF_FOREIGN', message: `Указан ${what}, которого нет в этой организации` });
  };
  if (refs.counterpartyId && !(await db.counterparty.findFirst({ where: { id: refs.counterpartyId, ...tenantCatalog(s) }, select: { id: true } }))) fail('контрагент');
  if (refs.contractId) {
    const c = await db.contract.findFirst({ where: { id: refs.contractId, tenantId: s.tenantId, counterparty: { OR: [{ organizationId: null }, { organizationId: s.organizationId }] } }, select: { counterpartyId: true } });
    if (!c || (refs.counterpartyId && c.counterpartyId !== refs.counterpartyId)) fail('договор');
  }
  const stores = [...new Set((refs.storeIds ?? []).filter(Boolean) as string[])];
  if (stores.length && (await db.store.count({ where: { id: { in: stores }, organizationId: s.organizationId } })) !== stores.length) fail('склад');
  const products = [...new Set((refs.productIds ?? []).filter(Boolean) as string[])];
  if ((refs.productIds ?? []).some((p) => !p)) fail('товар');
  if (products.length && (await db.product.count({ where: { id: { in: products }, ...tenantCatalog(s) } })) !== products.length) fail('товар');
}

/** Следующий номер — по документам своей организации (раньше считались документы всей базы). */
export async function nextNumber(db: Db, s: Scope, docType: Prisma.DocumentWhereInput['docType'], prefix: string, width: number) {
  const count = await db.document.count({ where: orgDocs(s, { docType }) });
  return `${prefix}-${String(count + 1).padStart(width, '0')}`;
}
