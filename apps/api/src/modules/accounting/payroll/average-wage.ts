// Средняя заработная плата, отпускные, пособие по временной нетрудоспособности, компенсация за неиспользованный отпуск.
// Источники (тексты прочитаны 03.11.2026, zakon.uchet.kz):
//  • Трудовой кодекс РК (ред. 06.09.2026): ст. 88 (24 календарных дня), ст. 90 п. 1 (праздники в отпуске его
//    продлевают), ст. 96 п. 2 (компенсация за неиспользованные дни), ст. 114 п. 2–3 (расчётный период — 12 календарных
//    месяцев перед событием; меньше — за фактически отработанное время), ст. 133 п. 4-1 (пособие = средний дневной ×
//    рабочие дни нетрудоспособности, не более 25 МРП за месяц).
//  • Единые правила исчисления средней заработной платы, приказ МЗСР РК от 30.11.2015 № 908 (ред. 28.05.2026):
//    п. 4 (неотработанное время с сохранением среднего — исключается вместе с суммами), п. 7 (средний дневной × рабочие
//    дни события по балансу), п. 8–9 (средний дневной = начислено за период / рабочие дни в нём), п. 12 (заработка нет —
//    оклад / рабочие дни текущего месяца), п. 15 ч. 2 (компенсация — дни раскладываются со следующего рабочего дня
//    после увольнения), приложение (не включаются: пособие по нетрудоспособности, компенсация отпуска, материальная
//    помощь, разовые премии…).
// Налоги: отпускные, пособие и компенсация облагаются как обычный доход работника (НК 214-VIII: льгот нет).
import { Prisma } from '@prisma/client';
import { D } from '../common/money';

type Dec = Prisma.Decimal;
const r2 = (x: Dec) => x.toDecimalPlaces(2, D.ROUND_HALF_UP);
export const SICK_LIMIT_MRP = 25;
export const ANNUAL_LEAVE_DAYS = 24;

export interface PeriodMonth {
  period: string;          // YYYY-MM
  earnings: Dec | string;  // начислено за отработанное время (оклад + постоянные премии), без отпускных и пособий
  workedDays: number;      // рабочие дни, за которые начислено (без отпуска, болезни, без содержания)
}
export interface AverageWage { avgDaily: Dec; earnings: Dec; days: number; months: string[]; method: 'PERIOD' | 'SALARY'; note: string }

/** 12 календарных месяцев перед месяцем события (YYYY-MM). */
export function periodBefore(eventMonth: string): string[] {
  const [y, m] = eventMonth.split('-').map(Number);
  const out: string[] = [];
  for (let i = 12; i >= 1; i--) {
    const t = y * 12 + (m - 1) - i;
    out.push(`${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`);
  }
  return out;
}

/**
 * Средний дневной заработок (Правила п. 8–9, 12): начислено за отработанное время в расчётном периоде / рабочие дни,
 * за которые оно начислено. Нет заработка — оклад / рабочие дни месяца события (п. 12).
 */
export function averageDaily(months: PeriodMonth[], fallback: { salary: Dec | string; monthWorkdays: number }): AverageWage {
  const used = months.filter((m) => m.workedDays > 0);
  const earnings = used.reduce((s, m) => s.plus(m.earnings), new D(0));
  const days = used.reduce((s, m) => s + m.workedDays, 0);
  if (days > 0 && earnings.gt(0)) {
    return { avgDaily: r2(earnings.div(days)), earnings, days, months: used.map((m) => m.period), method: 'PERIOD', note: 'Правила № 908 п. 8–9: начислено за отработанное время / рабочие дни' };
  }
  const avg = fallback.monthWorkdays ? r2(new D(fallback.salary).div(fallback.monthWorkdays)) : new D(0);
  return { avgDaily: avg, earnings: new D(fallback.salary), days: fallback.monthWorkdays, months: [], method: 'SALARY', note: 'Правила № 908 п. 12: заработка в периоде нет — оклад / рабочие дни месяца события' };
}

/** Отпускные: средний дневной × рабочие дни отпуска (Правила п. 7). */
export function leavePay(avgDaily: Dec, workDays: number): Dec { return r2(avgDaily.times(workDays)); }

/**
 * Пособие по временной нетрудоспособности (ТК ст. 133 п. 4-1): средний дневной × рабочие дни болезни, по каждому
 * календарному месяцу не более 25 МРП соответствующего года (без пропорции за неполный месяц — см. оговорку).
 */
export function sickPay(avgDaily: Dec, workDaysByMonth: { period: string; workDays: number; mrp: number }[]): { total: Dec; byMonth: { period: string; workDays: number; amount: Dec; limit: Dec; capped: boolean }[] } {
  const byMonth = workDaysByMonth.map((m) => {
    const raw = r2(avgDaily.times(m.workDays));
    const limit = new D(m.mrp).times(SICK_LIMIT_MRP);
    return { period: m.period, workDays: m.workDays, amount: D.min(raw, limit), limit, capped: raw.gt(limit) };
  });
  return { total: byMonth.reduce((s, m) => s.plus(m.amount), new D(0)), byMonth };
}

/** Календарные дни отпуска → дата окончания с учётом праздников (ТК ст. 90 п. 1: праздники не входят в отпуск). */
export function leaveEnd(start: string, calendarDays: number, holidays: Set<string>): string {
  let d = new Date(`${start}T00:00:00Z`), counted = 0;
  for (;;) {
    const iso = d.toISOString().slice(0, 10);
    if (!holidays.has(iso)) counted++;
    if (counted >= calendarDays) return iso;
    d = new Date(d.getTime() + 86_400_000);
  }
}
