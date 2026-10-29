// FP-015: сериализация исходящего ЭСФ. Перед сборкой XML данные проверяются по ограничениям
// официальной XSD InvoiceV2 (test/fixtures/esf) и по арифметике итогов в тиынах. Ничего не
// округляется и не обрезается молча: любое несоответствие — ошибка с путём до поля.
import { createHash } from 'crypto';
import { EsfInvoiceData, buildInvoiceV2, parseInvoice } from './invoice-xml';

export type EsfFieldError = { path: string; message: string };

export class EsfSerializationError extends Error {
  readonly code: string;
  readonly errors: EsfFieldError[];
  constructor(code: string, errors: EsfFieldError[]) {
    super(`${code}: ${errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
    this.code = code;
    this.errors = errors;
  }
}

export type SerializedInvoice = { version: string; xml: string; sha256: string };

// XML 1.0: запрещённые управляющие символы и одиночные суррогаты.
const XML_ILLEGAL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const DATE = /^(\d{2})\.(\d{2})\.(\d{4})$/;

/** Десятичное число как строка: знак, целая часть, дробная часть. Без float. */
function decimalParts(v: string): { neg: boolean; int: string; frac: string } | null {
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(v);
  return m ? { neg: !!m[1], int: m[2], frac: m[3] ?? '' } : null;
}

function significantDigits(p: { int: string; frac: string }) {
  return p.int.replace(/^0+(?=\d)/, '').replace(/^0$/, '').length + p.frac.length;
}

/** Деньги → тиыны (BigInt). null, если формат не money(2). */
function tiyn(v: string): bigint | null {
  const p = decimalParts(v);
  if (!p || p.frac.length > 2) return null;
  const abs = BigInt(p.int) * 100n + BigInt((p.frac + '00').slice(0, 2));
  return p.neg ? -abs : abs;
}

const signOf = (x: bigint) => (x > 0n ? 1 : x < 0n ? -1 : 0);

/** round half up (от нуля) для a/b, b > 0. */
function divRound(a: bigint, b: bigint): bigint {
  const q = a / b, r = a % b;
  if (r === 0n) return q;
  const twice = (r < 0n ? -r : r) * 2n;
  return twice >= b ? q + (a < 0n ? -1n : 1n) : q;
}

class Checker {
  readonly errors: EsfFieldError[] = [];
  add(path: string, message: string) { this.errors.push({ path, message }); }

  text(path: string, v: string | undefined, opts: { required?: boolean; max?: number; pattern?: RegExp } = {}) {
    if (v === undefined || v === null || v === '') {
      if (opts.required) this.add(path, 'обязательное поле не заполнено');
      return;
    }
    if (typeof v !== 'string') return this.add(path, 'ожидается строка');
    if (XML_ILLEGAL.test(v)) this.add(path, 'недопустимые для XML управляющие символы');
    if (opts.required && !v.trim()) this.add(path, 'обязательное поле состоит из пробелов');
    if (opts.max !== undefined && [...v].length > opts.max) this.add(path, `длина ${[...v].length} больше ${opts.max} — сокращать молча нельзя`);
    if (opts.pattern && !opts.pattern.test(v)) this.add(path, `не соответствует формату ${opts.pattern.source}`);
  }

  date(path: string, v: string | undefined, required = true) {
    if (!v) { if (required) this.add(path, 'обязательная дата не заполнена'); return; }
    const m = DATE.exec(v);
    const d = m && new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
    if (!m || !d || d.getUTCDate() !== +m[1] || d.getUTCMonth() !== +m[2] - 1) this.add(path, 'дата должна быть dd.MM.yyyy и существовать в календаре');
  }

  money(path: string, v: string | undefined, required = true): bigint | null {
    if (v === undefined || v === '') { if (required) this.add(path, 'обязательная сумма не заполнена'); return null; }
    const p = decimalParts(v);
    if (!p) { this.add(path, `«${v}» — не десятичное число`); return null; }
    if (p.frac.length > 2) { this.add(path, `${p.frac.length} знаков после запятой, допускается 2 — округлять молча нельзя`); return null; }
    if (significantDigits(p) > 17) { this.add(path, 'больше 17 значащих цифр'); return null; }
    return tiyn(v);
  }

  decimal6(path: string, v: string | undefined) {
    if (v === undefined || v === '') return;
    const p = decimalParts(v);
    if (!p) return this.add(path, `«${v}» — не десятичное число`);
    if (p.frac.length > 6) this.add(path, `${p.frac.length} знаков после запятой, допускается 6 — округлять молча нельзя`);
    if (significantDigits(p) > 18) this.add(path, 'больше 18 значащих цифр');
  }
}

/** Проверка данных InvoiceV2 до сборки XML. Пустой массив — можно сериализовать. */
export function validateInvoiceV2(d: EsfInvoiceData): EsfFieldError[] {
  const c = new Checker();
  c.date('date', d.date);
  c.date('turnoverDate', d.turnoverDate);
  if (!['ORDINARY_INVOICE', 'FIXED_INVOICE', 'ADDITIONAL_INVOICE'].includes(d.invoiceType)) c.add('invoiceType', `неизвестный вид ЭСФ «${d.invoiceType}»`);
  c.text('num', d.num, { required: true, pattern: /^[0-9]{1,30}$/ });
  c.text('operatorFullname', d.operatorFullname, { required: true, max: 200 });
  c.text('addInf', d.addInf);

  if (d.invoiceType === 'ORDINARY_INVOICE' && d.relatedInvoice) c.add('relatedInvoice', 'у основного ЭСФ не бывает связанного ЭСФ');
  if (d.invoiceType !== 'ORDINARY_INVOICE' && !d.relatedInvoice) c.add('relatedInvoice', 'исправленный и дополнительный ЭСФ должны ссылаться на исходный');
  if (d.relatedInvoice) {
    c.date('relatedInvoice.date', d.relatedInvoice.date);
    c.text('relatedInvoice.num', d.relatedInvoice.num, { required: true, pattern: /^[0-9]{1,30}$/ });
    c.text('relatedInvoice.registrationNumber', d.relatedInvoice.registrationNumber);
  }

  if (d.consignee) {
    c.text('consignee.countryCode', d.consignee.countryCode, { required: true, pattern: /^[A-Z]{2}$/ });
    c.text('consignee.name', d.consignee.name);
    c.text('consignee.address', d.consignee.address);
    c.text('consignee.tin', d.consignee.tin, { pattern: /^[0-9]{12}$/ });
  }

  if (!d.customers?.length) c.add('customers', 'нужен хотя бы один получатель');
  (d.customers ?? []).forEach((p, i) => {
    const at = `customers[${i}]`;
    c.text(`${at}.name`, p.name, { required: true });
    c.text(`${at}.address`, p.address);
    c.text(`${at}.countryCode`, p.countryCode ?? 'KZ', { required: true, pattern: /^[A-Z]{2}$/ });
    c.text(`${at}.tin`, p.tin, { pattern: (p.countryCode ?? 'KZ') === 'KZ' ? /^[0-9]{12}$/ : /^[0-9A-Za-z]{1,50}$/ });
    c.text(`${at}.branchTin`, p.branchTin, { pattern: /^[0-9]{8,20}$/ });
    c.text(`${at}.trailer`, p.trailer);
  });

  if (!d.sellers?.length) c.add('sellers', 'нужен хотя бы один поставщик');
  (d.sellers ?? []).forEach((s, i) => {
    const at = `sellers[${i}]`;
    c.text(`${at}.name`, s.name, { required: true });
    c.text(`${at}.tin`, s.tin, { required: true, pattern: /^[0-9]{12}$/ });
    c.text(`${at}.branchTin`, s.branchTin, { pattern: /^[0-9]{8,20}$/ });
    c.text(`${at}.address`, s.address);
    c.text(`${at}.bank`, s.bank);
    c.text(`${at}.bik`, s.bik);
    c.text(`${at}.iik`, s.iik);
    c.text(`${at}.kbe`, s.kbe);
    c.text(`${at}.countryCode`, s.countryCode, { pattern: /^[A-Z]{2}$/ });
    c.date(`${at}.ndsRegistrationDate`, s.ndsRegistrationDate, false);
  });

  c.date('deliveryDocDate', d.deliveryDocDate, false);
  c.text('deliveryDocNum', d.deliveryDocNum);
  if (!!d.deliveryDocNum !== !!d.deliveryDocDate) c.add('deliveryDocNum', 'номер и дата документа поставки указываются вместе');
  const t = d.deliveryTerm;
  if (!t) c.add('deliveryTerm', 'условия поставки обязательны');
  else {
    if (!['CASH', 'NON_CASH'].includes(t.paymentForm)) c.add('deliveryTerm.paymentForm', `неизвестная форма оплаты «${t.paymentForm}»`);
    if (t.hasContract) {
      c.text('deliveryTerm.contractNum', t.contractNum, { required: true });
      c.date('deliveryTerm.contractDate', t.contractDate);
    }
    c.text('deliveryTerm.transportTypeCode', t.transportTypeCode);
  }

  c.text('currencyCode', d.currencyCode, { required: true, pattern: /^[A-Z]{3}$/ });
  c.decimal6('currencyRate', d.currencyRate);
  if (d.currencyCode && d.currencyCode !== 'KZT' && !d.currencyRate) c.add('currencyRate', 'для валюты, отличной от KZT, нужен курс');

  const allowNegative = d.invoiceType === 'ADDITIONAL_INVOICE';
  const sum = { ndsAmount: 0n, priceWithTax: 0n, priceWithoutTax: 0n, turnoverSize: 0n };
  let sumsValid = true;
  if (!d.products?.length) c.add('products', 'нужна хотя бы одна строка');
  (d.products ?? []).forEach((p, i) => {
    const at = `products[${i}]`;
    c.text(`${at}.truOriginCode`, p.truOriginCode, { required: true, pattern: /^[1-6]$/ });
    c.text(`${at}.description`, p.description, { required: true });
    c.text(`${at}.catalogTruId`, p.catalogTruId, { required: true });
    c.text(`${at}.unitCode`, p.unitCode, { pattern: /^[0-9]{1,10}$/ });
    c.text(`${at}.unitNomenclature`, p.unitNomenclature);
    c.text(`${at}.gtinCode`, p.gtinCode);
    c.text(`${at}.additional`, p.additional);
    c.decimal6(`${at}.quantity`, p.quantity);
    c.decimal6(`${at}.unitPrice`, p.unitPrice);
    if (p.unitPrice && p.unitPrice.startsWith('-')) c.add(`${at}.unitPrice`, 'цена за единицу не бывает отрицательной');

    const net = c.money(`${at}.priceWithoutTax`, p.priceWithoutTax);
    const turnover = c.money(`${at}.turnoverSize`, p.turnoverSize);
    const nds = c.money(`${at}.ndsAmount`, p.ndsAmount);
    const gross = c.money(`${at}.priceWithTax`, p.priceWithTax);
    if (net === null || turnover === null || nds === null || gross === null) { sumsValid = false; return; }

    if (!allowNegative) {
      for (const [k, v] of [['priceWithoutTax', net], ['ndsAmount', nds], ['priceWithTax', gross], ['turnoverSize', turnover]] as const) {
        if (v < 0n) c.add(`${at}.${k}`, 'отрицательные суммы допустимы только в дополнительном ЭСФ');
      }
    }
    if (net + nds !== gross) c.add(`${at}.priceWithTax`, `стоимость с НДС ${p.priceWithTax} ≠ без НДС ${p.priceWithoutTax} + НДС ${p.ndsAmount}`);
    if (p.ndsRate === undefined) {
      if (nds !== 0n) c.add(`${at}.ndsAmount`, 'без ставки НДС сумма НДС должна быть 0');
    } else if (!Number.isInteger(p.ndsRate) || p.ndsRate < 0 || p.ndsRate > 100) {
      c.add(`${at}.ndsRate`, 'ставка НДС — целое число 0..100 (xs:int)');
    } else {
      const expected = divRound(net * BigInt(p.ndsRate), 100n);
      const diff = nds - expected;
      if (diff > 1n || diff < -1n) c.add(`${at}.ndsAmount`, `НДС ${p.ndsAmount} не соответствует ставке ${p.ndsRate}% от ${p.priceWithoutTax} (ожидается ≈ ${fmt(expected)})`);
    }
    if (p.quantity) {
      const qs = p.quantity.startsWith('-') ? -1 : /^-?0*(\.0*)?$/.test(p.quantity) ? 0 : 1;
      if (qs !== 0 && signOf(net) !== 0 && qs !== signOf(net)) c.add(`${at}.quantity`, 'знак количества не совпадает со знаком суммы');
    }
    sum.ndsAmount += nds; sum.priceWithTax += gross; sum.priceWithoutTax += net; sum.turnoverSize += turnover;
  });

  const tot = d.totals ?? ({} as EsfInvoiceData['totals']);
  const totals = {
    exciseAmount: c.money('totals.exciseAmount', tot.exciseAmount),
    ndsAmount: c.money('totals.ndsAmount', tot.ndsAmount),
    priceWithTax: c.money('totals.priceWithTax', tot.priceWithTax),
    priceWithoutTax: c.money('totals.priceWithoutTax', tot.priceWithoutTax),
    turnoverSize: c.money('totals.turnoverSize', tot.turnoverSize),
  };
  if (totals.exciseAmount !== null && totals.exciseAmount !== 0n) c.add('totals.exciseAmount', 'в строках нет акциза — итог акциза должен быть 0');
  if (sumsValid) {
    for (const k of ['ndsAmount', 'priceWithTax', 'priceWithoutTax', 'turnoverSize'] as const) {
      const v = totals[k];
      if (v !== null && v !== sum[k]) c.add(`totals.${k}`, `итог ${fmt(v)} ≠ сумме строк ${fmt(sum[k])}`);
    }
  }
  return c.errors;
}

function fmt(t: bigint): string {
  const neg = t < 0n, a = neg ? -t : t;
  return `${neg ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`;
}

type FormVersion = { validate: (d: EsfInvoiceData) => EsfFieldError[]; build: (d: EsfInvoiceData) => string };

/** Поддерживаемые версии формы. Новая версия добавляется сюда вместе со своей XSD и golden-тестом. */
export const FORM_VERSIONS: Readonly<Record<string, FormVersion>> = Object.freeze({
  InvoiceV2: { validate: validateInvoiceV2, build: buildInvoiceV2 },
});

export function serializeInvoice(data: EsfInvoiceData, version = 'InvoiceV2'): SerializedInvoice {
  const form = Object.prototype.hasOwnProperty.call(FORM_VERSIONS, version) ? FORM_VERSIONS[version] : undefined;
  if (!form) throw new EsfSerializationError('ESF_FORM_VERSION_UNSUPPORTED', [{ path: 'version', message: `версия формы «${version}» не поддерживается; есть: ${Object.keys(FORM_VERSIONS).join(', ')}` }]);
  const errors = form.validate(data);
  if (errors.length) throw new EsfSerializationError('ESF_DATA_INVALID', errors);
  const xml = form.build(data);

  // Обратная сверка: то, что ушло в XML, совпадает с тем, что проверили.
  const back = parseInvoice(xml);
  const lost: EsfFieldError[] = [];
  if (back.products.length !== data.products.length) lost.push({ path: 'products', message: `в XML ${back.products.length} строк вместо ${data.products.length}` });
  data.products.forEach((p, i) => {
    const b = back.products[i];
    if (b && (b.priceWithTax !== p.priceWithTax || b.ndsAmount !== p.ndsAmount || b.priceWithoutTax !== p.priceWithoutTax || b.description !== p.description.trim())) lost.push({ path: `products[${i}]`, message: 'значения в XML отличаются от исходных' });
  });
  const t = data.totals;
  if (back.totals.ndsAmount !== t.ndsAmount || back.totals.priceWithTax !== t.priceWithTax || back.totals.priceWithoutTax !== t.priceWithoutTax) lost.push({ path: 'totals', message: 'итоги в XML отличаются от исходных' });
  if (lost.length) throw new EsfSerializationError('ESF_SERIALIZATION_MISMATCH', lost);

  return { version, xml, sha256: createHash('sha256').update(xml, 'utf8').digest('hex') };
}
