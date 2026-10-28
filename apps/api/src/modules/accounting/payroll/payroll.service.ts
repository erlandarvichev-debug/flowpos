import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { AccError } from '../common/acc-error';
import { D } from '../common/money';
import { OrgContext } from '../access/org-context';
import { PostingService } from '../core/posting.service';
import { PostingInput } from '../core/posting.types';
import { PeriodsService } from '../periods/periods.service';
import { DocumentsService } from '../documents/documents.service';
import { PersonFlags, calcMonth, paramsForYear } from './kz-payroll';

type Tx = Prisma.TransactionClient;
type Dec = Prisma.Decimal;

export const PAYROLL_SOURCE = 'PAYROLL';
const RULE_VERSION = '1';
const OPEN_END = new Date('9999-12-31T23:59:59.000Z');

/** Счета по умолчанию (план ред. 2025); переопределяются в HrPolicy.accounts. ВОСМС и ООСМС — 3230 (в типовом плане отдельных счетов нет). */
export const PAYROLL_ACCOUNTS = { salary: '3350', ipn: '3120', opv: '3220', vosms: '3230', so: '3210', oosms: '3230', opvr: '3250', sn: '3150', cost: '7030' };

/**
 * Праздничные (нерабочие) дни 2026 при пятидневке: Закон «О праздниках в РК», ст. 85 ТК (перенос выходного).
 * Норма 2026: 247 рабочих дней (сверено: 261 будний − 14 праздничных). Источник: docs/accounting/NORMATIVE_REGISTRY.md § 8 (ВТ).
 */
const HOLIDAYS: Record<number, string[]> = {
  2026: ['2026-01-01', '2026-01-02', '2026-01-07', '2026-03-09', '2026-03-23', '2026-03-24', '2026-03-25', '2026-05-01', '2026-05-07', '2026-05-11', '2026-05-27', '2026-07-06', '2026-10-26', '2026-12-16'],
};

const day = (s: string | Date) => new Date(`${(typeof s === 'string' ? s : s.toISOString()).slice(0, 10)}T00:00:00.000Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);
function monthBounds(period: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new AccError('BAD_PERIOD', 'Период — ГГГГ-ММ');
  const [y, m] = period.split('-').map(Number);
  return { y, m, from: new Date(Date.UTC(y, m - 1, 1)), to: new Date(Date.UTC(y, m, 0)) };
}

@Injectable()
export class PayrollService {
  constructor(private prisma: PrismaService, private posting: PostingService, private periods: PeriodsService, private docs: DocumentsService) {}

  // ── Производственный календарь ──

  async ensureCalendar(year: number) {
    const list = HOLIDAYS[year];
    if (!list) return;
    const have = await this.prisma.hrCalendarDay.count({ where: { organizationId: null, date: { gte: new Date(`${year}-01-01`), lte: new Date(`${year}-12-31`) } } });
    if (have) return;
    await this.prisma.hrCalendarDay.createMany({ data: list.map((d) => ({ organizationId: null, date: day(d), kind: 'HOLIDAY' })), skipDuplicates: true });
  }

  /** Рабочие дни (пятидневка) в интервале включительно с учётом праздников и переносов. */
  private async workdays(organizationId: string, from: Date, to: Date): Promise<string[]> {
    if (from > to) return [];
    await this.ensureCalendar(from.getUTCFullYear());
    const marks = await this.prisma.hrCalendarDay.findMany({ where: { date: { gte: from, lte: to }, OR: [{ organizationId: null }, { organizationId }] } });
    const kind = new Map<string, string>();
    for (const m of marks.sort((a, b) => (a.organizationId ? 1 : 0) - (b.organizationId ? 1 : 0))) kind.set(iso(m.date), m.kind); // своё перекрывает общее
    const out: string[] = [];
    for (let d = new Date(from); d <= to; d = new Date(d.getTime() + 86400000)) {
      const k = kind.get(iso(d));
      const weekday = d.getUTCDay() >= 1 && d.getUTCDay() <= 5;
      if (k === 'WORKDAY' || (weekday && k !== 'HOLIDAY')) out.push(iso(d));
    }
    return out;
  }

  // ── Кадры ──

  async hire(ctx: OrgContext, b: any) {
    for (const k of ['iin', 'lastName', 'firstName', 'birthDate', 'hireDate', 'departmentId', 'salary']) if (!b?.[k]) throw new AccError('FIELD_REQUIRED', `Не заполнено поле ${k}`);
    if (!/^\d{12}$/.test(b.iin)) throw new AccError('BAD_IIN', 'ИИН — 12 цифр');
    const salary = new D(b.salary);
    if (salary.lte(0)) throw new AccError('BAD_SALARY', 'Оклад должен быть больше нуля');
    const dept = await this.prisma.department.findFirst({ where: { id: b.departmentId, OR: [{ organizationId: ctx.organizationId }, { organizationId: null }] } });
    if (!dept) throw new AccError('REF_FOREIGN', 'Подразделение не найдено в организации');
    return this.prisma.$transaction(async (tx) => {
      const ind = await tx.individual.upsert({
        where: { organizationId_iin: { organizationId: ctx.organizationId, iin: b.iin } },
        create: { organizationId: ctx.organizationId, iin: b.iin, lastName: b.lastName, firstName: b.firstName, middleName: b.middleName, birthDate: day(b.birthDate), gender: b.gender ?? 'MALE', isResident: b.isResident ?? true, citizenshipCountryCode: b.citizenship ?? 'KAZ', isPensioner: !!b.isPensioner, disabilityGroup: b.disabilityGroup ?? null, disabilityIndefinite: !!b.disabilityIndefinite, fullTimeStudent: !!b.fullTimeStudent },
        update: { lastName: b.lastName, firstName: b.firstName, middleName: b.middleName },
      });
      const busy = await tx.hrContract.findFirst({ where: { organizationId: ctx.organizationId, individualId: ind.id, status: 'ACTIVE', isMainJob: true } });
      if (busy && b.isMainJob !== false) throw new AccError('ALREADY_EMPLOYED', `${ind.lastName} ${ind.firstName} уже работает по основному договору № ${busy.contractNumber}`);
      const position = b.positionId
        ? await tx.position.findUnique({ where: { id: b.positionId } })
        : (await tx.position.findFirst({ where: { name: b.positionName ?? 'Сотрудник' } })) ?? (await tx.position.create({ data: { name: b.positionName ?? 'Сотрудник' } }));
      if (!position) throw new AccError('REF_NOT_FOUND', 'Должность не найдена');
      const employee = await tx.employee.create({ data: { firstName: b.firstName, lastName: b.lastName, middleName: b.middleName, inn: b.iin, departmentId: dept.id, positionId: position.id, hireDate: day(b.hireDate), salary } });
      const count = await tx.hrContract.count({ where: { organizationId: ctx.organizationId } });
      const contract = await tx.hrContract.create({
        data: {
          organizationId: ctx.organizationId, individualId: ind.id, employeeId: employee.id, contractNumber: b.contractNumber ?? `ТД-${String(count + 1).padStart(4, '0')}`,
          contractDate: day(b.contractDate ?? b.hireDate), hireDate: day(b.hireDate), isMainJob: b.isMainJob !== false, applyStandardDeduction: b.applyStandardDeduction !== false,
        },
      });
      await tx.employmentHistory.create({ data: { contractId: contract.id, validFrom: day(b.hireDate), departmentId: dept.id, positionId: position.id, employmentRate: new D(b.employmentRate ?? 1), calculatedSalary: salary, eventType: 'HIRE', createdBy: ctx.userId } });
      if (b.iban) await tx.employeeBankDetail.create({ data: { contractId: contract.id, iban: b.iban, bic: b.bic ?? '', bankName: b.bankName ?? '' } });
      await tx.auditLog.create({ data: { userId: ctx.userId, organizationId: ctx.organizationId, action: 'HR_HIRE', entity: 'employment_contract', entityId: contract.id, after: { iin: b.iin, salary: salary.toFixed(2), hireDate: b.hireDate } } });
      return { contractId: contract.id, employeeId: employee.id, individualId: ind.id, contractNumber: contract.contractNumber };
    });
  }

  /**
   * Кадровое изменение с даты (битемпоральная история): действующие записи, пересекающие дату, помечаются
   * недействительными и заменяются укороченной версией до даты и новой — с даты. История не стирается.
   */
  async change(ctx: OrgContext, contractId: string, b: { validFrom: string; salary?: string; departmentId?: string; positionId?: string; employmentRate?: string; eventType?: string; comment?: string }) {
    const c = await this.contract(ctx, contractId);
    const from = day(b.validFrom);
    if (from < c.hireDate) throw new AccError('BAD_DATE', 'Дата изменения раньше даты приёма');
    await this.assertNotClosedPayroll(ctx, from);
    return this.prisma.$transaction(async (tx) => {
      const segs = await tx.employmentHistory.findMany({ where: { contractId, systemInvalidatedAt: null, validTo: { gte: from } }, orderBy: { validFrom: 'asc' } });
      if (!segs.length) throw new AccError('NO_ASSIGNMENT', 'Нет действующего назначения на эту дату');
      const now = new Date();
      for (const s of segs) {
        await tx.employmentHistory.update({ where: { id: s.id }, data: { systemInvalidatedAt: now } });
        const base = { contractId, departmentId: s.departmentId, positionId: s.positionId, nkzCode: s.nkzCode, gradeId: s.gradeId, rateTypeId: s.rateTypeId, scheduleId: s.scheduleId, rateUnit: s.rateUnit, employmentRate: s.employmentRate, calculatedSalary: s.calculatedSalary, createdBy: ctx.userId };
        if (s.validFrom < from) await tx.employmentHistory.create({ data: { ...base, validFrom: s.validFrom, validTo: new Date(from.getTime() - 1000), eventType: s.eventType, comment: s.comment } });
        const start = s.validFrom < from ? from : s.validFrom;
        await tx.employmentHistory.create({
          data: {
            ...base, validFrom: start, validTo: s.validTo, eventType: s.validFrom < from ? (b.eventType ?? 'SALARY_CHANGE') : s.eventType, comment: b.comment ?? s.comment,
            ...(b.salary ? { calculatedSalary: new D(b.salary) } : {}), ...(b.departmentId ? { departmentId: b.departmentId } : {}), ...(b.positionId ? { positionId: b.positionId } : {}), ...(b.employmentRate ? { employmentRate: new D(b.employmentRate) } : {}),
          },
        });
      }
      await tx.auditLog.create({ data: { userId: ctx.userId, organizationId: ctx.organizationId, action: 'HR_CHANGE', entity: 'employment_contract', entityId: contractId, after: b as any } });
      return { ok: true };
    });
  }

  async terminate(ctx: OrgContext, contractId: string, b: { date: string; reasonCode?: string }) {
    const c = await this.contract(ctx, contractId);
    const date = day(b.date);
    if (date < c.hireDate) throw new AccError('BAD_DATE', 'Дата увольнения раньше даты приёма');
    await this.assertNotClosedPayroll(ctx, date);
    await this.prisma.$transaction(async (tx) => {
      await tx.hrContract.update({ where: { id: contractId }, data: { fireDate: date, status: 'TERMINATED' } });
      if (c.employeeId) await tx.employee.update({ where: { id: c.employeeId }, data: { fireDate: date, isActive: false } });
      await tx.auditLog.create({ data: { userId: ctx.userId, organizationId: ctx.organizationId, action: 'HR_TERMINATE', entity: 'employment_contract', entityId: contractId, after: { date: b.date, reason: b.reasonCode } } });
    });
    return { ok: true };
  }

  async addAccrual(ctx: OrgContext, contractId: string, b: { period: string; type: string; amount: string; description?: string }) {
    await this.contract(ctx, contractId);
    const { from } = monthBounds(b.period);
    await this.assertNotClosedPayroll(ctx, from);
    if (!['KPI_BONUS', 'COMPENSATION', 'INVENTORY_PENALTY'].includes(b.type)) throw new AccError('BAD_TYPE', 'Вид: KPI_BONUS (премия), COMPENSATION (компенсация), INVENTORY_PENALTY (удержание)');
    return this.prisma.oneTimeAccrual.create({ data: { contractId, period: from, accrualType: b.type, amount: new D(b.amount), description: b.description, createdBy: ctx.userId } });
  }

  private async contract(ctx: OrgContext, id: string) {
    const c = await this.prisma.hrContract.findFirst({ where: { id, organizationId: ctx.organizationId }, include: { individual: true } });
    if (!c) throw new AccError('NOT_FOUND', 'Трудовой договор не найден', { status: 404 });
    return c;
  }

  private async assertNotClosedPayroll(ctx: OrgContext, date: Date) {
    const p = await this.prisma.payrollPeriod.findFirst({ where: { organizationId: ctx.organizationId, period: { gte: new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)) }, status: 'CLOSED' } });
    if (p) throw new AccError('PAYROLL_CLOSED', `Зарплата за ${iso(p.period).slice(0, 7)} уже утверждена — изменения задним числом сначала требуют её отмены`);
  }

  async employees(ctx: OrgContext) {
    const rows = await this.prisma.hrContract.findMany({
      where: { organizationId: ctx.organizationId },
      include: { individual: true, history: { where: { systemInvalidatedAt: null }, orderBy: { validFrom: 'desc' }, take: 1 }, bankDetails: { where: { isActive: true }, take: 1 } },
      orderBy: { contractNumber: 'asc' },
    });
    return rows.map((c) => ({
      contractId: c.id, contractNumber: c.contractNumber, employeeId: c.employeeId, status: c.status, hireDate: c.hireDate, fireDate: c.fireDate,
      iin: c.individual.iin, name: [c.individual.lastName, c.individual.firstName, c.individual.middleName].filter(Boolean).join(' '),
      salary: c.history[0]?.calculatedSalary?.toFixed(2) ?? null, employmentRate: c.history[0]?.employmentRate?.toString() ?? null, departmentId: c.history[0]?.departmentId ?? null,
      applyStandardDeduction: c.applyStandardDeduction, iban: c.bankDetails[0]?.iban ?? null,
    }));
  }

  // ── Расчёт ──

  private flags(ind: any): PersonFlags {
    return {
      birthDate: ind.birthDate, pensionAge: ind.isPensioner, disabilityGroup: ind.disabilityGroup, disabilityIndefinite: ind.disabilityIndefinite,
      opvByApplication: ind.opvByApplication, fullTimeStudent: ind.fullTimeStudent,
      socialParticipant: ind.citizenshipCountryCode === 'KAZ' || ind.isResident, // ПБ: иностранцы без постоянного проживания не участвуют
    };
  }

  async calculate(ctx: OrgContext, period: string, overrides: Record<string, { workedDays?: number }> = {}) {
    const { y, from, to } = monthBounds(period);
    const params = paramsForYear(y);
    const existing = await this.prisma.payrollPeriod.findUnique({ where: { organizationId_period: { organizationId: ctx.organizationId, period: from } } });
    if (existing?.status === 'CLOSED') throw new AccError('PAYROLL_CLOSED', `Зарплата за ${period} утверждена`, { fix: 'Чтобы пересчитать, отмените утверждение.' });
    const normDays = (await this.workdays(ctx.organizationId, from, to)).length;
    const contracts = await this.prisma.hrContract.findMany({
      where: { organizationId: ctx.organizationId, hireDate: { lte: to }, OR: [{ fireDate: null }, { fireDate: { gte: from } }] },
      include: { individual: true, history: { where: { systemInvalidatedAt: null, validFrom: { lte: to }, validTo: { gte: from } }, orderBy: { validFrom: 'asc' } } },
    });

    return this.prisma.$transaction(async (tx) => {
      const pp = await tx.payrollPeriod.upsert({ where: { organizationId_period: { organizationId: ctx.organizationId, period: from } }, create: { organizationId: ctx.organizationId, period: from, status: 'OPEN' }, update: {} });
      await tx.payrollResult.deleteMany({ where: { payrollPeriodId: pp.id, contractId: { notIn: contracts.map((c) => c.id) } } });
      const totals = { gross: new D(0), opv: new D(0), vosms: new D(0), ipn: new D(0), so: new D(0), oosms: new D(0), opvr: new D(0), sn: new D(0), net: new D(0) };
      const out: any[] = [];
      for (const c of contracts) {
        const start = c.hireDate > from ? c.hireDate : from;
        const end = c.fireDate && c.fireDate < to ? c.fireDate : to;
        const segments: any[] = [];
        let base = new D(0), workedDays = 0;
        const ov = overrides[c.id]?.workedDays;
        for (const s of c.history) {
          if (s.rateUnit !== 'MONTHLY') throw new AccError('HOURLY_NOT_SUPPORTED', `Договор ${c.contractNumber}: почасовая оплата пока не рассчитывается`, { fix: 'Укажите месячный оклад.' });
          const sFrom = s.validFrom > start ? day(s.validFrom) : start;
          const sTo = s.validTo < end ? day(s.validTo) : end;
          const days = (await this.workdays(ctx.organizationId, sFrom, sTo)).length;
          const full = new D(s.calculatedSalary).times(s.employmentRate);
          const amount = normDays ? full.times(days).div(normDays) : new D(0);
          segments.push({ from: iso(sFrom), to: iso(sTo), salary: s.calculatedSalary.toFixed(2), rate: s.employmentRate.toString(), days, amount: amount.toFixed(2) });
          base = base.plus(amount); workedDays += days;
        }
        if (ov !== undefined && c.history.length) {
          // фактически отработанные дни (табель): по последнему окладу месяца
          const last = c.history[c.history.length - 1];
          base = new D(last.calculatedSalary).times(last.employmentRate).times(ov).div(normDays || 1);
          workedDays = ov;
          segments.push({ override: true, workedDays: ov });
        }
        base = base.toDecimalPlaces(2, D.ROUND_HALF_UP);
        const accruals = await tx.oneTimeAccrual.findMany({ where: { contractId: c.id, period: from } });
        const bonus = accruals.filter((a) => a.accrualType !== 'INVENTORY_PENALTY').reduce((s, a) => s.plus(a.amount), new D(0));
        const other = accruals.filter((a) => a.accrualType === 'INVENTORY_PENALTY').reduce((s, a) => s.plus(a.amount), new D(0));
        const gross = base.plus(bonus);

        const prev = await tx.payrollResult.aggregate({ where: { contractId: c.id, period: { gte: new Date(Date.UTC(y, 0, 1)), lt: from } }, _sum: { ipnBase: true, ipnAmount: true, standardDeduction: true } });
        const hireOrFire = (c.hireDate >= from && c.hireDate <= to) || (!!c.fireDate && c.fireDate >= from && c.fireDate <= to);
        const r = calcMonth(params, this.flags(c.individual), {
          gross, applyBasicDeduction: c.applyStandardDeduction && c.isMainJob, hireOrFireMonth: hireOrFire,
          ytd: { taxable: new D(prev._sum.ipnBase ?? 0), ipn: new D(prev._sum.ipnAmount ?? 0), basicDeduction: new D(prev._sum.standardDeduction ?? 0) },
        });
        const net = r.net.minus(other);
        const data = {
          payrollPeriodId: pp.id, contractId: c.id, period: from, departmentId: c.history[c.history.length - 1]?.departmentId ?? null,
          normDays, workedDays: new D(workedDays), baseAccrued: base, bonusAccrued: bonus, totalGrossSalary: gross,
          opvAmount: r.opv, vosmsAmount: r.vosms, standardDeduction: r.basicDeduction, ipnBase: r.taxable, ipnAmount: r.ipn,
          soAmount: r.so, snAmount: r.sn, oosmsAmount: r.oosms, opvrAmount: r.opvr, otherDeductions: other, netSalaryToPay: net,
          details: { segments, bases: r.bases, exemptions: r.exemptions, params: { year: params.year, mrp: params.mrp, mzp: params.mzp }, sources: params.sources } as any,
        };
        const saved = await tx.payrollResult.upsert({ where: { payrollPeriodId_contractId: { payrollPeriodId: pp.id, contractId: c.id } }, create: data, update: data });
        out.push(saved);
        totals.gross = totals.gross.plus(gross); totals.opv = totals.opv.plus(r.opv); totals.vosms = totals.vosms.plus(r.vosms); totals.ipn = totals.ipn.plus(r.ipn);
        totals.so = totals.so.plus(r.so); totals.oosms = totals.oosms.plus(r.oosms); totals.opvr = totals.opvr.plus(r.opvr); totals.sn = totals.sn.plus(r.sn); totals.net = totals.net.plus(net);
      }
      const t = Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, v.toFixed(2)]));
      await tx.payrollPeriod.update({ where: { id: pp.id }, data: { status: 'CALCULATED', calculatedAt: new Date(), totals: { ...t, employees: contracts.length, normDays } } });
      return { period, status: 'CALCULATED', normDays, totals: t, results: out.length };
    });
  }

  async get(ctx: OrgContext, period: string) {
    const { from } = monthBounds(period);
    const pp = await this.prisma.payrollPeriod.findUnique({ where: { organizationId_period: { organizationId: ctx.organizationId, period: from } }, include: { results: { include: { contract: { include: { individual: true } } }, orderBy: { createdAt: 'asc' } } } });
    if (!pp) return { period, status: 'NONE', results: [], totals: null };
    const entry = await this.prisma.accEntry.findFirst({ where: { organizationId: ctx.organizationId, sourceType: PAYROLL_SOURCE, sourceId: pp.id, status: 'ACTIVE' }, select: { id: true } });
    return {
      period, id: pp.id, status: pp.status, totals: pp.totals, entryId: entry?.id ?? null,
      results: pp.results.map((r) => ({
        ...r, name: [r.contract.individual.lastName, r.contract.individual.firstName, r.contract.individual.middleName].filter(Boolean).join(' '), iin: r.contract.individual.iin,
        contractNumber: r.contract.contractNumber, employeeId: r.contract.employeeId, contract: undefined,
      })),
    };
  }

  private async accounts(organizationId: string) {
    const pol = await this.prisma.hrPolicy.findUnique({ where: { organizationId } });
    return { ...PAYROLL_ACCOUNTS, ...((pol?.accounts as any) ?? {}) } as typeof PAYROLL_ACCOUNTS;
  }

  /** Утвердить: проводки начисления, удержаний и налогов работодателя (одна запись на месяц). */
  async approve(ctx: OrgContext, period: string) {
    const { from, to } = monthBounds(period);
    const pp = await this.prisma.payrollPeriod.findUnique({ where: { organizationId_period: { organizationId: ctx.organizationId, period: from } }, include: { results: { include: { contract: true } } } });
    if (!pp || pp.status !== 'CALCULATED') throw new AccError('PAYROLL_NOT_CALCULATED', 'Сначала рассчитайте зарплату за месяц');
    const acc = await this.accounts(ctx.organizationId);
    const depts = await this.prisma.department.findMany({ where: { id: { in: pp.results.map((r) => r.departmentId).filter(Boolean) as string[] } } });
    const costOf = (id: string | null) => depts.find((d) => d.id === id)?.costAccount ?? acc.cost;
    const P: PostingInput[] = [];
    const add = (side: 'D' | 'C', account: string, amount: Dec, dims: any, memo: string) => { if (!amount.isZero()) P.push({ side, account, amount: amount.toFixed(2), dims, memo }); };
    for (const r of pp.results) {
      const emp = r.contract.employeeId;
      if (!emp) throw new AccError('EMPLOYEE_LINK', `Договор ${r.contract.contractNumber} не связан с сотрудником`);
      const E = { EMPLOYEE: emp };
      const cost = costOf(r.departmentId);
      const dept = r.departmentId ? { DEPARTMENT: r.departmentId } : {};
      add('D', cost, r.totalGrossSalary, dept, 'Начислена заработная плата'); add('C', acc.salary, r.totalGrossSalary, E, 'Начислена заработная плата');
      add('D', acc.salary, r.opvAmount, E, 'Удержаны ОПВ'); add('C', acc.opv, r.opvAmount, E, 'ОПВ к перечислению');
      add('D', acc.salary, r.vosmsAmount, E, 'Удержаны ВОСМС'); add('C', acc.vosms, r.vosmsAmount, E, 'ВОСМС к перечислению');
      add('D', acc.salary, r.ipnAmount, E, 'Удержан ИПН'); add('C', acc.ipn, r.ipnAmount, E, 'ИПН к уплате');
      if (!r.otherDeductions.isZero()) { add('D', acc.salary, r.otherDeductions, E, 'Удержание из зарплаты'); add('C', '1250', r.otherDeductions, E, 'Удержание в счёт задолженности работника'); }
      add('D', cost, r.soAmount, dept, 'Социальные отчисления'); add('C', acc.so, r.soAmount, E, 'СО к перечислению');
      add('D', cost, r.oosmsAmount, dept, 'Отчисления на ОСМС'); add('C', acc.oosms, r.oosmsAmount, E, 'ООСМС к перечислению');
      add('D', cost, r.opvrAmount, dept, 'ОПВ работодателя'); add('C', acc.opvr, r.opvrAmount, E, 'ОПВР к перечислению');
      add('D', cost, r.snAmount, dept, 'Социальный налог'); add('C', acc.sn, r.snAmount, {}, 'Социальный налог к уплате');
    }
    const version = createHash('sha1').update(JSON.stringify(P)).digest().readUInt32BE(0) & 0x7fffffff;
    await this.prisma.$transaction(async (tx) => {
      await this.periods.assertOpen(tx, ctx, [to], undefined, 'утверждение зарплаты');
      await this.posting.writeEntry(tx, ctx, { sourceType: PAYROLL_SOURCE, sourceId: pp.id, sourceVersion: version, ruleCode: 'PAYROLL', ruleVersion: RULE_VERSION, date: to, postings: P });
      await tx.payrollPeriod.update({ where: { id: pp.id }, data: { status: 'CLOSED', closedAt: new Date(), closedBy: ctx.userId } });
      await tx.payrollResult.updateMany({ where: { payrollPeriodId: pp.id }, data: { isClosed: true } });
      await tx.auditLog.create({ data: { userId: ctx.userId, organizationId: ctx.organizationId, action: 'PAYROLL_APPROVE', entity: 'payroll_period', entityId: pp.id, after: pp.totals as any } });
    });
    return this.get(ctx, period);
  }

  async unapprove(ctx: OrgContext, period: string, reason: string) {
    if (!reason?.trim()) throw new AccError('REASON_REQUIRED', 'Укажите причину отмены утверждения');
    const { from, to } = monthBounds(period);
    const pp = await this.prisma.payrollPeriod.findUnique({ where: { organizationId_period: { organizationId: ctx.organizationId, period: from } } });
    if (!pp || pp.status !== 'CLOSED') throw new AccError('PAYROLL_NOT_APPROVED', 'Зарплата за месяц не утверждена');
    const later = await this.prisma.payrollPeriod.findFirst({ where: { organizationId: ctx.organizationId, period: { gt: from }, status: { in: ['CALCULATED', 'CLOSED'] } } });
    if (later) throw new AccError('LATER_PAYROLL', `Есть расчёт за более поздний месяц (${iso(later.period).slice(0, 7)}) — ИПН считается нарастающим итогом`, { fix: 'Сначала удалите или отмените более поздние расчёты.' });
    await this.prisma.$transaction(async (tx) => {
      await this.periods.assertOpen(tx, ctx, [to], undefined, 'отмена утверждения зарплаты');
      await this.posting.cancelSource(tx, ctx.organizationId, PAYROLL_SOURCE, pp.id);
      await tx.payrollPeriod.update({ where: { id: pp.id }, data: { status: 'CALCULATED', closedAt: null, closedBy: null } });
      await tx.payrollResult.updateMany({ where: { payrollPeriodId: pp.id }, data: { isClosed: false } });
      await tx.auditLog.create({ data: { userId: ctx.userId, organizationId: ctx.organizationId, action: 'PAYROLL_UNAPPROVE', entity: 'payroll_period', entityId: pp.id, reason } });
    });
    return this.get(ctx, period);
  }

  /**
   * Строки для выплаты: зарплата к выплате по сотрудникам и обязательства по видам (для банковских документов).
   * КНП: 010 ОПВ, 012 СО, 121 ООСМС, 122 ВОСМС — по реестру нормативки (ВТ); для ИПН/СН/ОПВР КНП и КБК не сверены — указывает бухгалтер.
   */
  async payoutLines(ctx: OrgContext, period: string) {
    const p = await this.get(ctx, period);
    if (p.status !== 'CLOSED') throw new AccError('PAYROLL_NOT_APPROVED', 'Выплата возможна после утверждения зарплаты');
    const acc = await this.accounts(ctx.organizationId);
    const rows: any[] = p.results;
    const sum = (k: string): Dec => rows.reduce((s: Dec, r: any) => s.plus(r[k]), new D(0));
    const byEmp = (k: string, account: string) => rows.filter((r: any) => !new D(r[k]).isZero()).map((r: any) => ({ account, employeeId: r.employeeId, amount: new D(r[k]).toFixed(2) }));
    return {
      salary: byEmp('netSalaryToPay', acc.salary),
      obligations: [
        { code: 'IPN', title: 'ИПН', knp: null, lines: byEmp('ipnAmount', acc.ipn), total: sum('ipnAmount').toFixed(2) },
        { code: 'SN', title: 'Социальный налог', knp: null, lines: [{ account: acc.sn, amount: sum('snAmount').toFixed(2) }], total: sum('snAmount').toFixed(2) },
        { code: 'OPV', title: 'ОПВ', knp: '010', lines: byEmp('opvAmount', acc.opv), total: sum('opvAmount').toFixed(2) },
        { code: 'OPVR', title: 'ОПВР', knp: null, lines: byEmp('opvrAmount', acc.opvr), total: sum('opvrAmount').toFixed(2) },
        { code: 'SO', title: 'Социальные отчисления', knp: '012', lines: byEmp('soAmount', acc.so), total: sum('soAmount').toFixed(2) },
        { code: 'VOSMS', title: 'Взносы ВОСМС', knp: '122', lines: byEmp('vosmsAmount', acc.vosms), total: sum('vosmsAmount').toFixed(2) },
        { code: 'OOSMS', title: 'Отчисления ООСМС', knp: '121', lines: byEmp('oosmsAmount', acc.oosms), total: sum('oosmsAmount').toFixed(2) },
      ],
    };
  }

  /**
   * Черновики банковских документов на выплату: зарплата (по сотрудникам) и каждый вид налогов/взносов отдельно.
   * Проводит их человек после проверки (выплата — необратимое действие).
   */
  async createPayout(ctx: OrgContext, period: string, b: { bankAccountId: string; date: string; kinds?: string[] }) {
    if (!b?.bankAccountId || !b?.date) throw new AccError('FIELD_REQUIRED', 'Укажите банковский счёт и дату выплаты');
    const lines = await this.payoutLines(ctx, period);
    const groups = [{ code: 'SALARY', title: 'Заработная плата', lines: lines.salary }, ...lines.obligations];
    const want = new Set(b.kinds?.length ? b.kinds : groups.map((g) => g.code));
    const created: any[] = [];
    for (const g of groups) {
      if (!want.has(g.code) || !g.lines.length) continue;
      const total = g.lines.reduce((s: Dec, l: any) => s.plus(l.amount), new D(0));
      if (total.isZero()) continue;
      const doc = await this.docs.create(ctx, { docType: 'BANK_OUT', date: b.date, body: { bankAccountId: b.bankAccountId, operation: 'PAYROLL', amount: total.toFixed(2), lines: g.lines, purpose: `${g.title} за ${period}`, payrollPeriod: period, kind: g.code } } as any);
      created.push({ kind: g.code, title: g.title, documentId: doc.id, number: (doc as any).number, amount: total.toFixed(2) });
    }
    return { period, documents: created };
  }
}
