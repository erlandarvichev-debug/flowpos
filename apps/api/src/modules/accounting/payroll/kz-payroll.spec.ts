// Эталон расчёта зарплаты 2026 — суммы посчитаны ВРУЧНУЮ (МРП 4 325, МЗП 85 000), не кодом; не подгонять под код.
import { Prisma } from '@prisma/client';
import { KZ_PAYROLL_2026, calcMonth, PersonFlags } from './kz-payroll';

const D = Prisma.Decimal;
const zero = { taxable: new D(0), ipn: new D(0), basicDeduction: new D(0) };
const person = (o: Partial<PersonFlags> = {}): PersonFlags => ({ birthDate: new Date('1990-05-01'), pensionAge: false, disabilityGroup: null, disabilityIndefinite: false, opvByApplication: false, fullTimeStudent: false, socialParticipant: true, ...o });
const pick = (r: any) => Object.fromEntries(['opv', 'vosms', 'basicDeduction', 'taxable', 'ipn', 'opvr', 'so', 'oosms', 'sn', 'net', 'employerCost'].map((k) => [k, r[k].toFixed(2)]));

describe('расчёт зарплаты 2026 — эталон', () => {
  it('A: оклад 500 000, базовый вычет, первый месяц', () => {
    // ОПВ 10% = 50 000; ВОСМС 2% = 10 000; вычет 30 МРП = 129 750; облагаемый 500 000 − 60 000 − 129 750 = 310 250;
    // ИПН 10% = 31 025; ОПВР 3,5% = 17 500; СО 5% × (500 000 − 50 000) = 22 500; ООСМС 3% = 15 000;
    // СН 6% × (500 000 − 50 000 − 10 000) = 26 400; на руки 408 975; затраты 500 000 + 22 500 + 15 000 + 17 500 + 26 400 = 581 400.
    expect(pick(calcMonth(KZ_PAYROLL_2026, person(), { gross: 500000, applyBasicDeduction: true, hireOrFireMonth: false, ytd: zero }))).toEqual({
      opv: '50000.00', vosms: '10000.00', basicDeduction: '129750.00', taxable: '310250.00', ipn: '31025.00',
      opvr: '17500.00', so: '22500.00', oosms: '15000.00', sn: '26400.00', net: '408975.00', employerCost: '581400.00',
    });
  });

  it('B: 60 000, родился до 1975 — ИПН 0 (вычет), ОПВР нет, СО от 1 МЗП, СН от 14 МРП', () => {
    // ОПВ 6 000; ВОСМС 1 200; после соцплатежей 52 800 → вычет 52 800, ИПН 0; ОПВР — освобождён (до 01.01.1975);
    // СО: 54 000 < 85 000 → 85 000 × 5% = 4 250; ООСМС 1 800; СН: 60 000 ≤ 14 МРП (60 550) → 60 550 × 6% = 3 633.
    expect(pick(calcMonth(KZ_PAYROLL_2026, person({ birthDate: new Date('1970-03-10') }), { gross: 60000, applyBasicDeduction: true, hireOrFireMonth: false, ytd: zero }))).toEqual({
      opv: '6000.00', vosms: '1200.00', basicDeduction: '52800.00', taxable: '0.00', ipn: '0.00',
      opvr: '0.00', so: '4250.00', oosms: '1800.00', sn: '3633.00', net: '52800.00', employerCost: '69683.00',
    });
  });

  it('C: 2 000 000 сверх годового порога 8 500 МРП — 15% с превышения, пределы ВОСМС и СО', () => {
    // ОПВ 200 000; ВОСМС: 20 МЗП = 1 700 000 × 2% = 34 000; без вычета облагаемый 1 766 000; с начала года 36 000 000 →
    // всего 37 766 000; порог 36 762 500: 3 676 250 + 1 003 500 × 15% (150 525) = 3 826 775 − ранее 3 600 000 = 226 775;
    // СО: 1 800 000 > 7 МЗП (595 000) → 29 750; ООСМС 60 000; ОПВР 70 000; СН 6% × 1 766 000 = 105 960; на руки 1 539 225.
    const r = calcMonth(KZ_PAYROLL_2026, person(), { gross: 2000000, applyBasicDeduction: false, hireOrFireMonth: false, ytd: { taxable: new D(36000000), ipn: new D(3600000), basicDeduction: new D(0) } });
    expect(pick(r)).toEqual({
      opv: '200000.00', vosms: '34000.00', basicDeduction: '0.00', taxable: '1766000.00', ipn: '226775.00',
      opvr: '70000.00', so: '29750.00', oosms: '60000.00', sn: '105960.00', net: '1539225.00', employerCost: '2265710.00',
    });
  });

  it('D: пенсионер 300 000 — только ИПН и СН', () => {
    // ОПВ, ВОСМС, ОПВР, СО, ООСМС — нет; вычет 129 750 → облагаемый 170 250, ИПН 17 025; СН 6% × 300 000 = 18 000.
    expect(pick(calcMonth(KZ_PAYROLL_2026, person({ pensionAge: true, birthDate: new Date('1960-01-01') }), { gross: 300000, applyBasicDeduction: true, hireOrFireMonth: false, ytd: zero }))).toEqual({
      opv: '0.00', vosms: '0.00', basicDeduction: '129750.00', taxable: '170250.00', ipn: '17025.00',
      opvr: '0.00', so: '0.00', oosms: '0.00', sn: '18000.00', net: '282975.00', employerCost: '318000.00',
    });
  });

  it('E: месяц найма, 30 000 — минимум СН 14 МРП не применяется; годовой лимит вычета исчерпан', () => {
    // ОПВ 3 000; ВОСМС 600; вычет: годовой лимит 360 МРП (1 557 000) уже использован → 0; облагаемый 26 400, ИПН 2 640;
    // СН: месяц найма → 6% × 26 400 = 1 584; СО: 27 000 < 1 МЗП → 4 250; ОПВР: 30 000 < 1 МЗП → 85 000 × 3,5% = 2 975; ООСМС 900.
    const r = calcMonth(KZ_PAYROLL_2026, person(), { gross: 30000, applyBasicDeduction: true, hireOrFireMonth: true, ytd: { taxable: new D(0), ipn: new D(0), basicDeduction: new D(1557000) } });
    expect(pick(r)).toEqual({
      opv: '3000.00', vosms: '600.00', basicDeduction: '0.00', taxable: '26400.00', ipn: '2640.00',
      opvr: '2975.00', so: '4250.00', oosms: '900.00', sn: '1584.00', net: '23760.00', employerCost: '39709.00',
    });
  });
});
