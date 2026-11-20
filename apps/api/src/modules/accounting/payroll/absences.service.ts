// Отсутствия сотрудников: ежегодный отпуск, отпуск без содержания, временная нетрудоспособность, декрет, компенсация
// неиспользованного отпуска при увольнении. Утверждение считает средний заработок (average-wage.ts) и сумму, которая
// входит в начисления месяца payPeriod; дни отсутствия исключаются из отработанных в расчёте месяца.
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AccError } from '../common/acc-error';
import { OrgContext } from '../access/org-context';
import { D } from '../common/money';
import { PayrollService } from './payroll.service';
import { paramsForYear } from './kz-payroll';
import { ANNUAL_LEAVE_DAYS, averageDaily, leaveEnd, leavePay, periodBefore, sickPay } from './average-wage';

type Dec = Prisma.Decimal;
const KINDS = ['ANNUAL_LEAVE', 'UNPAID_LEAVE', 'SICK', 'MATERNITY', 'OTHER_PAID'] as const;
const PAID = new Set(['ANNUAL_LEAVE', 'SICK', 'OTHER_PAID', 'LEAVE_COMPENSATION']);
export const KIND_LABEL: Record<string, string> = {
  ANNUAL_LEAVE: 'Ежегодный оплачиваемый отпуск', UNPAID_LEAVE: 'Отпуск без сохранения зарплаты', SICK: 'Временная нетрудоспособность',
  MATERNITY: 'Отпуск по беременности и родам (выплата ГФСС)', OTHER_PAID: 'Прочее с сохранением среднего', LEAVE_COMPENSATION: 'Компенсация за неиспользованный отпуск',
};
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const month = (d: Date | string) => (typeof d === 'string' ? d : iso(d)).slice(0, 7);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

@Injectable()
export class AbsencesService {
  constructor(private prisma: PrismaService, private payroll: PayrollService) {}

  private async contract(ctx: OrgContext, id: string) {
    const c = await this.prisma.hrContract.findFirst({ where: { id, organizationId: ctx.organizationId }, include: { individual: true } });
    if (!c) throw new AccError('NOT_FOUND', 'Трудовой договор не найден', { status: 404 });
    return c;
  }

  private async assertMonthOpen(ctx: OrgContext, periods: string[]) {
    for (const p of [...new Set(periods)]) {
      const pp = await this.prisma.payrollPeriod.findUnique({ where: { organizationId_period: { organizationId: ctx.organizationId, period: day(`${p}-01`) } } });
      if (pp?.status === 'CLOSED') throw new AccError('PAYROLL_CLOSED', `Зарплата за ${p} утверждена — сначала отмените утверждение`, { status: 409 });
    }
  }

  /** Черновик: даты (для отпуска можно указать календарные дни — праздники продлевают отпуск). */
  async create(ctx: OrgContext, contractId: string, b: { kind?: string; dateFrom?: string; dateTo?: string; days?: number; documentNumber?: string; note?: string }) {
    const c = await this.contract(ctx, contractId);
    if (!KINDS.includes(b.kind as any)) throw new AccError('BAD_KIND', `Вид отсутствия: ${KINDS.join(', ')}`);
    if (!b.dateFrom || !DATE.test(b.dateFrom)) throw new AccError('BAD_DATE', 'Дата начала — ГГГГ-ММ-ДД');
    let dateTo = b.dateTo;
    if (!dateTo && b.kind === 'ANNUAL_LEAVE' && b.days) {
      if (!Number.isInteger(b.days) || b.days < 1 || b.days > 120) throw new AccError('BAD_DAYS', 'Календарных дней отпуска — от 1 до 120');
      const hol = await this.payroll.holidays(ctx.organizationId, day(b.dateFrom), addDays(day(b.dateFrom), b.days + 40));
      dateTo = leaveEnd(b.dateFrom, b.days, hol);
    }
    if (!dateTo || !DATE.test(dateTo) || dateTo < b.dateFrom) throw new AccError('BAD_DATE', 'Дата окончания не раньше даты начала');
    if (iso(c.hireDate) > b.dateFrom || (c.fireDate && iso(c.fireDate) < dateTo)) throw new AccError('OUT_OF_CONTRACT', 'Отсутствие вне периода работы по договору');
    if (b.kind === 'SICK' && !String(b.documentNumber ?? '').trim()) throw new AccError('DOCUMENT_REQUIRED', 'Укажите номер листа временной нетрудоспособности');
    const from = day(b.dateFrom), to = day(dateTo);
    const calendarDays = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
    const workDays = (await this.payroll.workdays(ctx.organizationId, from, to)).length;
    return this.prisma.hrAbsence.create({
      data: { organizationId: ctx.organizationId, contractId: c.id, kind: b.kind!, dateFrom: from, dateTo: to, calendarDays, workDays, documentNumber: b.documentNumber?.trim() || null, note: b.note || null, createdBy: ctx.userId },
    });
  }

  /** Средний дневной заработок на дату события (12 месяцев до месяца события). */
  async average(ctx: OrgContext, contractId: string, eventDate: string) {
    const c = await this.contract(ctx, contractId);
    const months = periodBefore(month(eventDate));
    const rows = await this.prisma.payrollResult.findMany({
      where: { contractId: c.id, period: { gte: day(`${months[0]}-01`), lte: day(`${months[11]}-01`) }, payrollPeriod: { status: 'CLOSED' } },
      orderBy: { period: 'asc' },
    });
    const hist = await this.prisma.employmentHistory.findFirst({ where: { contractId: c.id, systemInvalidatedAt: null, validFrom: { lte: day(eventDate) } }, orderBy: { validFrom: 'desc' } });
    const evMonth = month(eventDate);
    const monthWorkdays = (await this.payroll.workdays(ctx.organizationId, day(`${evMonth}-01`), new Date(Date.UTC(Number(evMonth.slice(0, 4)), Number(evMonth.slice(5)), 0)))).length;
    return averageDaily(
      rows.map((r) => ({ period: iso(r.period).slice(0, 7), earnings: new D(r.baseAccrued).plus(r.bonusAccrued), workedDays: Number(r.workedDays) })),
      { salary: hist ? new D(hist.calculatedSalary).times(hist.employmentRate) : new D(0), monthWorkdays },
    );
  }

  /** Утвердить: расчёт среднего и суммы; оплачиваемые входят в начисления месяца payPeriod. */
  async approve(ctx: OrgContext, id: string) {
    const a = await this.prisma.hrAbsence.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!a) throw new AccError('NOT_FOUND', 'Отсутствие не найдено', { status: 404 });
    if (a.status !== 'DRAFT') throw new AccError('NOT_DRAFT', 'Утверждается только черновик', { status: 409 });
    const touched: string[] = [];
    for (let d = new Date(a.dateFrom); d <= a.dateTo; d = addDays(d, 1)) touched.push(month(d));
    let amount = new D(0), avgDaily = new D(0), calc: any = { kind: a.kind }, payPeriod: string | null = null, paidDays = 0;
    if (PAID.has(a.kind)) {
      const avg = await this.average(ctx, a.contractId, iso(a.dateFrom));
      avgDaily = avg.avgDaily;
      calc = { kind: a.kind, average: { ...avg, avgDaily: avg.avgDaily.toFixed(2), earnings: avg.earnings.toFixed(2) } };
      if (a.kind === 'SICK') {
        const byMonth: { period: string; workDays: number; mrp: number }[] = [];
        for (const p of [...new Set(touched)]) {
          const mFrom = day(`${p}-01`) > a.dateFrom ? day(`${p}-01`) : a.dateFrom;
          const mEnd = new Date(Date.UTC(Number(p.slice(0, 4)), Number(p.slice(5)), 0));
          const mTo = mEnd < a.dateTo ? mEnd : a.dateTo;
          byMonth.push({ period: p, workDays: (await this.payroll.workdays(ctx.organizationId, mFrom, mTo)).length, mrp: paramsForYear(Number(p.slice(0, 4))).mrp });
        }
        const s = sickPay(avgDaily, byMonth);
        amount = s.total; paidDays = a.workDays;
        calc.byMonth = s.byMonth.map((m) => ({ ...m, amount: m.amount.toFixed(2), limit: m.limit.toFixed(2) }));
        calc.rule = 'ТК РК ст. 133 п. 4-1: средний дневной × рабочие дни, не более 25 МРП за месяц';
        payPeriod = month(a.dateTo); // оплата — после закрытия листа, в сроки выплаты зарплаты
      } else {
        amount = leavePay(avgDaily, a.workDays); paidDays = a.workDays;
        calc.rule = 'Правила № 908 п. 7: средний дневной × рабочие дни отпуска по балансу';
        payPeriod = month(a.dateFrom); // отпускные — не позднее 3 рабочих дней до начала (ТК ст. 92 п. 4)
      }
    } else {
      calc.rule = a.kind === 'MATERNITY' ? 'Социальная выплата — из ГФСС; работодатель не начисляет' : 'Без сохранения заработной платы';
    }
    await this.assertMonthOpen(ctx, [...touched, ...(payPeriod ? [payPeriod] : [])]);
    const row = await this.prisma.hrAbsence.update({ where: { id }, data: { status: 'APPROVED', avgDailyWage: avgDaily, amount: amount.toDecimalPlaces(2), paidDays, calc, payPeriod, approvedBy: ctx.userId, approvedAt: new Date() } })
      .catch((e: any) => { const m = /\b(ABSENCE_OVERLAP|ABSENCE_DATES)\b/.exec(String(e?.message)); if (m) throw new AccError(m[1], m[1] === 'ABSENCE_OVERLAP' ? 'Отсутствие пересекается с уже утверждённым' : 'Неверные даты', { status: 409 }); throw e; });
    await this.prisma.auditLog.create({ data: { userId: ctx.userId, organizationId: ctx.organizationId, action: 'HR_ABSENCE_APPROVED', entity: 'hr_absence', entityId: id, after: { kind: a.kind, from: iso(a.dateFrom), to: iso(a.dateTo), amount: amount.toFixed(2), payPeriod } as any } });
    return row;
  }

  async cancel(ctx: OrgContext, id: string, reason: string) {
    if (String(reason ?? '').trim().length < 5) throw new AccError('REASON_REQUIRED', 'Укажите причину отмены (не короче 5 символов)');
    const a = await this.prisma.hrAbsence.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!a) throw new AccError('NOT_FOUND', 'Отсутствие не найдено', { status: 404 });
    if (a.status === 'DRAFT') { await this.prisma.hrAbsence.delete({ where: { id } }); return { deleted: true }; }
    if (a.status !== 'APPROVED') throw new AccError('NOT_APPROVED', 'Отсутствие уже отменено', { status: 409 });
    const touched: string[] = [];
    for (let d = new Date(a.dateFrom); d <= a.dateTo; d = addDays(d, 1)) touched.push(month(d));
    await this.assertMonthOpen(ctx, [...touched, ...(a.payPeriod ? [a.payPeriod] : [])]);
    const row = await this.prisma.hrAbsence.update({ where: { id }, data: { status: 'CANCELLED', cancelledBy: ctx.userId, cancelReason: reason.trim() } });
    await this.prisma.auditLog.create({ data: { userId: ctx.userId, organizationId: ctx.organizationId, action: 'HR_ABSENCE_CANCELLED', entity: 'hr_absence', entityId: id, reason: reason.trim() } });
    return row;
  }

  async list(ctx: OrgContext, q: { contractId?: string; from?: string; to?: string; status?: string }) {
    const rows = await this.prisma.hrAbsence.findMany({
      where: { organizationId: ctx.organizationId, ...(q.contractId ? { contractId: q.contractId } : {}), ...(q.status ? { status: q.status } : { status: { not: 'CANCELLED' } }),
        ...(q.from && q.to ? { dateFrom: { lte: day(q.to) }, dateTo: { gte: day(q.from) } } : {}) },
      orderBy: { dateFrom: 'desc' }, take: 500,
    });
    const cs = await this.prisma.hrContract.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.contractId))] } }, include: { individual: true } });
    return rows.map((r) => { const c = cs.find((x) => x.id === r.contractId); return { ...r, kindLabel: KIND_LABEL[r.kind] ?? r.kind, name: c ? [c.individual.lastName, c.individual.firstName].join(' ') : '' }; });
  }

  /**
   * Остаток ежегодного отпуска на дату: положено (дни в год / 12 × полных месяцев работы — практика расчёта, не норма
   * ТК) − использовано (календарные дни утверждённых ежегодных отпусков без праздников).
   */
  async leaveBalance(ctx: OrgContext, contractId: string, asOf: string) {
    const c = await this.contract(ctx, contractId);
    const perYear = c.vacationDaysPerYear ?? ANNUAL_LEAVE_DAYS;
    const h = c.hireDate, t = day(asOf);
    let months = (t.getUTCFullYear() - h.getUTCFullYear()) * 12 + (t.getUTCMonth() - h.getUTCMonth());
    if (t.getUTCDate() + 1 < h.getUTCDate()) months -= 1;
    months = Math.max(0, months);
    const entitled = new D(perYear).times(months).div(12).toDecimalPlaces(2);
    const leaves = await this.prisma.hrAbsence.findMany({ where: { contractId, status: 'APPROVED', kind: 'ANNUAL_LEAVE', dateFrom: { lte: t } } });
    let used = 0;
    for (const l of leaves) {
      const hol = await this.payroll.holidays(ctx.organizationId, l.dateFrom, l.dateTo);
      used += l.calendarDays - [...hol].filter((x) => x >= iso(l.dateFrom) && x <= iso(l.dateTo)).length;
    }
    return { contractId, asOf, perYear, monthsWorked: months, entitled: entitled.toFixed(2), used, balance: entitled.minus(used).toFixed(2), note: 'Положено = дни в год / 12 × полные месяцы работы (практика; норма ТК — 24 календарных дня за рабочий год, ст. 88, 92)' };
  }

  /**
   * Компенсация неиспользованного отпуска при увольнении (ТК ст. 96 п. 2; Правила п. 15 ч. 2): неиспользованные
   * календарные дни раскладываются со дня, следующего за увольнением; оплачиваются рабочие дни в этом промежутке.
   */
  async compensation(ctx: OrgContext, contractId: string) {
    const c = await this.contract(ctx, contractId);
    if (!c.fireDate) throw new AccError('NOT_TERMINATED', 'Сначала оформите увольнение');
    const fire = iso(c.fireDate);
    const bal = await this.leaveBalance(ctx, contractId, fire);
    const days = Math.floor(Number(bal.balance));
    if (days <= 0) throw new AccError('NO_UNUSED_LEAVE', 'Неиспользованных дней отпуска нет');
    const exists = await this.prisma.hrAbsence.findFirst({ where: { contractId, kind: 'LEAVE_COMPENSATION', status: { not: 'CANCELLED' } } });
    if (exists) throw new AccError('COMPENSATION_EXISTS', 'Компенсация уже оформлена', { status: 409 });
    const start = iso(addDays(c.fireDate, 1));
    const hol = await this.payroll.holidays(ctx.organizationId, day(start), addDays(day(start), days + 40));
    const end = leaveEnd(start, days, hol);
    const workDays = (await this.payroll.workdays(ctx.organizationId, day(start), day(end))).length;
    const avg = await this.average(ctx, contractId, fire);
    const amount = leavePay(avg.avgDaily, workDays);
    await this.assertMonthOpen(ctx, [month(fire)]);
    const row = await this.prisma.hrAbsence.create({
      data: {
        organizationId: ctx.organizationId, contractId, kind: 'LEAVE_COMPENSATION', dateFrom: day(start), dateTo: day(end), calendarDays: days, workDays, paidDays: workDays,
        status: 'APPROVED', avgDailyWage: avg.avgDaily, amount, payPeriod: month(fire), approvedBy: ctx.userId, approvedAt: new Date(), createdBy: ctx.userId,
        calc: { kind: 'LEAVE_COMPENSATION', balance: bal, average: { ...avg, avgDaily: avg.avgDaily.toFixed(2), earnings: avg.earnings.toFixed(2) }, rule: 'ТК ст. 96 п. 2; Правила № 908 п. 15 ч. 2' } as any,
      },
    });
    await this.prisma.auditLog.create({ data: { userId: ctx.userId, organizationId: ctx.organizationId, action: 'HR_LEAVE_COMPENSATION', entity: 'hr_absence', entityId: row.id, after: { days, workDays, amount: amount.toFixed(2) } as any } });
    return row;
  }
}

/** Для расчёта месяца: рабочие дни отсутствия в интервале и сумма оплачиваемых отсутствий месяца. */
export async function absencesForPayroll(prisma: PrismaService | Prisma.TransactionClient, contractId: string, period: string, workdaysIn: (from: Date, to: Date) => Promise<string[]>) {
  const rows = await prisma.hrAbsence.findMany({ where: { contractId, status: 'APPROVED' } });
  const mine = rows.filter((r) => r.payPeriod === period);
  const pay = mine.reduce((s: Dec, r) => s.plus(r.amount), new D(0));
  const absentDays = async (from: Date, to: Date) => {
    const set = new Set<string>();
    for (const r of rows) {
      if (r.kind === 'LEAVE_COMPENSATION') continue; // дни после увольнения
      const f = r.dateFrom > from ? r.dateFrom : from, t = r.dateTo < to ? r.dateTo : to;
      if (f > t) continue;
      for (const d of await workdaysIn(f, t)) set.add(d);
    }
    return set;
  };
  return { pay, absentDays, items: mine.map((r) => ({ id: r.id, kind: r.kind, amount: r.amount.toFixed(2), from: iso(r.dateFrom), to: iso(r.dateTo) })) };
}
