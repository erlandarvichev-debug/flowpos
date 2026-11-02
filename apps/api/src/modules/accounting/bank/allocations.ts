// FP-036: журнал разнесения оплат. После каждого проведения / отмены платежа (банк, касса: оплата покупателя или
// поставщику) действующие строки журнала сверяются с проводками: изменилось — прежние отменяются (кто, когда, причина),
// пишутся новые; не изменилось — журнал не трогается. Каждое изменение — в журнале аудита.
import { Prisma } from '@prisma/client';
import { OrgContext } from '../access/org-context';

type Tx = Prisma.TransactionClient;
const D = Prisma.Decimal;
export const MONEY_DOCS = ['BANK_IN', 'BANK_OUT', 'CASH_IN', 'CASH_OUT'];

interface Row { account: string; kind: 'DEBT' | 'ADVANCE'; settlementDocId: string | null; amount: string }
const sig = (rows: Row[]) => rows.map((r) => `${r.account}|${r.kind}|${r.settlementDocId ?? ''}|${new D(r.amount).toFixed(2)}`).sort().join(';');

export async function syncAllocations(
  tx: Tx, ctx: OrgContext,
  doc: { id: string; docType: string; version: number; status: string; body: any },
  accounts: { receivable: string; payable: string; advanceReceived: string; advancePaid: string },
  reason: string,
) {
  if (!MONEY_DOCS.includes(doc.docType)) return;
  const b = doc.body ?? {};
  let rows: Row[] = [];
  if (doc.status === 'POSTED' && (b.operation === 'CUSTOMER' || b.operation === 'SUPPLIER') && b.counterpartyId) {
    const debt = new Set([accounts.receivable, accounts.payable]), adv = new Set([accounts.advanceReceived, accounts.advancePaid]);
    const postings = await tx.accPosting.findMany({
      where: { organizationId: ctx.organizationId, isActive: true, entry: { sourceType: 'ACC_DOCUMENT', sourceId: doc.id, status: 'ACTIVE' } },
      include: { account: { select: { code: true } } },
    });
    rows = postings
      .filter((p) => debt.has(p.account.code) || adv.has(p.account.code))
      .map((p) => ({ account: p.account.code, kind: debt.has(p.account.code) ? 'DEBT' : 'ADVANCE', settlementDocId: p.settlementDocId, amount: new D(p.amount).toFixed(2) }));
  }
  const active = await tx.paymentAllocation.findMany({ where: { organizationId: ctx.organizationId, paymentDocId: doc.id, status: 'ACTIVE' } });
  const before = active.map((a) => ({ account: a.account, kind: a.kind as Row['kind'], settlementDocId: a.settlementDocId, amount: a.amount.toFixed(2) }));
  if (sig(before) === sig(rows)) return;
  const now = new Date();
  for (const a of active) {
    await tx.paymentAllocation.update({ where: { id: a.id }, data: { status: 'REVERSED', reversedAt: now, reversedBy: ctx.userId, reverseReason: reason } });
  }
  const manual = Array.isArray(b.allocations) && b.allocations.length > 0;
  for (const r of rows) {
    await tx.paymentAllocation.create({
      data: { organizationId: ctx.organizationId, paymentDocId: doc.id, paymentVersion: doc.version, counterpartyId: b.counterpartyId, account: r.account, kind: r.kind, settlementDocId: r.settlementDocId, amount: new D(r.amount), manual: manual && r.kind === 'DEBT', createdBy: ctx.userId },
    });
  }
  await tx.auditLog.create({
    data: { userId: ctx.userId, organizationId: ctx.organizationId, action: rows.length ? 'PAYMENT_ALLOCATED' : 'PAYMENT_ALLOCATION_REVERSED', entity: 'acc_document', entityId: doc.id, reason, before: before as any, after: rows as any },
  });
}
