// FP-024: проверка входящего ЭСФ до записи в реестр и классификация ошибок (чистые функции — без БД).
// Всё, что не прошло проверку, уходит в карантин целиком (исходное тело, хэш, причина) — поля не обрезаются и
// не подставляются по умолчанию. Временные сбои (сеть, БД) сюда не попадают: синхронизация падает, курсор не
// сдвигается, и следующий проход повторит получение.
import { XMLValidator } from 'fast-xml-parser';
import { INVOICE_VERSION, ParsedInvoice, parseEsfDate, parseInvoice } from './invoice-xml';

export type InboundErrorCode =
  | 'ESF_IN_EMPTY_BODY'
  | 'ESF_IN_XML_MALFORMED'
  | 'ESF_IN_SCHEMA_UNKNOWN'
  | 'ESF_IN_TYPE_UNSUPPORTED'
  | 'ESF_IN_FIELD_INVALID'
  | 'ESF_IN_HASH_CONFLICT'
  | 'ESF_IN_KEY_CONFLICT'
  | 'ESF_IN_LEGACY';

/** Таксономия: что случилось, поможет ли повторная обработка, что делать. Тексты — для бухгалтера и поддержки. */
export const INBOUND_ERRORS: Record<InboundErrorCode, { title: string; replayable: boolean; action: string }> = {
  ESF_IN_EMPTY_BODY: { title: 'ИС ЭСФ отдала пустой документ', replayable: false, action: 'Найдите ЭСФ в портале ИС ЭСФ по регистрационному номеру; если он там есть — сообщите в поддержку FlowPOS.' },
  ESF_IN_XML_MALFORMED: { title: 'Документ повреждён: это не корректный XML', replayable: true, action: 'Передайте в поддержку FlowPOS. После исправления разбора — «Обработать повторно».' },
  ESF_IN_SCHEMA_UNKNOWN: { title: 'Неизвестный формат документа (не ЭСФ InvoiceV2)', replayable: true, action: 'FlowPOS пока не понимает этот формат. Работайте с документом в портале ИС ЭСФ; поддержка добавит формат и повторит обработку.' },
  ESF_IN_TYPE_UNSUPPORTED: { title: 'Неизвестный вид ЭСФ', replayable: true, action: 'Работайте с документом в портале ИС ЭСФ; поддержка добавит вид и повторит обработку.' },
  ESF_IN_FIELD_INVALID: { title: 'В документе нет обязательных реквизитов или они в неверном формате', replayable: true, action: 'Проверьте документ в портале ИС ЭСФ. Если ошибка у поставщика — попросите исправленный ЭСФ; если у FlowPOS — поддержка исправит разбор.' },
  ESF_IN_HASH_CONFLICT: { title: 'ИС ЭСФ отдала другое содержимое уже полученного ЭСФ', replayable: false, action: 'Сравните обе версии. «Принять новую версию» — только если новая версия подтверждена порталом ИС ЭСФ; иначе «Оставить полученную ранее».' },
  ESF_IN_KEY_CONFLICT: { title: 'У этого поставщика уже есть ЭСФ с тем же номером и датой', replayable: true, action: 'Сверьте оба документа в портале ИС ЭСФ. Дубль поставщика — закрыть с причиной; после исправления данных — «Обработать повторно».' },
  ESF_IN_LEGACY: { title: 'Не разобран до появления карантина (перенесено из журнала)', replayable: true, action: '«Обработать повторно» — документ будет проверен заново и получит точную причину.' },
};

export type InboundCheck =
  | { ok: true; parsed: ParsedInvoice; date: Date; turnoverDate: Date }
  | { ok: false; code: InboundErrorCode; detail: string };

const KNOWN_TYPES = ['ORDINARY_INVOICE', 'FIXED_INVOICE', 'ADDITIONAL_INVOICE'];
const DECIMAL = /^-?\d{1,16}(\.\d{1,6})?$/;

/** dd.MM.yyyy с реальной календарной датой (31.02 — ошибка, а не 3 марта). */
export function validEsfDate(s: string | undefined): Date | null {
  if (!s || !/^\d{2}\.\d{2}\.\d{4}$/.test(s)) return null;
  const d = parseEsfDate(s);
  if (isNaN(d.getTime())) return null;
  const [dd, mm, yyyy] = s.split('.').map(Number);
  return d.getUTCDate() === dd && d.getUTCMonth() + 1 === mm && d.getUTCFullYear() === yyyy ? d : null;
}

/** Корень XML без префикса пространства имён (или null, если корня нет). */
function rootName(xml: string): string | null {
  const m = xml.replace(/^﻿/, '').replace(/<\?xml[^>]*\?>/, '').replace(/<!--[\s\S]*?-->/g, '').match(/<\s*([\w.-]+:)?([\w.-]+)/);
  return m ? m[2] : null;
}

/** Проверка входящего ЭСФ. `version` — версия из конверта ИС ЭСФ (invoiceInfo.version), если пришла. */
export function checkInbound(body: string | null | undefined, version?: string | null): InboundCheck {
  const xml = String(body ?? '');
  if (!xml.trim()) return { ok: false, code: 'ESF_IN_EMPTY_BODY', detail: 'тело документа пустое' };
  const valid = XMLValidator.validate(xml);
  if (valid !== true) return { ok: false, code: 'ESF_IN_XML_MALFORMED', detail: `${valid.err.code}: ${valid.err.msg} (строка ${valid.err.line}, позиция ${valid.err.col ?? '?'})` };
  const root = rootName(xml);
  if (root !== 'invoice') return { ok: false, code: 'ESF_IN_SCHEMA_UNKNOWN', detail: `корневой элемент «${root ?? '—'}» вместо «invoice»` };
  if (version && version !== INVOICE_VERSION) return { ok: false, code: 'ESF_IN_SCHEMA_UNKNOWN', detail: `версия документа ${version}, поддерживается ${INVOICE_VERSION}` };

  let p: ParsedInvoice;
  try {
    p = parseInvoice(xml);
  } catch (e: any) {
    return { ok: false, code: 'ESF_IN_SCHEMA_UNKNOWN', detail: `разбор: ${String(e?.message ?? e).slice(0, 200)}` };
  }
  const rawType = /<\s*(?:[\w.-]+:)?invoiceType\s*>\s*([^<]*)</.exec(xml)?.[1]?.trim();
  if (!rawType) return { ok: false, code: 'ESF_IN_FIELD_INVALID', detail: 'invoiceType: не указан' };
  if (!KNOWN_TYPES.includes(rawType)) return { ok: false, code: 'ESF_IN_TYPE_UNSUPPORTED', detail: `invoiceType «${rawType.slice(0, 60)}»` };

  const problems: string[] = [];
  if (!p.num || p.num === 'undefined') problems.push('num: не указан');
  const date = validEsfDate(p.date);
  if (!date) problems.push(`date: «${p.date.slice(0, 20)}» — нужна дата дд.мм.гггг`);
  const turnoverDate = validEsfDate(p.turnoverDate);
  if (!turnoverDate) problems.push(`turnoverDate: «${p.turnoverDate.slice(0, 20)}» — нужна дата дд.мм.гггг`);
  if (!p.seller.tin || !/^\d{12}$/.test(String(p.seller.tin))) problems.push(`seller.tin: «${String(p.seller.tin ?? '').slice(0, 20)}» — нужен ИИН/БИН из 12 цифр`);
  if (!/^[A-Z]{3}$/.test(p.currencyCode)) problems.push(`currencyCode: «${p.currencyCode.slice(0, 10)}»`);
  for (const [k, v] of Object.entries(p.totals)) if (!DECIMAL.test(v)) problems.push(`productSet.${k}: «${v.slice(0, 30)}» — не число`);
  if (rawType !== 'ORDINARY_INVOICE') {
    const r = p.relatedInvoice;
    if (!r || !r.num || r.num === 'undefined' || !validEsfDate(r.date)) problems.push('relatedInvoice: для исправленного/дополнительного ЭСФ нужны номер и дата исходного');
  }
  if (problems.length) return { ok: false, code: 'ESF_IN_FIELD_INVALID', detail: problems.join('; ') };
  return { ok: true, parsed: p, date: date!, turnoverDate: turnoverDate! };
}
