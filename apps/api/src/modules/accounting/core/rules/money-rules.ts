import { Prisma } from '@prisma/client';
import { AccError } from '../../common/acc-error';
import { D, money, round } from '../../common/money';
import { PostingInput } from '../posting.types';
import { settlementPostings } from '../../autopilot/trade-rules';
import { DocLike, PostingRule, RuleContext } from './rules';

type Tx = Prisma.TransactionClient;

const OPS: Record<string, string[]> = {
  BANK_IN: ['CUSTOMER', 'ACQUIRING', 'OTHER', 'ACCOUNTABLE_RETURN'],
  CASH_IN: ['CUSTOMER', 'OTHER', 'ACCOUNTABLE_RETURN', 'FROM_BANK'],
  BANK_OUT: ['SUPPLIER', 'PAYROLL', 'TRANSFER', 'COMMISSION', 'ACCOUNTABLE', 'OTHER'],
  CASH_OUT: ['SUPPLIER', 'PAYROLL', 'TRANSFER', 'ACCOUNTABLE', 'OTHER'],
};
const OP_LABEL: Record<string, string> = {
  CUSTOMER: 'оплата от покупателя', SUPPLIER: 'оплата поставщику', TRANSFER: 'перевод между своими счетами/кассами',
  COMMISSION: 'комиссия банка', ACCOUNTABLE: 'выдача под отчёт', ACCOUNTABLE_RETURN: 'возврат подотчётной суммы', OTHER: 'прочая операция',
  FROM_BANK: 'получение наличных с банковского счёта',
  ACQUIRING: 'зачисление оплат картами (эквайринг)',
  PAYROLL: 'выплата зарплаты / перечисление налогов и взносов с зарплаты',
};

async function moneyAccount(tx: Tx, organizationId: string, b: any, which: 'self' | 'to') {
  const bankId = which === 'self' ? b.bankAccountId : b.toBankAccountId;
  const cashId = which === 'self' ? b.cashboxId : b.toCashboxId;
  if (bankId) {
    const acc = await tx.orgBankAccount.findFirst({ where: { id: bankId, organizationId } });
    if (!acc) throw new AccError('REF_FOREIGN', 'Банковский счёт не найден в этой организации');
    return { account: acc.accountCode, dims: { BANK_ACCOUNT: acc.id, ...(b.itemId ? { ITEM: b.itemId } : {}) } as Record<string, string>, currency: acc.currency };
  }
  if (cashId) {
    const c = await tx.cashbox.findFirst({ where: { id: cashId, organizationId } });
    if (!c) throw new AccError('REF_FOREIGN', 'Касса не найдена в этой организации');
    return { account: c.accountCode, dims: { CASHBOX: c.id, ...(b.itemId ? { ITEM: b.itemId } : {}) } as Record<string, string>, currency: c.currency };
  }
  throw new AccError('MONEY_ACCOUNT_REQUIRED', which === 'self' ? 'Укажите банковский счёт или кассу' : 'Укажите счёт или кассу получателя', { fix: 'Выберите из справочника.' });
}

/** Сумма в тенге: для валютного счёта — по курсу на дату (последний известный не позже даты). */
async function tengeAmount(tx: Tx, b: any, currency: string, date: Date) {
  if (currency === 'KZT') return { amount: money(b.amount, 2, 'сумма') };
  const cur = money(b.currencyAmount, 2, `сумма в ${currency}`);
  const r = await tx.currencyRate.findFirst({ where: { currencyCode: currency, date: { lte: date } }, orderBy: { date: 'desc' } });
  if (!r) throw new AccError('RATE_MISSING', `Нет курса ${currency} на ${date.toISOString().slice(0, 10)}`, { fix: 'Загрузите курс в справочнике «Курсы валют».', link: '/accounting/refs' });
  return { amount: round(cur.times(r.rate).div(r.multiplier)), currency, currencyAmount: cur.toFixed(2), rate: r.rate.toString() };
}

function makeMoneyRule(docType: 'BANK_IN' | 'BANK_OUT' | 'CASH_IN' | 'CASH_OUT', title: { ru: string; kk: string }, prefix: string): PostingRule {
  const incoming = docType.endsWith('_IN');
  return {
    docType, code: docType, version: '1', title, numberPrefix: prefix,
    amount: (b) => String(b?.amount ?? '0'),
    async build(doc: DocLike, rc: RuleContext): Promise<PostingInput[]> {
      const b = doc.body || {};
      const op = b.operation;
      if (!OPS[docType].includes(op)) throw new AccError('BAD_OPERATION', `Вид операции не выбран или недопустим (${op ?? '—'})`, { fix: `Допустимо: ${OPS[docType].map((o) => OP_LABEL[o]).join(', ')}.` });
      const tx = rc.tx;
      const self = await moneyAccount(tx, rc.organizationId, b, 'self');
      const t = await tengeAmount(tx, b, self.currency, doc.date);
      if (t.amount.lte(0)) throw new AccError('ZERO_AMOUNT', 'Сумма должна быть больше нуля');
      const m = { account: self.account, dims: self.dims, currency: t.currency, currencyAmount: t.currencyAmount };
      const amount = t.amount.toFixed(2);
      const memo = b.purpose || OP_LABEL[op];
      const P: PostingInput[] = [];
      const side = incoming ? 'D' : 'C';
      const other = incoming ? 'C' : 'D';
      switch (op) {
        case 'CUSTOMER':
        case 'SUPPLIER': {
          if (!b.counterpartyId) throw new AccError('COUNTERPARTY_REQUIRED', 'Укажите контрагента', { fix: 'Выберите покупателя или поставщика.' });
          return settlementPostings({ tx, organizationId: rc.organizationId, posting: rc.posting!, accounts: rc.accounts! }, incoming ? 'IN' : 'OUT', t.amount, m,
            { COUNTERPARTY: b.counterpartyId, CONTRACT: b.contractId }, doc.date, { sourceType: 'ACC_DOCUMENT', sourceId: doc.id });
        }
        case 'TRANSFER':
        case 'FROM_BANK': {
          const to = await moneyAccount(tx, rc.organizationId, op === 'FROM_BANK' ? { bankAccountId: b.fromBankAccountId } : b, op === 'FROM_BANK' ? 'self' : 'to');
          if (to.currency !== self.currency) throw new AccError('CURRENCY_MISMATCH', 'Перевод между счетами в разных валютах оформляется как покупка/продажа валюты (этап 3)');
          const toM = { account: to.account, dims: to.dims, currency: t.currency, currencyAmount: t.currencyAmount };
          P.push({ side: 'D', ...(op === 'FROM_BANK' ? m : toM), amount, memo });
          P.push({ side: 'C', ...(op === 'FROM_BANK' ? toM : m), amount, memo });
          return P;
        }
        case 'ACQUIRING': {
          // Банк зачисляет оплаты картами за вычетом комиссии: Дт 1030 (зачислено) + Дт расходы (комиссия) / Кт 1020 (всего продаж по картам)
          if (self.currency !== 'KZT') throw new AccError('CURRENCY_MISMATCH', 'Эквайринг зачисляется на тенговый счёт');
          const fee = b.commission ? money(b.commission, 2, 'комиссия') : new D(0);
          if (fee.lt(0)) throw new AccError('BAD_AMOUNT', 'Комиссия не может быть отрицательной');
          const gross = t.amount.plus(fee);
          P.push({ side: 'D', ...m, amount, memo: memo + (fee.gt(0) ? ` (комиссия ${fee.toFixed(2)})` : '') });
          if (fee.gt(0)) P.push({ side: 'D', account: rc.accounts!.sellingExpense, amount: fee.toFixed(2), dims: b.itemId ? { ITEM: b.itemId } : {}, memo: 'Комиссия банка за эквайринг' });
          P.push({ side: 'C', account: rc.accounts!.cashInTransit, amount: gross.toFixed(2), memo: 'Списание денег в пути по картам' });
          return P;
        }
        case 'PAYROLL': {
          // Строки: зарплата к выплате (3350) по сотрудникам, налоги и взносы (31xx, 32xx). Сумма документа = сумма строк.
          const lines: { account: string; employeeId?: string; amount: string }[] = b.lines ?? [];
          if (!lines.length) throw new AccError('LINES_REQUIRED', 'Нет строк выплаты', { fix: 'Сформируйте выплату из расчёта зарплаты.' });
          if (self.currency !== 'KZT') throw new AccError('CURRENCY_MISMATCH', 'Зарплата и взносы перечисляются в тенге');
          let total = new D(0);
          for (const l of lines) {
            if (!/^(3350|31|32)/.test(String(l.account))) throw new AccError('BAD_ACCOUNT', `Счёт ${l.account} не относится к расчётам по оплате труда, налогам и взносам`);
            const amt = money(l.amount, 2, 'сумма строки');
            total = total.plus(amt);
            P.push({ side: 'D', account: l.account, amount: amt.toFixed(2), dims: l.employeeId ? { EMPLOYEE: l.employeeId } : {}, memo });
          }
          if (!total.equals(t.amount)) throw new AccError('AMOUNT_MISMATCH', `Сумма документа ${t.amount.toFixed(2)} не равна сумме строк ${total.toFixed(2)}`);
          P.push({ side: 'C', ...m, amount, memo });
          return P;
        }
        case 'COMMISSION':
          P.push({ side: 'D', account: rc.accounts!.adminExpense, amount, dims: b.itemId ? { ITEM: b.itemId } : {}, memo });
          P.push({ side, ...m, amount, memo });
          return P;
        case 'ACCOUNTABLE':
        case 'ACCOUNTABLE_RETURN':
          if (!b.employeeId) throw new AccError('EMPLOYEE_REQUIRED', 'Укажите сотрудника (подотчётное лицо)');
          P.push({ side, ...m, amount, memo });
          P.push({ side: other, account: rc.accounts!.employeeReceivable, amount, dims: { EMPLOYEE: b.employeeId }, memo });
          return P;
        case 'OTHER':
          if (!b.corrAccount) throw new AccError('CORR_ACCOUNT_REQUIRED', 'Для прочей операции укажите корреспондирующий счёт');
          P.push({ side, ...m, amount, memo });
          P.push({ side: other, account: b.corrAccount, amount, dims: b.corrDims || {}, memo });
          return P;
      }
      return P;
    },
  };
}

export const MONEY_RULES = [
  makeMoneyRule('BANK_IN', { ru: 'Поступление на расчётный счёт', kk: 'Есеп шотқа түсім' }, 'ПРС'),
  makeMoneyRule('BANK_OUT', { ru: 'Списание с расчётного счёта', kk: 'Есеп шоттан есептен шығару' }, 'СРС'),
  makeMoneyRule('CASH_IN', { ru: 'Приходный кассовый ордер', kk: 'Кірістік кассалық ордер' }, 'ПКО'),
  makeMoneyRule('CASH_OUT', { ru: 'Расходный кассовый ордер', kk: 'Шығыстық кассалық ордер' }, 'РКО'),
];
export { OPS as MONEY_OPERATIONS, OP_LABEL as MONEY_OPERATION_LABELS };
