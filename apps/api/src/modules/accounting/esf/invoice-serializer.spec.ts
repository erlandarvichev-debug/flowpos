// FP-015 acceptance: golden XML по XSD; версии формы; totals/rounding; no silent truncation.
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { EsfInvoiceData } from './invoice-xml';
import { EsfSerializationError, FORM_VERSIONS, serializeInvoice, validateInvoiceV2 } from './invoice-serializer';

const FIXTURES = join(__dirname, '../../../../test/fixtures/esf');
const XSD = join(FIXTURES, 'invoice_v2.xsd');
const GOLDEN = join(FIXTURES, 'golden');

// Официальные схемы получены с тестового стенда КГД (см. test/fixtures/esf/README.md).
// Если КГД изменит схему, хэш поменяется — golden-файлы надо перепроверить, а не подгонять.
const XSD_SHA256 = {
  'invoice_v2.xsd': '4e0fdf25d8e1d598430727b4cf7a961dad4c9807e97377057eb4b07d9aad2018',
  'schema2.xsd': '59b9b8b091cff6150f90314af8f0f1542309acfe13f8dd0296f3c68321234789',
};

const hasXmllint = (() => {
  try { execFileSync('xmllint', ['--version'], { stdio: 'pipe' }); return true; } catch { return false; }
})();
const itXsd = hasXmllint ? it : it.skip;

function xsdErrors(xml: string): string | null {
  const dir = mkdtempSync(join(tmpdir(), 'esf-xsd-'));
  try {
    const f = join(dir, 'invoice.xml');
    writeFileSync(f, xml, 'utf8');
    execFileSync('xmllint', ['--noout', '--nonet', '--schema', XSD, f], { stdio: 'pipe' });
    return null;
  } catch (e: any) {
    return String(e.stderr ?? e.message);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ordinary = (): EsfInvoiceData => ({
  date: '06.10.2026',
  invoiceType: 'ORDINARY_INVOICE',
  num: '2026000001',
  operatorFullname: 'Тестов Тест Тестович',
  turnoverDate: '05.10.2026',
  customers: [{ tin: '123456789011', name: 'ТОО «Покупатель» & Ко', countryCode: 'KZ' }],
  deliveryDocNum: 'РН-17',
  deliveryDocDate: '05.10.2026',
  deliveryTerm: { hasContract: true, contractNum: 'Д-7', contractDate: '10.01.2026', paymentForm: 'NON_CASH', transportTypeCode: '30' },
  currencyCode: 'KZT',
  products: [
    { truOriginCode: '5', description: 'Товар <A>', catalogTruId: '1', unitNomenclature: '796', quantity: '3', unitPrice: '2000', priceWithoutTax: '6000.00', turnoverSize: '6000.00', ndsRate: 16, ndsAmount: '960.00', priceWithTax: '6960.00' },
    { truOriginCode: '6', description: 'Доставка', catalogTruId: '1', priceWithoutTax: '1000.00', turnoverSize: '1000.00', ndsRate: 16, ndsAmount: '160.00', priceWithTax: '1160.00' },
  ],
  totals: { exciseAmount: '0.00', ndsAmount: '1120.00', priceWithTax: '8120.00', priceWithoutTax: '7000.00', turnoverSize: '7000.00' },
  sellers: [{ tin: '123456789021', name: 'ТОО «Продавец»', address: 'г. Алматы, ул. Абая, 1', ndsRegistrationDate: '15.01.2020' }],
});

const additional = (): EsfInvoiceData => ({
  ...ordinary(),
  invoiceType: 'ADDITIONAL_INVOICE',
  num: '2026000002',
  date: '20.10.2026',
  turnoverDate: '19.10.2026',
  relatedInvoice: { date: '06.10.2026', num: '2026000001', registrationNumber: 'ESF-990000000000-061026-00000001' },
  products: [{ truOriginCode: '5', description: 'Товар <A>', catalogTruId: '1', unitNomenclature: '796', quantity: '-1', unitPrice: '2000', priceWithoutTax: '-2000.00', turnoverSize: '-2000.00', ndsRate: 16, ndsAmount: '-320.00', priceWithTax: '-2320.00' }],
  totals: { exciseAmount: '0.00', ndsAmount: '-320.00', priceWithTax: '-2320.00', priceWithoutTax: '-2000.00', turnoverSize: '-2000.00' },
});

const errorsOf = (d: EsfInvoiceData) => validateInvoiceV2(d).map((e) => `${e.path}: ${e.message}`);
const expectError = (d: EsfInvoiceData, path: string, re: RegExp) => {
  const errs = validateInvoiceV2(d).filter((e) => e.path === path);
  expect(errs.map((e) => e.message).join(' | ')).toMatch(re);
};

describe('FP-015: golden XML по официальной XSD InvoiceV2', () => {
  it('официальные XSD не изменились (хэш закреплён)', () => {
    for (const [file, sha] of Object.entries(XSD_SHA256)) {
      expect(createHash('sha256').update(readFileSync(join(FIXTURES, file))).digest('hex')).toBe(sha);
    }
  });

  for (const [name, make] of [['invoice-v2-ordinary', ordinary], ['invoice-v2-additional', additional]] as const) {
    it(`${name}: сериализация совпадает с golden байт в байт`, () => {
      const out = serializeInvoice(make());
      const file = join(GOLDEN, `${name}.xml`);
      if (process.env.UPDATE_GOLDEN === '1') writeFileSync(file, out.xml, 'utf8');
      expect(existsSync(file)).toBe(true);
      expect(out.xml).toBe(readFileSync(file, 'utf8'));
      expect(out.version).toBe('InvoiceV2');
      expect(out.sha256).toBe(createHash('sha256').update(out.xml, 'utf8').digest('hex'));
    });

    itXsd(`${name}: golden проходит официальную XSD (xmllint)`, () => {
      expect(xsdErrors(readFileSync(join(GOLDEN, `${name}.xml`), 'utf8'))).toBeNull();
    });
  }

  itXsd('xmllint действительно ловит нарушение схемы (проверка не пустая)', () => {
    const broken = readFileSync(join(GOLDEN, 'invoice-v2-ordinary.xml'), 'utf8').replace('<truOriginCode>5</truOriginCode>', '<truOriginCode>9</truOriginCode>');
    expect(xsdErrors(broken)).toMatch(/truOriginCode/);
  });

  it('спецсимволы экранируются, а не теряются', () => {
    const { xml } = serializeInvoice(ordinary());
    expect(xml).toContain('ТОО «Покупатель» &amp; Ко');
    expect(xml).toContain('Товар &lt;A&gt;');
  });
});

describe('FP-015: версии формы', () => {
  it('поддерживается только InvoiceV2, неизвестная версия — явная ошибка', () => {
    expect(Object.keys(FORM_VERSIONS)).toEqual(['InvoiceV2']);
    for (const v of ['InvoiceV1', 'InvoiceV3', '__proto__', 'toString']) {
      expect(() => serializeInvoice(ordinary(), v)).toThrow(expect.objectContaining({ code: 'ESF_FORM_VERSION_UNSUPPORTED' }));
    }
  });
});

describe('FP-015: итоги и округление (в тиынах, без float)', () => {
  it('golden-данные проходят без ошибок', () => {
    expect(errorsOf(ordinary())).toEqual([]);
    expect(errorsOf(additional())).toEqual([]);
  });

  it('итог не совпадает с суммой строк — ошибка, а не пересчёт', () => {
    const d = ordinary();
    d.totals.priceWithTax = '8120.01';
    expectError(d, 'totals.priceWithTax', /8120\.01 ≠ сумме строк 8120\.00/);
  });

  it('стоимость с НДС ≠ без НДС + НДС', () => {
    const d = ordinary();
    d.products[0].priceWithTax = '6960.01';
    expectError(d, 'products[0].priceWithTax', /≠ без НДС/);
  });

  it('НДС сверяется со ставкой с допуском 1 тиын на округление выделения НДС', () => {
    const ok = ordinary();
    ok.products[1] = { ...ok.products[1], priceWithoutTax: '999.99', turnoverSize: '999.99', ndsAmount: '160.01', priceWithTax: '1160.00' };
    ok.totals = { ...ok.totals, priceWithoutTax: '6999.99', turnoverSize: '6999.99', ndsAmount: '1120.01' };
    expect(errorsOf(ok)).toEqual([]);

    const bad = ordinary();
    bad.products[1] = { ...bad.products[1], ndsAmount: '160.02', priceWithTax: '1160.02' };
    bad.totals = { ...bad.totals, ndsAmount: '1120.02', priceWithTax: '8120.02' };
    expectError(bad, 'products[1].ndsAmount', /не соответствует ставке 16%/);
  });

  it('без ставки НДС сумма НДС должна быть 0; ставка — целое число', () => {
    const d = ordinary();
    d.products[1].ndsRate = undefined;
    expectError(d, 'products[1].ndsAmount', /должна быть 0/);
    const e = ordinary();
    e.products[1].ndsRate = 12.5;
    expectError(e, 'products[1].ndsRate', /целое/);
  });

  it('акциз в итогах при строках без акциза — ошибка', () => {
    const d = ordinary();
    d.totals.exciseAmount = '1.00';
    expectError(d, 'totals.exciseAmount', /должен быть 0/);
  });

  it('третий знак после запятой не округляется молча', () => {
    const d = ordinary();
    d.products[0].priceWithoutTax = '6000.004';
    expectError(d, 'products[0].priceWithoutTax', /3 знаков после запятой.*молча нельзя/);
    const q = ordinary();
    q.products[0].quantity = '3.0000001';
    expectError(q, 'products[0].quantity', /7 знаков.*молча нельзя/);
  });

  it('больше 17 значащих цифр в сумме — ошибка XSD totalDigits', () => {
    const d = ordinary();
    d.totals.priceWithoutTax = '1234567890123456.00';
    expectError(d, 'totals.priceWithoutTax', /17 значащих/);
  });

  it('отрицательные суммы — только в дополнительном ЭСФ; знак количества совпадает со знаком суммы', () => {
    const d = ordinary();
    d.products[1] = { ...d.products[1], priceWithoutTax: '-1000.00', turnoverSize: '-1000.00', ndsAmount: '-160.00', priceWithTax: '-1160.00' };
    expectError(d, 'products[1].priceWithoutTax', /только в дополнительном/);
    const a = additional();
    a.products[0].quantity = '1';
    expectError(a, 'products[0].quantity', /знак количества/);
  });
});

describe('FP-015: ничего не теряется и не обрезается молча', () => {
  it('пустое ФИО оператора — ошибка (раньше элемент молча выпадал и XML ломал XSD)', () => {
    const d = ordinary();
    d.operatorFullname = '';
    expectError(d, 'operatorFullname', /обязательное/);
    expect(() => serializeInvoice(d)).toThrow(EsfSerializationError);
  });

  it('ФИО оператора длиннее 200 символов (XSD maxLength) — ошибка, не обрезка', () => {
    const d = ordinary();
    d.operatorFullname = 'Я'.repeat(201);
    expectError(d, 'operatorFullname', /201 больше 200.*молча нельзя/);
  });

  it('управляющие символы, недопустимые в XML, — ошибка, а не вырезание', () => {
    const d = ordinary();
    d.products[0].description = 'Товар\u0007';
    expectError(d, 'products[0].description', /управляющие/);
  });

  it('форматы по XSD: номер, даты, коды, БИН', () => {
    const d = ordinary();
    d.num = '2026-01';
    d.turnoverDate = '31.02.2026';
    d.products[0].truOriginCode = '7';
    d.products[0].unitCode = '12AB';
    d.sellers[0].tin = '12345';
    const paths = validateInvoiceV2(d).map((e) => e.path);
    expect(paths).toEqual(expect.arrayContaining(['num', 'turnoverDate', 'products[0].truOriginCode', 'products[0].unitCode', 'sellers[0].tin']));
  });

  it('связи видов ЭСФ: дополнительный без ссылки и основной со ссылкой — ошибки', () => {
    const a = additional();
    delete a.relatedInvoice;
    expectError(a, 'relatedInvoice', /должны ссылаться/);
    const o = ordinary();
    o.relatedInvoice = { date: '01.10.2026', num: '1' };
    expectError(o, 'relatedInvoice', /не бывает/);
  });

  it('договор указан, но без номера или даты — ошибка', () => {
    const d = ordinary();
    d.deliveryTerm.contractNum = undefined;
    expectError(d, 'deliveryTerm.contractNum', /обязательное/);
  });

  it('возвращает все ошибки сразу, с путями до полей', () => {
    const d = ordinary();
    d.operatorFullname = '';
    d.totals.ndsAmount = '1.00';
    d.products[0].description = '';
    try {
      serializeInvoice(d);
      fail('должна быть ошибка');
    } catch (e: any) {
      expect(e).toBeInstanceOf(EsfSerializationError);
      expect(e.code).toBe('ESF_DATA_INVALID');
      expect(e.errors.map((x: any) => x.path)).toEqual(expect.arrayContaining(['operatorFullname', 'totals.ndsAmount', 'products[0].description']));
    }
  });
});
