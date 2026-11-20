// Отпуска, больничные, компенсация — эталон вручную (правила: ТК ст. 88, 90, 96, 114, 133; Правила № 908):
// оклад 300 000 с 05.01.2026; январь 19 / февраль 20 / март 18 рабочих дней, все закрыты → средний 900 000 / 57 =
// 15 789,47; отпуск 06.04, 14 календарных дней → 10 рабочих → 157 894,70; апрель: оклад за 12 из 22 дней = 163 636,36,
// начислено 321 531,06. Больничный 04–08.05 (07.05 праздник) → 4 рабочих дня; средний (900 000 + 163 636,36) / 69 =
// 15 415,02 → 61 660,08. Лимит: оклад 2 200 000, июнь 22 дня → средний 100 000 × 10 = 1 000 000 → 25 МРП = 108 125.
// Компенсация: 12 дней с 05.07 (06.07 праздник) → до 17.07, 9 рабочих × 220 000 / 22 = 90 000.
import { PrismaService } from '../src/prisma/prisma.service';
import { PayrollService } from '../src/modules/accounting/payroll/payroll.service';
import { AbsencesService } from '../src/modules/accounting/payroll/absences.service';
import { PeriodsService } from '../src/modules/accounting/periods/periods.service';
import { makeOrg, makeServices } from './accounting-helpers';

const prisma = new PrismaService();
const s = makeServices(prisma);
const payroll = new PayrollService(prisma, s.posting, new PeriodsService(prisma), s.docs);
const abs = new AbsencesService(prisma, payroll);
afterAll(() => prisma.$disconnect());
const iin = () => String(Math.floor(1e11 + Math.random() * 8.9e11));
async function code(p: Promise<unknown>) {
  try { await p; return 'OK'; } catch (e: any) { return e?.getResponse?.()?.code ?? e?.message; }
}

describe('Отпуска и больничные', () => {
  it('отпуск: средний по рабочим дням, оклад за отпуск не начисляется; больничный с праздником; пересечение; отмена', async () => {
    const ctx = await makeOrg(prisma, 'owner');
    const dept = await prisma.department.create({ data: { organizationId: ctx.organizationId, name: 'Офис', kind: 'OFFICE', costAccount: '7030' } });
    const e = await payroll.hire(ctx, { iin: iin(), lastName: 'Абаев', firstName: 'Нурлан', birthDate: '1988-03-03', hireDate: '2026-01-05', departmentId: dept.id, salary: '300000' });
    for (const p of ['2026-01', '2026-02', '2026-03']) { await payroll.calculate(ctx, p); await payroll.approve(ctx, p); }
    const days = (await prisma.payrollResult.findMany({ where: { contractId: e.contractId }, orderBy: { period: 'asc' } })).map((r) => [Number(r.workedDays), r.baseAccrued.toFixed(2)]);
    expect(days).toEqual([[19, '300000.00'], [20, '300000.00'], [18, '300000.00']]);

    const leave = await abs.create(ctx, e.contractId, { kind: 'ANNUAL_LEAVE', dateFrom: '2026-04-06', days: 14 });
    expect([leave.dateTo.toISOString().slice(0, 10), leave.calendarDays, leave.workDays]).toEqual(['2026-04-19', 14, 10]);
    const ok = await abs.approve(ctx, leave.id);
    expect([ok.avgDailyWage.toFixed(2), ok.amount.toFixed(2), ok.payPeriod]).toEqual(['15789.47', '157894.70', '2026-04']);
    // Пересечение и отмена.
    const dup = await abs.create(ctx, e.contractId, { kind: 'UNPAID_LEAVE', dateFrom: '2026-04-15', dateTo: '2026-04-20' });
    expect(await code(abs.approve(ctx, dup.id))).toBe('ABSENCE_OVERLAP');
    expect(await code(abs.create(ctx, e.contractId, { kind: 'SICK', dateFrom: '2026-05-04', dateTo: '2026-05-08' }))).toBe('DOCUMENT_REQUIRED');

    await payroll.calculate(ctx, '2026-04');
    const apr = await prisma.payrollResult.findFirstOrThrow({ where: { contractId: e.contractId, period: new Date('2026-04-01') } });
    expect([apr.normDays, Number(apr.workedDays), apr.baseAccrued.toFixed(2), apr.absencePay.toFixed(2), apr.totalGrossSalary.toFixed(2)]).toEqual([22, 12, '163636.36', '157894.70', '321531.06']);
    await payroll.approve(ctx, '2026-04');
    // Утверждённый месяц — отпуск не отменить.
    expect(await code(abs.cancel(ctx, leave.id, 'Перенос отпуска'))).toBe('PAYROLL_CLOSED');

    const sick = await abs.create(ctx, e.contractId, { kind: 'SICK', dateFrom: '2026-05-04', dateTo: '2026-05-08', documentNumber: 'ЛН-123' });
    expect(sick.workDays).toBe(4);
    const sk = await abs.approve(ctx, sick.id);
    expect([sk.avgDailyWage.toFixed(2), sk.amount.toFixed(2), sk.payPeriod]).toEqual(['15415.02', '61660.08', '2026-05']);
    // Отмена — с причиной; БД не даёт поменять утверждённое иначе.
    expect(String(await code(prisma.hrAbsence.update({ where: { id: sk.id }, data: { amount: 1 } })))).toMatch(/ACC_IMMUTABLE/);
    expect(await code(abs.cancel(ctx, sk.id, 'нет'))).toBe('REASON_REQUIRED');
    expect((await abs.cancel(ctx, sk.id, 'Лист аннулирован') as any).status).toBe('CANCELLED');
  });

  it('больничный: лимит 25 МРП в месяц; компенсация неиспользованного отпуска при увольнении', async () => {
    const ctx = await makeOrg(prisma, 'owner');
    const dept = await prisma.department.create({ data: { organizationId: ctx.organizationId, name: 'Офис', kind: 'OFFICE', costAccount: '7030' } });
    const big = await payroll.hire(ctx, { iin: iin(), lastName: 'Директор', firstName: 'Большой', birthDate: '1980-01-01', hireDate: '2026-06-01', departmentId: dept.id, salary: '2200000' });
    const sick = await abs.create(ctx, big.contractId, { kind: 'SICK', dateFrom: '2026-06-01', dateTo: '2026-06-12', documentNumber: 'ЛН-9' });
    const sk = await abs.approve(ctx, sick.id);
    expect([sk.avgDailyWage.toFixed(2), sk.workDays, sk.amount.toFixed(2)]).toEqual(['100000.00', 10, '108125.00']);
    expect((sk.calc as any).byMonth[0]).toMatchObject({ capped: true, limit: '108125.00' });
    // Средний — только по утверждённым месяцам: черновик июня не берётся, считается от оклада августа (210 000 / 21).
    const mid = await payroll.hire(ctx, { iin: iin(), lastName: 'Средний', firstName: 'Сотрудник', birthDate: '1991-01-01', hireDate: '2026-06-01', departmentId: dept.id, salary: '210000' });
    await payroll.calculate(ctx, '2026-06');
    const s2 = await abs.approve(ctx, (await abs.create(ctx, mid.contractId, { kind: 'SICK', dateFrom: '2026-08-03', dateTo: '2026-08-04', documentNumber: 'ЛН-10' })).id);
    expect([s2.avgDailyWage.toFixed(2), s2.amount.toFixed(2), (s2.calc as any).average.method]).toEqual(['10000.00', '20000.00', 'SALARY']);

    const leaver = await payroll.hire(ctx, { iin: iin(), lastName: 'Уходит', firstName: 'Сотрудник', birthDate: '1990-01-01', hireDate: '2026-01-05', departmentId: dept.id, salary: '220000' });
    expect(await code(abs.compensation(ctx, leaver.contractId))).toBe('NOT_TERMINATED');
    await payroll.terminate(ctx, leaver.contractId, { date: '2026-07-04' });
    expect(await abs.leaveBalance(ctx, leaver.contractId, '2026-07-04')).toMatchObject({ monthsWorked: 6, entitled: '12.00', used: 0, balance: '12.00' });
    const comp = await abs.compensation(ctx, leaver.contractId);
    expect([comp.dateFrom.toISOString().slice(0, 10), comp.dateTo.toISOString().slice(0, 10), comp.workDays, comp.avgDailyWage.toFixed(2), comp.amount.toFixed(2), comp.payPeriod]).toEqual(['2026-07-05', '2026-07-17', 9, '10000.00', '90000.00', '2026-07']);
    expect(await code(abs.compensation(ctx, leaver.contractId))).toBe('COMPENSATION_EXISTS');
    // В расчёте июля компенсация входит в начисления, дни после увольнения оклад не уменьшают.
    await payroll.calculate(ctx, '2026-07');
    const jul = await prisma.payrollResult.findFirstOrThrow({ where: { contractId: leaver.contractId, period: new Date('2026-07-01') } });
    expect(jul.absencePay.toFixed(2)).toBe('90000.00');
  });
});
