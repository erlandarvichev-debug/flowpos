import { INBOUND_ERRORS, checkInbound, validEsfDate } from './esf-inbound';
import { inboundXml } from '../../../../test/esf-inbound-xml';


const code = (body: string | null, version?: string) => {
  const r = checkInbound(body, version);
  return r.ok ? 'OK' : r.code;
};

describe('FP-024: проверка входящего ЭСФ и таксономия ошибок', () => {
  it('корректный документ проходит, даты — календарные', () => {
    const r = checkInbound(inboundXml(), 'InvoiceV2');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.date.toISOString()).toBe('2026-10-02T00:00:00.000Z');
      expect(r.turnoverDate.toISOString()).toBe('2026-10-01T00:00:00.000Z');
      expect(r.parsed.seller.tin).toBe('987654321098');
    }
  });

  it('пустое тело и битый XML — разные причины; битый, но «съедаемый» парсером XML не проходит', () => {
    expect(code('')).toBe('ESF_IN_EMPTY_BODY');
    expect(code(null)).toBe('ESF_IN_EMPTY_BODY');
    expect(code('<broken')).toBe('ESF_IN_XML_MALFORMED');
    // fast-xml-parser разбирает это без ошибки — раньше в реестр попадала пустышка с сегодняшней датой.
    expect(code('<a><b></a>')).toBe('ESF_IN_XML_MALFORMED');
    expect(code(inboundXml().replace('</num>', ''))).toBe('ESF_IN_XML_MALFORMED');
  });

  it('другой документ или версия — неизвестный формат, а не «как-нибудь разобрать»', () => {
    expect(code(inboundXml({ root: 'v2:waybill' }))).toBe('ESF_IN_SCHEMA_UNKNOWN');
    expect(code('<?xml version="1.0"?><!-- комментарий --><other/>')).toBe('ESF_IN_SCHEMA_UNKNOWN');
    expect(code(inboundXml(), 'InvoiceV1')).toBe('ESF_IN_SCHEMA_UNKNOWN');
    expect(code(inboundXml(), undefined)).toBe('OK'); // версия в конверте может не прийти
  });

  it('вид ЭСФ: не указан — ошибка реквизита (без подстановки ORDINARY), неизвестный — отдельная причина', () => {
    expect(code(inboundXml({ type: null }))).toBe('ESF_IN_FIELD_INVALID');
    expect(code(inboundXml({ type: 'SUPER_INVOICE' }))).toBe('ESF_IN_TYPE_UNSUPPORTED');
  });

  it('обязательные реквизиты: номер, даты (31.02 — ошибка), ИИН/БИН продавца, суммы, ссылка исправленного', () => {
    const detail = (o: Parameters<typeof inboundXml>[0]) => {
      const r = checkInbound(inboundXml(o));
      return r.ok ? 'OK' : `${r.code} ${r.detail}`;
    };
    expect(detail({ num: '' })).toMatch(/^ESF_IN_FIELD_INVALID num/);
    expect(detail({ date: '31.02.2026' })).toMatch(/^ESF_IN_FIELD_INVALID date/);
    expect(detail({ date: '2026-10-02' })).toMatch(/date/);
    expect(detail({ turnoverDate: '1.10.2026' })).toMatch(/turnoverDate/);
    expect(detail({ tin: '98765' })).toMatch(/seller\.tin/);
    expect(detail({ total: '11 600,00' })).toMatch(/totalPriceWithTax|priceWithTax/);
    expect(detail({ type: 'FIXED_INVOICE' })).toMatch(/relatedInvoice/);
    expect(detail({ type: 'ADDITIONAL_INVOICE', related: '<relatedInvoice><date>01.10.2026</date><num>5</num></relatedInvoice>' })).toBe('OK');
    // несколько проблем — все сразу, а не по одной за попытку
    expect(detail({ num: '', tin: '1' })).toMatch(/num.*seller\.tin/);
  });

  it('validEsfDate: только дд.мм.гггг с существующей датой', () => {
    expect(validEsfDate('29.02.2024')?.toISOString()).toBe('2024-02-29T00:00:00.000Z');
    expect(validEsfDate('29.02.2026')).toBeNull();
    expect(validEsfDate('00.10.2026')).toBeNull();
    expect(validEsfDate(undefined)).toBeNull();
  });

  it('каждая причина таксономии описана: заголовок, действие, поможет ли повтор; конфликт содержимого — не повтором', () => {
    for (const [k, v] of Object.entries(INBOUND_ERRORS)) {
      expect(k).toMatch(/^ESF_IN_[A-Z_]+$/);
      expect(v.title.length).toBeGreaterThan(10);
      expect(v.action.length).toBeGreaterThan(10);
    }
    expect(INBOUND_ERRORS.ESF_IN_HASH_CONFLICT.replayable).toBe(false);
    expect(INBOUND_ERRORS.ESF_IN_EMPTY_BODY.replayable).toBe(false);
    expect(INBOUND_ERRORS.ESF_IN_FIELD_INVALID.replayable).toBe(true);
  });
});
