// FP-041: проводки документов по основным средствам и НМА.
//   ASSET_ACCEPT — принятие к учёту: Дт 2410/2730 (стоимость) [+ Дт 1420 НДС] / Кт 3310 поставщику или Кт счёт-источник
//                  (2930 незавершённое строительство, 1310 и т. п.).
//   ASSET_DISPOSE — выбытие (списание, продажа, передача): Дт 2420/2740 (накопленная амортизация) + Дт 7110 (остаточная
//                  стоимость) / Кт 2410/2730 (стоимость). Амортизация должна быть начислена по месяц выбытия включительно.
// Доход от продажи ОС — отдельным документом реализации/операцией (6110).
import { Prisma } from '@prisma/client';
import { AccError } from '../common/acc-error';
import { D } from '../common/money';
import { PostingInput } from '../core/posting.types';
import { DocLike, PostingRule, RuleContext } from '../core/rules/rules';

type Tx = Prisma.TransactionClient;
const SOURCE = 'ACC_DOCUMENT';
export const monthOf = (d: Date) => d.toISOString().slice(0, 7);
export function nextMonth(p: string) { const [y, m] = p.split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`; }

export async function assetOf(tx: Tx, organizationId: string, id: unknown) {
  if (typeof id !== 'string' || !id) throw new AccError('ASSET_REQUIRED', 'Не указан объект основных средств');
  const a = await tx.fixedAsset.findFirst({ where: { id, organizationId } });
  if (!a) throw new AccError('REF_FOREIGN', 'Объект основных средств не найден в этой организации');
  return a;
}

/** Проведённый документ данного вида по объекту (кроме exceptId). */
export async function postedDoc(tx: Tx, organizationId: string, docType: string, assetId: string, exceptId?: string) {
  return tx.accDocument.findFirst({ where: { organizationId, docType, status: 'POSTED', id: exceptId ? { not: exceptId } : undefined, body: { path: ['assetId'], equals: assetId } }, orderBy: { date: 'asc' } });
}

export const AssetAcceptRule: PostingRule & { guard: typeof acceptGuard } = {
  docType: 'ASSET_ACCEPT',
  code: 'KZ_ASSET_ACCEPT',
  version: '1.0.0',
  title: { ru: 'Принятие к учёту ОС / НМА', kk: 'НҚ / МЕА есепке алу' },
  numberPrefix: 'ОС',
  amount: (b) => new D(b?.cost || 0).plus(new D(/^\d+(\.\d+)?$/.test(String(b?.vatAmount ?? '')) ? b.vatAmount : 0)).toFixed(2),
  async build(doc: DocLike, rc: RuleContext): Promise<PostingInput[]> {
    const b = doc.body ?? {};
    const a = await assetOf(rc.tx, rc.organizationId, b.assetId);
    const cost = new D(a.cost);
    if (cost.lte(0)) throw new AccError('ASSET_COST_REQUIRED', `${a.inventoryNumber}: укажите первоначальную стоимость`);
    if (!new D(b.cost ?? 0).eq(cost)) throw new AccError('ASSET_CHANGED', `${a.inventoryNumber}: стоимость в карточке (${cost.toFixed(2)}) отличается от документа (${new D(b.cost ?? 0).toFixed(2)}) — пересоздайте документ`);
    if (a.usefulLifeMonths <= 0) throw new AccError('ASSET_LIFE_REQUIRED', `${a.inventoryNumber}: укажите срок полезного использования`);
    if (new D(a.salvage).gte(cost)) throw new AccError('ASSET_SALVAGE', `${a.inventoryNumber}: ликвидационная стоимость не меньше первоначальной`);
    const other = await postedDoc(rc.tx, rc.organizationId, 'ASSET_ACCEPT', a.id, doc.id);
    if (other) throw new AccError('ASSET_ALREADY_ACCEPTED', `${a.inventoryNumber} уже принят к учёту документом ${other.number}`);
    const dept = a.departmentId ? { DEPARTMENT: a.departmentId } : {};
    const P: PostingInput[] = [{ side: 'D', account: a.assetAccount, amount: cost.toFixed(2), dims: dept, memo: `Принятие к учёту ${a.inventoryNumber} ${a.name}` }];
    const vatRaw = String(b.vatAmount ?? '').replace(/\s/g, '').replace(',', '.');
    if (vatRaw && !/^\d+(\.\d{1,2})?$/.test(vatRaw)) throw new AccError('BAD_AMOUNT', 'НДС — число');
    const vat = new D(vatRaw || 0);
    if (vat.lt(0)) throw new AccError('BAD_AMOUNT', 'НДС не может быть отрицательным');
    if (b.source === 'SUPPLIER') {
      if (!b.counterpartyId) throw new AccError('COUNTERPARTY_REQUIRED', 'Укажите поставщика');
      const cp = { COUNTERPARTY: b.counterpartyId, SETTLEMENT_DOC: doc.id };
      if (!vat.isZero()) P.push({ side: 'D', account: rc.accounts?.vatIn ?? '1420', amount: vat.toFixed(2), dims: cp, memo: 'НДС по приобретённому ОС' });
      P.push({ side: 'C', account: rc.accounts?.payable ?? '3310', amount: cost.plus(vat).toFixed(2), dims: cp, memo: 'Задолженность поставщику' });
    } else {
      if (!vat.isZero()) throw new AccError('VAT_ONLY_SUPPLIER', 'НДС указывается только при покупке у поставщика');
      const corr = String(b.corrAccount ?? '2930');
      if (!/^\d{4}$/.test(corr)) throw new AccError('BAD_ACCOUNT', 'Счёт-источник — четыре цифры');
      P.push({ side: 'C', account: corr, amount: cost.toFixed(2), memo: 'Источник поступления ОС' });
    }
    return P;
  },
  guard: acceptGuard,
};

/** Снять/изменить/пометить принятие нельзя, пока есть амортизация или проведённое выбытие. */
async function acceptGuard(doc: DocLike, tx: Tx, organizationId: string) {
  const id = doc.body?.assetId;
  if (!id) return;
  const depr = await tx.assetDepreciation.count({ where: { organizationId, assetId: id } });
  const disp = await postedDoc(tx, organizationId, 'ASSET_DISPOSE', id);
  if (depr || disp) throw new AccError('ASSET_IN_USE', `По объекту ${depr ? 'начислена амортизация' : ''}${depr && disp ? ' и ' : ''}${disp ? `проведено выбытие ${disp.number}` : ''} — сначала отмените их`, { status: 409 });
}

export const AssetDisposeRule: PostingRule = {
  docType: 'ASSET_DISPOSE',
  code: 'KZ_ASSET_DISPOSE',
  version: '1.0.0',
  title: { ru: 'Выбытие ОС / НМА', kk: 'НҚ / МЕА шығуы' },
  numberPrefix: 'ВОС',
  amount: (b) => new D(b?.cost ?? 0).toFixed(2),
  async build(doc: DocLike, rc: RuleContext): Promise<PostingInput[]> {
    const b = doc.body ?? {};
    const a = await assetOf(rc.tx, rc.organizationId, b.assetId);
    if (String(b.reason ?? '').trim().length < 5) throw new AccError('REASON_REQUIRED', 'Укажите основание выбытия (продажа, списание, передача…)');
    const acc = await postedDoc(rc.tx, rc.organizationId, 'ASSET_ACCEPT', a.id);
    if (!acc) throw new AccError('ASSET_NOT_ACCEPTED', `${a.inventoryNumber} не принят к учёту`);
    if (acc.date > doc.date) throw new AccError('ASSET_NOT_ACCEPTED', `${a.inventoryNumber} принят к учёту позже даты выбытия`);
    const other = await postedDoc(rc.tx, rc.organizationId, 'ASSET_DISPOSE', a.id, doc.id);
    if (other) throw new AccError('ASSET_ALREADY_DISPOSED', `${a.inventoryNumber} уже выбыл документом ${other.number}`);
    const month = monthOf(doc.date);
    const later = await rc.tx.assetDepreciation.findFirst({ where: { assetId: a.id, period: { gt: month } } });
    if (later) throw new AccError('ASSET_DEPR_AFTER', `Амортизация начислена за ${later.period} — после месяца выбытия; отмените её`);
    const rows = await rc.tx.assetDepreciation.findMany({ where: { assetId: a.id }, orderBy: { period: 'asc' } });
    const cost = new D(a.cost), accumulated = rows.reduce((s, r) => s.plus(r.amount), new D(0));
    const depreciable = cost.minus(a.salvage);
    // Амортизация по месяц выбытия включительно (если объект не самортизирован полностью раньше).
    const start = nextMonth(monthOf(acc.date));
    if (month >= start && accumulated.lt(depreciable) && !rows.some((r) => r.period === month)) {
      throw new AccError('ASSET_DEPR_REQUIRED', `Начислите амортизацию за ${month} — по месяц выбытия включительно`, { link: '/assets/depreciation' });
    }
    const nbv = cost.minus(accumulated);
    const dept = a.departmentId ? { DEPARTMENT: a.departmentId } : {};
    const P: PostingInput[] = [];
    if (accumulated.gt(0)) P.push({ side: 'D', account: a.deprAccount, amount: accumulated.toFixed(2), dims: dept, memo: `Списание амортизации ${a.inventoryNumber}` });
    if (nbv.gt(0)) P.push({ side: 'D', account: (rc.accounts as any)?.disposalExpense ?? '7110', amount: nbv.toFixed(2), memo: `Остаточная стоимость ${a.inventoryNumber}: ${String(b.reason).trim()}` });
    P.push({ side: 'C', account: a.assetAccount, amount: cost.toFixed(2), dims: dept, memo: `Выбытие ${a.inventoryNumber} ${a.name}` });
    return P;
  },
};

export const ASSET_RULES: PostingRule[] = [AssetAcceptRule, AssetDisposeRule];
export { SOURCE as ASSET_DOC_SOURCE };
