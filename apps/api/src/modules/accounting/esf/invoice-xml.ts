// ЭСФ InvoiceV2: сборка XML строго по XSD ИС ЭСФ (EsfXsdService.queryInvoiceXsd, версия InvoiceV2)
// и разбор входящих ЭСФ. Порядок элементов = порядок xs:sequence в схеме — иначе ФЛК отклонит.
// Пояснения к графам — «Правила выписки счета-фактуры и его формы» (приказ МФ РК, НК РК 2026).
import { XMLParser } from 'fast-xml-parser';

export const INVOICE_VERSION = 'InvoiceV2';

export type InvoiceType = 'ORDINARY_INVOICE' | 'FIXED_INVOICE' | 'ADDITIONAL_INVOICE';

export interface EsfParty {
  tin?: string;
  name: string;
  address?: string;
  countryCode?: string;
  statuses?: string[];
  trailer?: string;
  branchTin?: string;
}

export interface EsfSeller extends EsfParty {
  bank?: string;
  bik?: string;
  iik?: string;
  kbe?: string;
  ndsRegistrationDate?: string; // dd.MM.yyyy
}

export interface EsfProduct {
  truOriginCode: string; // G2: 1..6
  description: string; // G3
  catalogTruId: string; // G20
  unitCode?: string; // G5 ТН ВЭД ЕАЭС
  unitNomenclature?: string; // G6 код по классификатору ИС ЭСФ
  quantity?: string; // G7
  unitPrice?: string; // G10 без косвенных налогов
  priceWithoutTax: string; // G11
  turnoverSize: string; // G14
  ndsRate?: number; // G15 (нет — «Без НДС»)
  ndsAmount: string; // G16
  priceWithTax: string; // G17
  gtinCode?: string; // G21
  additional?: string; // G22
}

export interface EsfInvoiceData {
  date: string; // A2 дата выписки (= день отправки), dd.MM.yyyy
  invoiceType: InvoiceType;
  num: string; // A1.1 номер учётной системы, только цифры
  operatorFullname: string;
  relatedInvoice?: { date: string; num: string; registrationNumber?: string };
  turnoverDate: string; // A3
  addInf?: string;
  consignee?: { countryCode: string; address?: string; name?: string; tin?: string };
  customers: EsfParty[];
  deliveryDocNum?: string;
  deliveryDocDate?: string;
  deliveryTerm: {
    hasContract: boolean;
    contractNum?: string;
    contractDate?: string;
    paymentForm: 'CASH' | 'NON_CASH';
    transportTypeCode?: string;
  };
  currencyCode: string;
  currencyRate?: string;
  products: EsfProduct[];
  totals: { exciseAmount: string; ndsAmount: string; priceWithTax: string; priceWithoutTax: string; turnoverSize: string };
  sellers: EsfSeller[];
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** Элемент только если значение есть. */
function el(name: string, v: string | number | boolean | undefined | null): string {
  if (v === undefined || v === null || v === '') return '';
  return `<${name}>${esc(String(v))}</${name}>`;
}

function statuses(list?: string[]) {
  if (!list?.length) return '';
  return `<statuses>${list.map((s) => el('status', s)).join('')}</statuses>`;
}

/** Дата для ЭСФ: dd.MM.yyyy (как в образце SDK). Берём календарную дату без сдвига часового пояса. */
export function esfDate(d: Date | string): string {
  const iso = typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10);
  const [y, m, day] = iso.split('-');
  return `${day}.${m}.${y}`;
}

export function parseEsfDate(s: string): Date {
  const [d, m, y] = s.split('.');
  return new Date(`${y}-${m}-${d}T00:00:00.000Z`);
}

export function buildInvoiceV2(d: EsfInvoiceData): string {
  const customers = d.customers
    .map(
      (c) =>
        '<customer>' +
        el('address', c.address) +
        el('branchTin', c.branchTin) +
        el('countryCode', c.countryCode ?? 'KZ') +
        el('name', c.name) +
        statuses(c.statuses) +
        el('tin', c.tin) +
        el('trailer', c.trailer) +
        '</customer>',
    )
    .join('');

  const products = d.products
    .map(
      (p) =>
        '<product>' +
        el('additional', p.additional) +
        el('catalogTruId', p.catalogTruId) +
        el('description', p.description) +
        el('gtinCode', p.gtinCode) +
        el('ndsAmount', p.ndsAmount) +
        el('ndsRate', p.ndsRate) +
        el('priceWithTax', p.priceWithTax) +
        el('priceWithoutTax', p.priceWithoutTax) +
        el('quantity', p.quantity) +
        el('truOriginCode', p.truOriginCode) +
        el('turnoverSize', p.turnoverSize) +
        el('unitCode', p.unitCode) +
        el('unitNomenclature', p.unitNomenclature) +
        el('unitPrice', p.unitPrice) +
        '</product>',
    )
    .join('');

  const sellers = d.sellers
    .map(
      (s) =>
        '<seller>' +
        el('address', s.address) +
        el('bank', s.bank) +
        el('bik', s.bik) +
        el('branchTin', s.branchTin) +
        el('countryCode', s.countryCode) +
        el('iik', s.iik) +
        el('kbe', s.kbe) +
        el('name', s.name) +
        el('ndsRegistrationDate', s.ndsRegistrationDate) +
        statuses(s.statuses) +
        el('tin', s.tin) +
        el('trailer', s.trailer) +
        '</seller>',
    )
    .join('');

  const t = d.deliveryTerm;
  const rel = d.relatedInvoice
    ? `<relatedInvoice>${el('date', d.relatedInvoice.date)}${el('num', d.relatedInvoice.num)}${el('registrationNumber', d.relatedInvoice.registrationNumber)}</relatedInvoice>`
    : '';
  const consignee = d.consignee
    ? `<consignee>${el('address', d.consignee.address)}${el('countryCode', d.consignee.countryCode)}${el('name', d.consignee.name)}${el('tin', d.consignee.tin)}</consignee>`
    : '';

  return (
    // Вид как у InvoiceXmlUtil.invoiceToUnformattedXml в SDK КГД: без XML-декларации, без форматирования
    '<v2:invoice xmlns:v2="v2.esf">' +
    el('date', d.date) +
    el('invoiceType', d.invoiceType) +
    el('num', d.num) +
    el('operatorFullname', d.operatorFullname) +
    rel +
    el('turnoverDate', d.turnoverDate) +
    el('addInf', d.addInf) +
    consignee +
    `<customers>${customers}</customers>` +
    el('deliveryDocDate', d.deliveryDocDate) +
    el('deliveryDocNum', d.deliveryDocNum) +
    '<deliveryTerm>' +
    el('contractDate', t.hasContract ? t.contractDate : undefined) +
    el('contractNum', t.hasContract ? t.contractNum : undefined) +
    el('hasContract', t.hasContract) +
    el('paymentForm', t.paymentForm) +
    el('transportTypeCode', t.transportTypeCode) +
    '</deliveryTerm>' +
    '<productSet>' +
    el('currencyCode', d.currencyCode) +
    el('currencyRate', d.currencyRate) +
    `<products>${products}</products>` +
    el('totalExciseAmount', d.totals.exciseAmount) +
    el('totalNdsAmount', d.totals.ndsAmount) +
    el('totalPriceWithTax', d.totals.priceWithTax) +
    el('totalPriceWithoutTax', d.totals.priceWithoutTax) +
    el('totalTurnoverSize', d.totals.turnoverSize) +
    '</productSet>' +
    `<sellers>${sellers}</sellers>` +
    '</v2:invoice>'
  );
}

// ── Разбор входящих ЭСФ ──

const parser = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true, parseTagValue: false, trimValues: true, isArray: (n) => ['customer', 'seller', 'product', 'status'].includes(n) });

export interface ParsedInvoice {
  num: string;
  date: string;
  turnoverDate: string;
  invoiceType: string;
  relatedInvoice?: { date: string; num: string; registrationNumber?: string };
  seller: { tin?: string; name?: string };
  customer: { tin?: string; name?: string };
  currencyCode: string;
  totals: { ndsAmount: string; priceWithTax: string; priceWithoutTax: string };
  products: { description?: string; quantity?: string; priceWithoutTax: string; ndsAmount: string; ndsRate?: string; priceWithTax: string; truOriginCode?: string; unitNomenclature?: string }[];
}

/** Разбор XML ЭСФ любой версии с теми же именами полей (V1/V2): берём только то, что нужно учёту. */
export function parseInvoice(xml: string): ParsedInvoice {
  const root = parser.parse(xml);
  const inv = root.invoice ?? root[Object.keys(root).find((k) => k !== '?xml') as string];
  if (!inv) throw new Error('Не найден элемент invoice');
  const ps = inv.productSet ?? {};
  const seller = inv.sellers?.seller?.[0] ?? {};
  const customer = inv.customers?.customer?.[0] ?? {};
  return {
    num: String(inv.num ?? ''),
    date: String(inv.date ?? ''),
    turnoverDate: String(inv.turnoverDate ?? inv.date ?? ''),
    invoiceType: String(inv.invoiceType ?? 'ORDINARY_INVOICE'),
    relatedInvoice: inv.relatedInvoice ? { date: String(inv.relatedInvoice.date), num: String(inv.relatedInvoice.num), registrationNumber: inv.relatedInvoice.registrationNumber } : undefined,
    seller: { tin: seller.tin, name: seller.name },
    customer: { tin: customer.tin, name: customer.name },
    currencyCode: String(ps.currencyCode ?? 'KZT'),
    totals: { ndsAmount: String(ps.totalNdsAmount ?? '0'), priceWithTax: String(ps.totalPriceWithTax ?? '0'), priceWithoutTax: String(ps.totalPriceWithoutTax ?? '0') },
    products: (ps.products?.product ?? []).map((p: any) => ({
      description: p.description,
      quantity: p.quantity,
      priceWithoutTax: String(p.priceWithoutTax ?? '0'),
      ndsAmount: String(p.ndsAmount ?? '0'),
      ndsRate: p.ndsRate,
      priceWithTax: String(p.priceWithTax ?? '0'),
      truOriginCode: p.truOriginCode,
      unitNomenclature: p.unitNomenclature,
    })),
  };
}

// ── Подписываемые списки (отзыв, отклонение, подтверждение) ──
// SDK КГД: InvoiceSignatureHelper.toXML → JAXBUtils.toXml(obj, null, fragment=true, formatted=false);
// корень @XmlRootElement(name="signedContent") без пространства имён; IdWithReasonList.idsWithReasons
// (@XmlElementWrapper, элементы idWithReason{id, reason}); IdList.ids (элементы id).
// ИС ЭСФ собирает эту строку сама и проверяет подпись — поэтому строка должна совпадать байт в байт.

/** Экранирование текста как у JAXB RI (MinimumEscapeHandler): только &, <, >. */
const escText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function signableIdWithReasonList(items: { id: string; reason: string }[]): string {
  return '<signedContent><idsWithReasons>' + items.map((i) => `<idWithReason><id>${i.id}</id><reason>${escText(i.reason)}</reason></idWithReason>`).join('') + '</idsWithReasons></signedContent>';
}

export function signableIdList(ids: string[]): string {
  return '<signedContent><ids>' + ids.map((i) => `<id>${i}</id>`).join('') + '</ids></signedContent>';
}
