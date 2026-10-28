import { Prisma } from '@prisma/client';
import { AccError } from '../../common/acc-error';
import { PostingInput } from '../posting.types';

export interface RuleContext {
  tx: Prisma.TransactionClient;
  organizationId: string;
  posting?: import('../posting.service').PostingService;
  accounts?: import('../../autopilot/accounts').AccountsMap;
}

export interface DocLike {
  id: string;
  docType: string;
  date: Date;
  body: any;
  reversalOfId?: string | null;
}

/** Правило формирования проводок по типу документа. version меняется при изменении логики. */
export interface PostingRule {
  docType: string;
  code: string;
  version: string;
  title: { ru: string; kk: string };
  numberPrefix: string;
  build(doc: DocLike, rc: RuleContext): Promise<PostingInput[]>;
  amount(body: any): string;
}

const side = (s: any) => s || {};

function lineAmount(l: any) {
  return l?.amount === undefined || l?.amount === null ? '0' : String(l.amount);
}

function sumAmounts(lines: any[]): string {
  return lines.reduce((a, l) => a.plus(new Prisma.Decimal(lineAmount(l) || '0')), new Prisma.Decimal(0)).toFixed(2);
}

/** Ручная операция: строки «Дт счёт / Кт счёт / сумма» с аналитиками по каждой стороне. */
export const ManualOperationRule: PostingRule = {
  docType: 'MANUAL_OPERATION',
  code: 'MANUAL_OPERATION',
  version: '1',
  title: { ru: 'Операция (вручную)', kk: 'Операция (қолмен)' },
  numberPrefix: 'ОП',
  amount: (body) => sumAmounts(body?.lines || []),
  async build(doc) {
    const lines: any[] = doc.body?.lines || [];
    const out: PostingInput[] = [];
    lines.forEach((l, i) => {
      const ledgers: ('BU' | 'NU')[] = l.ledger === 'BOTH' ? ['BU', 'NU'] : [l.ledger === 'NU' ? 'NU' : 'BU'];
      const dr = side(l.debit);
      const cr = side(l.credit);
      if (!dr.account || !cr.account) throw new AccError('LINE_INCOMPLETE', `Строка ${i + 1}: укажите счёт дебета и кредита`);
      for (const ledger of ledgers) {
        out.push({ ledger, side: 'D', account: dr.account, amount: l.amount, dims: dr.dims, quantity: dr.quantity, currency: dr.currency, currencyAmount: dr.currencyAmount, memo: l.memo });
        out.push({ ledger, side: 'C', account: cr.account, amount: l.amount, dims: cr.dims, quantity: cr.quantity, currency: cr.currency, currencyAmount: cr.currencyAmount, memo: l.memo });
      }
    });
    return out;
  },
};

/** Ввод начальных остатков: каждая строка корреспондирует со вспомогательным счётом 0000. */
export const OpeningBalanceRule: PostingRule = {
  docType: 'OPENING_BALANCE',
  code: 'OPENING_BALANCE',
  version: '1',
  title: { ru: 'Ввод начальных остатков', kk: 'Бастапқы қалдықтарды енгізу' },
  numberPrefix: 'ВО',
  amount: (body) => sumAmounts(body?.lines || []),
  async build(doc) {
    const lines: any[] = doc.body?.lines || [];
    const out: PostingInput[] = [];
    lines.forEach((l, i) => {
      if (!l.account) throw new AccError('LINE_INCOMPLETE', `Строка ${i + 1}: укажите счёт`);
      if (l.side !== 'D' && l.side !== 'C') throw new AccError('LINE_INCOMPLETE', `Строка ${i + 1}: укажите сальдо — дебетовое или кредитовое`);
      const ledgers: ('BU' | 'NU')[] = l.ledger === 'NU' ? ['NU'] : l.ledger === 'BU' ? ['BU'] : ['BU', 'NU'];
      for (const ledger of ledgers) {
        out.push({ ledger, side: l.side, account: l.account, amount: l.amount, dims: l.dims, quantity: l.quantity, currency: l.currency, currencyAmount: l.currencyAmount, memo: l.memo });
        out.push({ ledger, side: l.side === 'D' ? 'C' : 'D', account: '0000', amount: l.amount, memo: 'Ввод остатков' });
      }
    });
    return out;
  },
};

/** Сторно: копия активных проводок исходного документа с обратным знаком, датой сторно. */
export const StornoRule: PostingRule = {
  docType: 'STORNO',
  code: 'STORNO',
  version: '1',
  title: { ru: 'Сторно документа', kk: 'Құжатты сторнолау' },
  numberPrefix: 'СТ',
  amount: (body) => String(body?.amount ?? '0'),
  async build(doc, { tx, organizationId }) {
    if (!doc.reversalOfId) throw new AccError('STORNO_NO_SOURCE', 'Не указан сторнируемый документ');
    const entry = await tx.accEntry.findFirst({
      where: { organizationId, sourceType: 'ACC_DOCUMENT', sourceId: doc.reversalOfId, status: 'ACTIVE' },
      include: { postings: { include: { account: true }, orderBy: [{ ledger: 'asc' }, { lineNo: 'asc' }] } },
    });
    if (!entry) throw new AccError('STORNO_SOURCE_NOT_POSTED', 'Сторнируемый документ не проведён');
    return entry.postings.map((p) => ({
      ledger: p.ledger as any,
      side: p.side as any,
      account: p.account.code,
      amount: p.amount.neg().toFixed(2),
      currency: p.currency || undefined,
      currencyAmount: p.currencyAmount ? p.currencyAmount.neg().toFixed(2) : undefined,
      quantity: p.quantity ? p.quantity.neg().toFixed(3) : undefined,
      dims: {
        COUNTERPARTY: p.counterpartyId || undefined, CONTRACT: p.contractId || undefined, SETTLEMENT_DOC: p.settlementDocId || undefined,
        PRODUCT: p.productId || undefined, STORE: p.storeId || undefined, EMPLOYEE: p.employeeId || undefined,
        DEPARTMENT: p.departmentId || undefined, BANK_ACCOUNT: p.bankAccountId || undefined, CASHBOX: p.cashboxId || undefined,
        PROJECT: p.projectId || undefined, ITEM: p.itemId || undefined,
      },
      memo: `Сторно: ${p.memo || ''}`.trim(),
    }));
  },
};

export const RULES: Record<string, PostingRule> = {
  [ManualOperationRule.docType]: ManualOperationRule,
  [OpeningBalanceRule.docType]: OpeningBalanceRule,
  [StornoRule.docType]: StornoRule,
};

export function registerRule(r: PostingRule) {
  RULES[r.docType] = r;
}

export function ruleFor(docType: string): PostingRule {
  const r = RULES[docType];
  if (!r) throw new AccError('UNKNOWN_DOC_TYPE', `Неизвестный тип документа: ${docType}`);
  return r;
}
