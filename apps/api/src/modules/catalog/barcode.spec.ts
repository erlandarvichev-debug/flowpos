import { detectKind, gs1CheckDigit, gs1Valid, normalizeBarcode, parseWeightBarcode, validateBarcode, validatePlu, validateWeightSettings } from './barcode';

const ean = (data12: string) => data12 + gs1CheckDigit(data12);

describe('FP-025: штрихкоды', () => {
  it('контрольная цифра GS1 по известным кодам', () => {
    expect(gs1Valid('4006381333931')).toBe(true); // EAN-13
    expect(gs1Valid('96385074')).toBe(true); // EAN-8
    expect(gs1Valid('036000291452')).toBe(true); // UPC-A
    expect(gs1Valid('10614141000415')).toBe(true); // GTIN-14
    expect(gs1Valid('4006381333932')).toBe(false);
  });

  it('тип по содержимому: верный GS1 нужной длины — GS1, иначе Code 128', () => {
    expect(detectKind('4006381333931')).toBe('EAN13');
    expect(detectKind('96385074')).toBe('EAN8');
    expect(detectKind('036000291452')).toBe('UPCA');
    expect(detectKind('10614141000415')).toBe('GTIN14');
    expect(detectKind('4006381333932')).toBe('CODE128'); // неверная контрольная
    expect(detectKind('1234567890')).toBe('CODE128'); // 10 цифр — не GS1
    expect(detectKind('ABC-1')).toBe('CODE128');
  });

  it('ручной ввод: пробелы убираются; явный EAN проверяется строго; кириллица и пустое — ошибка', () => {
    expect(validateBarcode(' 4006 3813 33931\n')).toEqual({ barcode: '4006381333931', kind: 'EAN13' });
    expect(normalizeBarcode('  ')).toBe('');
    expect(() => validateBarcode('4006381333932', 'EAN13')).toThrow(/контрольная цифра.*1/);
    expect(() => validateBarcode('400638133393', 'EAN13')).toThrow(/ровно 13 цифр/);
    expect(() => validateBarcode('АБВ123')).toThrow(/латиницу/);
    expect(() => validateBarcode('')).toThrow(/пустой/);
    expect(() => validateBarcode('x', 'QR')).toThrow(/Тип штрихкода/);
    expect(() => validateBarcode('9'.repeat(65))).toThrow(/64/);
    // Внутренний код с опечаткой «под EAN» допускается только явным CODE128.
    expect(validateBarcode('4006381333932', 'CODE128')).toEqual({ barcode: '4006381333932', kind: 'CODE128' });
  });

  it('весовой штрихкод: префикс + PLU + граммы + контрольная', () => {
    const s = { prefixes: ['22'], pluLength: 5 };
    const code = ean('22' + '00123' + '01234');
    expect(parseWeightBarcode(code, s)).toEqual({ plu: '00123', grams: 1234, kg: '1.234' });
    expect(parseWeightBarcode(ean('22' + '0012' + '012345'), { prefixes: ['22'], pluLength: 4 })).toEqual({ plu: '0012', grams: 12345, kg: '12.345' });
    expect(parseWeightBarcode(code, { prefixes: [], pluLength: 5 })).toBeNull(); // весовые выключены
    expect(parseWeightBarcode(code, { prefixes: ['21'], pluLength: 5 })).toBeNull(); // чужой префикс
    expect(parseWeightBarcode(code.slice(0, 12) + ((Number(code[12]) + 1) % 10), s)).toBeNull(); // опечатка сканера
    expect(parseWeightBarcode(ean('22' + '00123' + '00000'), s)).toBeNull(); // нулевой вес
  });

  it('настройки весовых: только префиксы 20–29, PLU 4–6 цифр; PLU товара — ровно заданной длины', () => {
    expect(validateWeightSettings({ prefixes: ['22', '22', ' 23 '], pluLength: 5 })).toEqual({ prefixes: ['22', '23'], pluLength: 5 });
    expect(() => validateWeightSettings({ prefixes: ['46'] })).toThrow(/20–29/);
    expect(() => validateWeightSettings({ prefixes: ['22'], pluLength: 7 })).toThrow(/от 4 до 6/);
    expect(validatePlu(' 00123 ', 5)).toBe('00123');
    expect(() => validatePlu('123', 5)).toThrow(/ровно 5 цифр/);
  });
});
