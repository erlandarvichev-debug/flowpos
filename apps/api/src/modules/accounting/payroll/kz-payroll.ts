// Расчёт зарплатных налогов и платежей РК (работник — налоговый агент), версия 2026.
// Источники (тексты кодексов прочитаны 23.10.2026 на zakon.uchet.kz):
//  • Налоговый кодекс РК № 214-VIII (с 01.01.2026): ст. 363 (ставки ИПН 10/15%, порог 8 500 МРП на 1 января),
//    ст. 401–403 (порядок вычетов; базовый вычет 30 МРП/мес, не более 360 МРП/год), ст. 437 (вычет у одного агента
//    по заявлению), ст. 439 (облагаемый доход), ст. 441 (ИПН нарастающим итогом с 1 января),
//    ст. 556–558 (СН 6% с дохода минус ОПВ и ВОСМС; объект от 1 ₸ до 14 МРП — 14 МРП, кроме месяца найма/увольнения;
//    СН НЕ уменьшается на СО).
//  • Социальный кодекс РК № 224-VII: ст. 243 (лица пенсионного возраста не подлежат ОСС), ст. 244–245 (СО 5% с
//    дохода минус ОПВ, от 1 до 7 МЗП), ст. 248 п. 3 (освобождение от ОПВ), п. 6 (освобождение от ОПВР, в т. ч.
//    родившиеся до 01.01.1975), ст. 249 (ОПВ 10%, не более 50 МЗП), ст. 251 (ОПВР 3,5% с 2026, от 1 до 50 МЗП).
//  • Закон РК об ОСМС № 405-V: ст. 26 п. 1 (категории, за которых платит государство), ст. 27 (ООСМС 3%, не более
//    40 МЗП), ст. 28 (ВОСМС 2%, не более 20 МЗП; освобождение лиц ст. 26 п. 1).
//  • МРП 4 325, МЗП 85 000 — закон о республиканском бюджете на 2026–2028 (вторичные источники сходятся).
import { Prisma } from '@prisma/client';
import { D } from '../common/money';

type Dec = Prisma.Decimal;

export interface PayrollParams {
  year: number;
  mrp: number; // на 1 января года (ИПН, вычет, минимум СН — п. ст. 556 «на первое число месяца»; в 2026 не меняется)
  mzp: number;
  ipn: { rate1: number; rate2: number; thresholdMrp: number };
  basicDeduction: { monthMrp: number; yearMrp: number };
  opv: { rate: number; capMzp: number };
  vosms: { rate: number; capMzp: number };
  oosms: { rate: number; capMzp: number };
  opvr: { rate: number; minMzp: number; capMzp: number; bornBefore: string };
  so: { rate: number; minMzp: number; capMzp: number };
  sn: { rate: number; minMrp: number };
  sources: string[];
}

export const KZ_PAYROLL_2026: PayrollParams = {
  year: 2026,
  mrp: 4325,
  mzp: 85000,
  ipn: { rate1: 0.1, rate2: 0.15, thresholdMrp: 8500 },
  basicDeduction: { monthMrp: 30, yearMrp: 360 },
  opv: { rate: 0.1, capMzp: 50 },
  vosms: { rate: 0.02, capMzp: 20 },
  oosms: { rate: 0.03, capMzp: 40 },
  opvr: { rate: 0.035, minMzp: 1, capMzp: 50, bornBefore: '1975-01-01' },
  so: { rate: 0.05, minMzp: 1, capMzp: 7 },
  sn: { rate: 0.06, minMrp: 14 },
  sources: [
    'НК РК № 214-VIII: ст. 363, 401–403, 437, 439, 441, 556–558',
    'Социальный кодекс РК № 224-VII: ст. 243–245, 248, 249, 251',
    'Закон РК об ОСМС № 405-V: ст. 26–28',
    'Закон о республиканском бюджете на 2026–2028 годы: МРП 4 325, МЗП 85 000',
  ],
};

export function paramsForYear(year: number): PayrollParams {
  if (year === 2026) return KZ_PAYROLL_2026;
  throw new Error(`Нет утверждённых параметров расчёта зарплаты на ${year} год`);
}

export interface PersonFlags {
  birthDate: Date;
  pensionAge: boolean; // достиг пенсионного возраста (СК ст. 207)
  disabilityGroup: number | null;
  disabilityIndefinite: boolean;
  opvByApplication: boolean; // инвалид I–II бессрочно платит ОПВ по заявлению
  fullTimeStudent: boolean;
  /** Гражданин РК / кандас / постоянно проживающий: участник пенсионной и социальной систем. */
  socialParticipant: boolean;
}

export interface MonthInput {
  gross: number | string | Dec; // начислено за месяц (доход работника, ст. 426)
  applyBasicDeduction: boolean; // заявление на базовый вычет (ст. 437)
  hireOrFireMonth: boolean; // месяц найма/увольнения — минимум объекта СН не применяется (ст. 556 п. 3)
  ytd: { taxable: Dec; ipn: Dec; basicDeduction: Dec }; // с 1 января по предыдущий месяц у этого агента
}

export interface MonthResult {
  gross: Dec;
  opv: Dec; vosms: Dec; basicDeduction: Dec; taxable: Dec; ipn: Dec;
  so: Dec; oosms: Dec; opvr: Dec; sn: Dec;
  net: Dec;
  employerCost: Dec;
  bases: Record<string, string>;
  exemptions: string[];
}

const r2 = (x: Dec) => x.toDecimalPlaces(2, D.ROUND_HALF_UP);
const clamp = (x: Dec, lo: Dec, hi: Dec) => D.max(lo, D.min(x, hi));

export function calcMonth(p: PayrollParams, f: PersonFlags, m: MonthInput): MonthResult {
  const gross = new D(m.gross);
  const MZP = new D(p.mzp), MRP = new D(p.mrp);
  const ex: string[] = [];
  const disabledI_II = !!f.disabilityGroup && f.disabilityGroup <= 2 && f.disabilityIndefinite;
  const born = f.birthDate.toISOString().slice(0, 10);

  // ОПВ (работник): освобождены — пенсионный возраст, инвалиды I–II бессрочно (кроме заявления)
  const opvExempt = !f.socialParticipant || f.pensionAge || (disabledI_II && !f.opvByApplication);
  if (opvExempt) ex.push('ОПВ не удерживаются (СК ст. 248 п. 3)');
  const opvBase = D.min(gross, MZP.times(p.opv.capMzp));
  const opv = opvExempt ? new D(0) : r2(opvBase.times(p.opv.rate));

  // ВОСМС (работник): освобождены лица ст. 26 п. 1 закона об ОСМС — получатели пенсий, лица с инвалидностью, студенты очной формы
  const osmsExempt = f.pensionAge || !!f.disabilityGroup || f.fullTimeStudent;
  if (osmsExempt) ex.push('ВОСМС и ООСМС не исчисляются (закон об ОСМС ст. 26 п. 1, ст. 27 п. 3, ст. 28 п. 7)');
  const vosmsBase = D.min(gross, MZP.times(p.vosms.capMzp));
  const vosms = osmsExempt ? new D(0) : r2(vosmsBase.times(p.vosms.rate));

  // Базовый вычет (ст. 403, 437): после вычета соцплатежей (ст. 401 п. 3), в пределах месячного и годового лимита
  const afterSocial = D.max(0, gross.minus(opv).minus(vosms));
  const yearLeft = D.max(0, MRP.times(p.basicDeduction.yearMrp).minus(m.ytd.basicDeduction));
  const basicDeduction = m.applyBasicDeduction ? D.min(MRP.times(p.basicDeduction.monthMrp), yearLeft, afterSocial) : new D(0);
  const taxable = afterSocial.minus(basicDeduction);

  // ИПН нарастающим итогом (ст. 441): 10% до 8 500 МРП, 15% с превышения, минус исчисленное ранее
  const threshold = MRP.times(p.ipn.thresholdMrp);
  const cum = m.ytd.taxable.plus(taxable);
  const cumIpn = r2(D.min(cum, threshold).times(p.ipn.rate1).plus(D.max(0, cum.minus(threshold)).times(p.ipn.rate2)));
  const ipn = D.max(0, cumIpn.minus(m.ytd.ipn));

  // ОПВР (работодатель): от 1 до 50 МЗП; освобождены — пенсионный возраст, инвалиды I–II бессрочно, родившиеся до 01.01.1975
  const opvrExempt = !f.socialParticipant || f.pensionAge || disabledI_II || born < p.opvr.bornBefore;
  if (opvrExempt) ex.push('ОПВР не исчисляются (СК ст. 248 п. 6)');
  const opvrBase = gross.gt(0) ? clamp(gross, MZP.times(p.opvr.minMzp), MZP.times(p.opvr.capMzp)) : new D(0);
  const opvr = opvrExempt ? new D(0) : r2(opvrBase.times(p.opvr.rate));

  // СО (работодатель): с дохода минус ОПВ, от 1 до 7 МЗП; лица пенсионного возраста не подлежат ОСС (ст. 243)
  const soExempt = !f.socialParticipant || f.pensionAge;
  if (soExempt) ex.push('СО не исчисляются (СК ст. 243)');
  const soBase = gross.gt(0) ? clamp(gross.minus(opv), MZP.times(p.so.minMzp), MZP.times(p.so.capMzp)) : new D(0);
  const so = soExempt ? new D(0) : r2(soBase.times(p.so.rate));

  // ООСМС (работодатель): не более 40 МЗП
  const oosmsBase = D.min(gross, MZP.times(p.oosms.capMzp));
  const oosms = osmsExempt ? new D(0) : r2(oosmsBase.times(p.oosms.rate));

  // СН (ст. 556–558): объект — доход; если объект за месяц от 1 ₸ до 14 МРП — объект 14 МРП (кроме месяца найма/увольнения),
  // иначе ставка применяется к объекту минус ОПВ и ВОСМС. СО не вычитается.
  const snMin = MRP.times(p.sn.minMrp);
  let snBase: Dec;
  if (gross.gt(0) && gross.lte(snMin) && !m.hireOrFireMonth) snBase = snMin;
  else snBase = D.max(0, gross.minus(opv).minus(vosms));
  const sn = r2(snBase.times(p.sn.rate));

  const net = gross.minus(opv).minus(vosms).minus(ipn);
  return {
    gross, opv, vosms, basicDeduction, taxable, ipn, so, oosms, opvr, sn, net,
    employerCost: gross.plus(so).plus(oosms).plus(opvr).plus(sn),
    bases: {
      opv: opvBase.toFixed(2), vosms: vosmsBase.toFixed(2), ipnCumulative: cum.toFixed(2), ipnCumulativeTax: cumIpn.toFixed(2),
      opvr: opvrBase.toFixed(2), so: soBase.toFixed(2), oosms: oosmsBase.toFixed(2), sn: snBase.toFixed(2),
    },
    exemptions: ex,
  };
}
