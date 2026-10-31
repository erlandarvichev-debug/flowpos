import { binCheckDigit, binValid, contractPeriodProblem, day, effectiveOn, validateBik, validateBin, validateIban, validateKbe } from './requisites';

describe('FP-026: реквизиты контрагента', () => {
  it('ИИН/БИН: контрольный разряд (реальные БИН банков проходят, опечатка — нет)', () => {
    expect(binValid('000740001307')).toBe(true);
    expect(binValid('940140000385')).toBe(true);
    expect(binValid('940140000386')).toBe(false);
    expect(binValid('94014000038')).toBe(false);
    expect(validateBin(' 9401-4000 0385 ')).toBe('940140000385');
    expect(() => validateBin('940140000386')).toThrow(/контрольный разряд/);
    expect(() => validateBin('12345')).toThrow(/12 цифр/);
  });

  it('ИИН/БИН: второй проход весов, когда первый даёт 10; если снова 10 — номер недействителен', () => {
    // Перебор: найдутся номера, где первый проход даёт 10 (используется второй набор весов).
    let second = 0;
    let none = 0;
    for (let n = 0; n < 20000 && (second < 1 || none < 1); n++) {
      const s = String(n).padStart(11, '0');
      const d = s.split('').map(Number);
      const first = d.reduce((acc, x, i) => acc + x * (i + 1), 0) % 11;
      if (first !== 10) continue;
      const c = binCheckDigit(s);
      if (c === null) none++;
      else {
        second++;
        expect(binValid(s + c)).toBe(true);
      }
    }
    expect(second).toBeGreaterThan(0);
    expect(none).toBeGreaterThan(0);
  });

  it('IBAN: модуль 97, длина для KZ; БИК; КБе', () => {
    expect(validateIban('kz86 125K ZT50 0410 0100')).toBe('KZ86125KZT5004100100');
    expect(() => validateIban('KZ87125KZT5004100100')).toThrow(/контрольные цифры/);
    expect(() => validateIban('KZ86125KZT50041001')).toThrow(/20 символов/);
    expect(validateIban('GB82WEST12345698765432')).toBe('GB82WEST12345698765432');
    expect(validateBik('hsbk kzkx')).toBe('HSBKKZKX');
    expect(() => validateBik('HSBK')).toThrow(/8 символов/);
    expect(validateKbe('17')).toBe('17');
    expect(() => validateKbe('30')).toThrow(/резидент/);
    expect(() => validateKbe('10')).toThrow(/сектор/);
  });

  it('даты действия: запись на дату, границы включительно; несуществующая дата — ошибка', () => {
    const rows = [
      { id: 'old', validFrom: day('2025-01-01'), validTo: day('2026-03-31') },
      { id: 'new', validFrom: day('2026-04-01'), validTo: null },
    ];
    expect(effectiveOn(rows, day('2026-03-31')).map((r) => r.id)).toEqual(['old']);
    expect(effectiveOn(rows, day('2026-04-01')).map((r) => r.id)).toEqual(['new']);
    expect(effectiveOn(rows, day('2024-12-31'))).toEqual([]);
    expect(() => day('2026-02-30')).toThrow(/Нет такой даты/);
  });

  it('срок договора: начало — startDate или дата договора; без конца — бессрочно', () => {
    const c = { number: '7', date: day('2026-01-10'), startDate: null, endDate: day('2026-12-31') };
    expect(contractPeriodProblem(c, day('2026-01-10'))).toBeNull();
    expect(contractPeriodProblem(c, day('2026-12-31'))).toBeNull();
    expect(contractPeriodProblem(c, day('2026-01-09'))).toMatch(/не действует.*2026-01-10 — 2026-12-31/);
    expect(contractPeriodProblem(c, day('2027-01-01'))).toMatch(/не действует/);
    expect(contractPeriodProblem({ ...c, endDate: null }, day('2030-01-01'))).toBeNull();
    expect(contractPeriodProblem({ number: '1', date: null, startDate: null, endDate: null }, day('2001-01-01'))).toBeNull();
  });
});
