import { Prisma } from '@prisma/client';
import { AccError } from '../common/acc-error';
import { D, round } from '../common/money';
import { PostingInput, StockMoveInput } from '../core/posting.types';
import { PostingService } from '../core/posting.service';
import { AccountsMap } from './accounts';
import { splitVat, standardVatRate } from './vat';

type Tx = Prisma.TransactionClient;
type Dec = Prisma.Decimal;

export const TRADE_SOURCE = 'TRADE_DOCUMENT';
export const TRADE_RULE_VERSION = '1';

export interface TradeDoc {
  id: string;
  docType: string;
  number: string | null;
  date: Date;
  organizationId: string;
  counterpartyId: string | null;
  contractId: string | null;
  storeId: string | null;
  storeToId: string | null;
  total: Dec | null;
  attributes: any;
  lines: { lineNo: number; productId: string; qty: Dec; price: Dec | null; amount: Dec | null; vatRate: Dec | null; discount: Dec | null; product: { kind: string; vatRate: Dec | null; name: string } }[];
}

export interface TradeRuleCtx {
  tx: Tx;
  organizationId: string;
  posting: PostingService;
  accounts: AccountsMap;
  vatPayer: boolean;
  resolveCashbox: (storeId: string | null) => Promise<string>;
  resolveBankAccount: (hint?: string | null) => Promise<string>;
}

export interface RuleResult {
  postings: PostingInput[];
  moves: StockMoveInput[];
}

const SUPPORTED = ['SUPPLY', 'DEMAND', 'SALES_RETURN', 'PURCHASE_RETURN', 'ENTER', 'LOSS', 'MOVE', 'RETAIL_DEMAND', 'RETAIL_RETURN', 'PAYMENT_IN', 'PAYMENT_OUT'];
/** Документы без бухгалтерских последствий (заказы, счета, инвентаризация, смена). */
export const NO_ACCOUNTING = ['PURCHASE_ORDER', 'CUSTOMER_ORDER', 'INVOICE_IN', 'INVOICE_OUT', 'INVENTORY', 'RETAIL_SHIFT'];

export function isSupported(docType: string) {
  return SUPPORTED.includes(docType);
}

function lineAmount(l: TradeDoc['lines'][number]): Dec {
  if (l.amount !== null && l.amount !== undefined) return new D(l.amount);
  const gross = new D(l.price ?? 0).times(l.qty);
  const disc = l.discount ? gross.times(l.discount).div(100) : new D(0);
  return round(gross.minus(disc));
}

/**
 * Суммы строки: без НДС, НДС, с НДС и применённая ставка. Единый расчёт для проводок и ЭСФ,
 * чтобы счёт-фактура совпадал с учётом до тиына.
 */
export async function tradeLineAmounts(tx: Tx, doc: TradeDoc, l: TradeDoc['lines'][number], vatPayer: boolean) {
  const amount = lineAmount(l);
  if (!vatPayer) return { net: amount, vat: new D(0), gross: amount, rate: null as Dec | null };
  const rate = new D(l.vatRate ?? l.product.vatRate ?? (await standardVatRate(tx, doc.date)));
  const includes = doc.attributes?.vatIncluded !== false; // по умолчанию цены с НДС
  return { ...splitVat(amount, rate, includes), rate };
}

async function lineVat(rc: TradeRuleCtx, doc: TradeDoc, l: TradeDoc['lines'][number]) {
  return tradeLineAmounts(rc.tx, doc, l, rc.vatPayer);
}

const isService = (l: TradeDoc['lines'][number]) => l.product.kind === 'SERVICE';

function need<T>(v: T | null | undefined, code: string, msg: string, fix: string): T {
  if (v === null || v === undefined || v === '') throw new AccError(code, msg, { fix });
  return v;
}

/** Зачёт аванса: сколько можно закрыть из аванса контрагента на дату (без текущего документа). */
async function availableAdvance(rc: TradeRuleCtx, doc: TradeDoc, account: string, sign: 1 | -1): Promise<Dec> {
  const bal = await rc.posting.balance(rc.tx, rc.organizationId, account, doc.date, { COUNTERPARTY: doc.counterpartyId! }, { sourceType: TRADE_SOURCE, sourceId: doc.id });
  const v = sign === 1 ? bal : bal.neg();
  return v.gt(0) ? v : new D(0);
}

export async function buildTradeEntry(doc: TradeDoc, rc: TradeRuleCtx): Promise<RuleResult> {
  const a = rc.accounts;
  const P: PostingInput[] = [];
  const M: StockMoveInput[] = [];
  const cp = () => ({ COUNTERPARTY: need(doc.counterpartyId, 'COUNTERPARTY_REQUIRED', `Документ ${doc.number ?? ''}: не указан контрагент`, 'Укажите контрагента в документе.'), CONTRACT: doc.contractId ?? undefined, SETTLEMENT_DOC: doc.id });
  const store = (id: string | null, what = 'склад') => need(id, 'STORE_REQUIRED', `Документ ${doc.number ?? ''}: не указан ${what}`, `Укажите ${what}.`);
  const inv = (productId: string, storeId: string): Record<string, string> => ({ PRODUCT: productId, STORE: storeId });
  const dept = doc.attributes?.departmentId;

  switch (doc.docType) {
    case 'SUPPLY': {
      const st = store(doc.storeId);
      let total = new D(0);
      for (const l of doc.lines) {
        const { net, vat, gross } = await lineVat(rc, doc, l);
        total = total.plus(gross);
        if (isService(l)) {
          P.push({ side: 'D', account: a.sellingExpense, amount: net.toFixed(2), dims: dept ? { DEPARTMENT: dept } : {}, memo: l.product.name });
        } else {
          P.push({ side: 'D', account: a.inventory, amount: net.toFixed(2), quantity: new D(l.qty).toFixed(3), dims: inv(l.productId, st), memo: l.product.name });
          M.push({ lineNo: l.lineNo, productId: l.productId, storeId: st, account: a.inventory, direction: 'IN', kind: 'PURCHASE', quantity: new D(l.qty).toFixed(3), knownCost: net.toFixed(2) });
        }
        if (!vat.isZero()) P.push({ side: 'D', account: a.vatIn, amount: vat.toFixed(2), dims: { COUNTERPARTY: doc.counterpartyId ?? undefined, SETTLEMENT_DOC: doc.id }, memo: 'НДС к зачёту' });
      }
      const c = cp();
      P.push({ side: 'C', account: a.payable, amount: total.toFixed(2), dims: c, memo: 'Задолженность поставщику' });
      const adv = D.min(await availableAdvance(rc, doc, a.advancePaid, 1), total);
      if (adv.gt(0)) {
        P.push({ side: 'D', account: a.payable, amount: adv.toFixed(2), dims: c, memo: 'Зачёт аванса поставщику' });
        P.push({ side: 'C', account: a.advancePaid, amount: adv.toFixed(2), dims: { COUNTERPARTY: c.COUNTERPARTY, CONTRACT: c.CONTRACT }, memo: 'Зачёт аванса поставщику' });
      }
      break;
    }
    case 'DEMAND':
    case 'RETAIL_DEMAND': {
      const retail = doc.docType === 'RETAIL_DEMAND';
      const st = store(doc.storeId);
      let total = new D(0);
      for (const l of doc.lines) {
        const { net, vat, gross } = await lineVat(rc, doc, l);
        total = total.plus(gross);
        P.push({ side: 'C', account: a.revenue, amount: net.toFixed(2), dims: { PRODUCT: l.productId, DEPARTMENT: dept }, memo: l.product.name });
        if (!vat.isZero()) P.push({ side: 'C', account: a.vatOut, amount: vat.toFixed(2), dims: { COUNTERPARTY: doc.counterpartyId ?? undefined, SETTLEMENT_DOC: doc.id }, memo: 'НДС с реализации' });
        if (!isService(l)) M.push({ lineNo: l.lineNo, productId: l.productId, storeId: st, account: a.inventory, direction: 'OUT', kind: 'SALE', quantity: new D(l.qty).toFixed(3), costAccount: a.cogs });
      }
      if (retail) {
        const pay = doc.attributes?.paymentType === 'CARD' ? 'CARD' : 'CASH';
        if (pay === 'CASH') P.push({ side: 'D', account: a.cash, amount: total.toFixed(2), dims: { CASHBOX: await rc.resolveCashbox(doc.storeId) }, memo: `Розничная выручка ${doc.number ?? ''}` });
        else P.push({ side: 'D', account: a.cashInTransit, amount: total.toFixed(2), memo: `Оплата картой ${doc.number ?? ''}` });
      } else {
        const c = cp();
        P.push({ side: 'D', account: a.receivable, amount: total.toFixed(2), dims: c, memo: 'Задолженность покупателя' });
        const adv = D.min(await availableAdvance(rc, doc, a.advanceReceived, -1), total);
        if (adv.gt(0)) {
          P.push({ side: 'D', account: a.advanceReceived, amount: adv.toFixed(2), dims: { COUNTERPARTY: c.COUNTERPARTY, CONTRACT: c.CONTRACT }, memo: 'Зачёт аванса покупателя' });
          P.push({ side: 'C', account: a.receivable, amount: adv.toFixed(2), dims: c, memo: 'Зачёт аванса покупателя' });
        }
      }
      break;
    }
    case 'SALES_RETURN':
    case 'RETAIL_RETURN': {
      const retail = doc.docType === 'RETAIL_RETURN';
      const st = store(doc.storeId);
      let total = new D(0);
      for (const l of doc.lines) {
        const { net, vat, gross } = await lineVat(rc, doc, l);
        total = total.plus(gross);
        P.push({ side: 'D', account: a.salesReturn, amount: net.toFixed(2), dims: { PRODUCT: l.productId, DEPARTMENT: dept }, memo: `Возврат: ${l.product.name}` });
        if (!vat.isZero()) P.push({ side: 'D', account: a.vatOut, amount: vat.toFixed(2), dims: { COUNTERPARTY: doc.counterpartyId ?? undefined, SETTLEMENT_DOC: doc.id }, memo: 'Уменьшение НДС по возврату' });
        if (!isService(l)) M.push({ lineNo: l.lineNo, productId: l.productId, storeId: st, account: a.inventory, direction: 'IN', kind: 'SALES_RETURN', quantity: new D(l.qty).toFixed(3), knownCost: null, costAccount: a.cogs });
      }
      if (retail) {
        const pay = doc.attributes?.paymentType === 'CARD' ? 'CARD' : 'CASH';
        if (pay === 'CASH') P.push({ side: 'C', account: a.cash, amount: total.toFixed(2), dims: { CASHBOX: await rc.resolveCashbox(doc.storeId) }, memo: `Возврат покупателю ${doc.number ?? ''}` });
        else P.push({ side: 'C', account: a.cashInTransit, amount: total.toFixed(2), memo: `Возврат на карту ${doc.number ?? ''}` });
      } else {
        P.push({ side: 'C', account: a.receivable, amount: total.toFixed(2), dims: cp(), memo: 'Уменьшение задолженности покупателя' });
      }
      break;
    }
    case 'PURCHASE_RETURN': {
      const st = store(doc.storeId);
      let total = new D(0);
      for (const l of doc.lines) {
        const { net, vat, gross } = await lineVat(rc, doc, l);
        total = total.plus(gross);
        if (isService(l)) {
          P.push({ side: 'C', account: a.sellingExpense, amount: net.toFixed(2), memo: l.product.name });
        } else {
          P.push({ side: 'C', account: a.inventory, amount: net.toFixed(2), quantity: new D(l.qty).toFixed(3), dims: inv(l.productId, st), memo: `Возврат поставщику: ${l.product.name}` });
          M.push({ lineNo: l.lineNo, productId: l.productId, storeId: st, account: a.inventory, direction: 'OUT', kind: 'PURCHASE_RETURN', quantity: new D(l.qty).toFixed(3), knownCost: net.toFixed(2) });
        }
        if (!vat.isZero()) P.push({ side: 'C', account: a.vatIn, amount: vat.toFixed(2), dims: { COUNTERPARTY: doc.counterpartyId ?? undefined, SETTLEMENT_DOC: doc.id }, memo: 'Сторно НДС к зачёту' });
      }
      P.push({ side: 'D', account: a.payable, amount: total.toFixed(2), dims: cp(), memo: 'Уменьшение задолженности поставщику' });
      break;
    }
    case 'ENTER': {
      const st = store(doc.storeId);
      for (const l of doc.lines) {
        if (isService(l)) continue;
        const amount = lineAmount(l);
        if (amount.isZero()) throw new AccError('PRICE_REQUIRED', `Оприходование ${doc.number ?? ''}, строка ${l.lineNo}: укажите учётную цену «${l.product.name}»`, { fix: 'Оприходование отражается по справедливой стоимости — заполните цену.' });
        P.push({ side: 'D', account: a.inventory, amount: amount.toFixed(2), quantity: new D(l.qty).toFixed(3), dims: inv(l.productId, st), memo: `Оприходование: ${l.product.name}` });
        P.push({ side: 'C', account: a.otherIncome, amount: amount.toFixed(2), memo: 'Излишки / оприходование' });
        M.push({ lineNo: l.lineNo, productId: l.productId, storeId: st, account: a.inventory, direction: 'IN', kind: 'ENTER', quantity: new D(l.qty).toFixed(3), knownCost: amount.toFixed(2) });
      }
      break;
    }
    case 'LOSS': {
      const st = store(doc.storeId);
      const costAccount = doc.attributes?.lossAccount || a.otherExpense;
      for (const l of doc.lines) {
        if (isService(l)) continue;
        M.push({ lineNo: l.lineNo, productId: l.productId, storeId: st, account: a.inventory, direction: 'OUT', kind: 'LOSS', quantity: new D(l.qty).toFixed(3), costAccount, meta: dept ? { departmentId: dept } : undefined });
      }
      break;
    }
    case 'MOVE': {
      const from = store(doc.storeId, 'склад-отправитель');
      const to = store(doc.storeToId, 'склад-получатель');
      if (from === to) throw new AccError('MOVE_SAME_STORE', 'Склад-отправитель и склад-получатель совпадают');
      for (const l of doc.lines) {
        if (isService(l)) continue;
        const key = `${doc.id}:${l.lineNo}`;
        M.push({ lineNo: l.lineNo, productId: l.productId, storeId: from, account: a.inventory, direction: 'OUT', kind: 'MOVE_OUT', quantity: new D(l.qty).toFixed(3), pairKey: key });
        M.push({ lineNo: l.lineNo, productId: l.productId, storeId: to, account: a.inventory, direction: 'IN', kind: 'MOVE_IN', quantity: new D(l.qty).toFixed(3), pairKey: key });
      }
      break;
    }
    case 'PAYMENT_IN':
    case 'PAYMENT_OUT': {
      const amount = new D(doc.total ?? 0);
      if (amount.lte(0)) throw new AccError('ZERO_AMOUNT', `Платёж ${doc.number ?? ''}: сумма не указана`);
      const bankAccountId = await rc.resolveBankAccount(doc.attributes?.bankAccountId);
      const c = cp();
      P.push(...(await settlementPostings(rc, doc.docType === 'PAYMENT_IN' ? 'IN' : 'OUT', amount, { account: a.bank, dims: { BANK_ACCOUNT: bankAccountId } }, c, doc.date, { sourceType: TRADE_SOURCE, sourceId: doc.id })));
      break;
    }
    default:
      throw new AccError('NO_RULE', `Нет правила отражения для документа типа ${doc.docType}`);
  }
  return { postings: P, moves: M };
}

/**
 * Оплата с автоматическим разнесением: сначала закрывается долг, остаток — аванс.
 * IN (от покупателя): Дт деньги / Кт 1210 (долг) + Кт 3510 (аванс).
 * OUT (поставщику):   Дт 3310 (долг) + Дт 1710 (аванс) / Кт деньги.
 */
export async function settlementPostings(
  rc: Pick<TradeRuleCtx, 'tx' | 'organizationId' | 'posting' | 'accounts'>,
  direction: 'IN' | 'OUT',
  amount: Dec,
  money: { account: string; dims: Record<string, string>; currency?: string; currencyAmount?: string },
  cp: { COUNTERPARTY: string; CONTRACT?: string; SETTLEMENT_DOC?: string },
  date: Date,
  exclude: { sourceType: string; sourceId: string },
  partyAccounts?: { debt: string; advance: string },
): Promise<PostingInput[]> {
  const a = rc.accounts;
  const debtAcc = partyAccounts?.debt ?? (direction === 'IN' ? a.receivable : a.payable);
  const advAcc = partyAccounts?.advance ?? (direction === 'IN' ? a.advanceReceived : a.advancePaid);
  const bal = await rc.posting.balance(rc.tx, rc.organizationId, debtAcc, date, { COUNTERPARTY: cp.COUNTERPARTY, CONTRACT: cp.CONTRACT }, exclude);
  const debt = direction === 'IN' ? bal : bal.neg(); // 1210 — дебетовое сальдо; 3310 — кредитовое
  const toDebt = D.max(new D(0), D.min(debt, amount));
  const toAdv = amount.minus(toDebt);
  const P: PostingInput[] = [];
  const partyDims = { COUNTERPARTY: cp.COUNTERPARTY, CONTRACT: cp.CONTRACT };
  const moneySide = direction === 'IN' ? 'D' : 'C';
  const partySide = direction === 'IN' ? 'C' : 'D';
  P.push({ side: moneySide, account: money.account, amount: amount.toFixed(2), dims: money.dims, currency: money.currency, currencyAmount: money.currencyAmount, memo: direction === 'IN' ? 'Поступление оплаты' : 'Оплата поставщику' });
  if (toDebt.gt(0)) P.push({ side: partySide, account: debtAcc, amount: toDebt.toFixed(2), dims: partyDims, memo: 'Погашение задолженности' });
  if (toAdv.gt(0)) P.push({ side: partySide, account: advAcc, amount: toAdv.toFixed(2), dims: partyDims, memo: direction === 'IN' ? 'Аванс полученный' : 'Аванс выданный' });
  return P;
}
