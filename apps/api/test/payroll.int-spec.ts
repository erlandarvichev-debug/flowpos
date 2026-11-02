// Зарплата: приём → расчёт месяца → утверждение (проводки) → листки и ведомость. Эталон октября 2026 — вручную:
// норма 21 день (22 будних − 26.10). A: 500 000 полный месяц → ОПВ 50 000, ВОСМС 10 000, ИПН 31 025, на руки 408 975,
// СО 22 500, ООСМС 15 000, ОПВР 17 500, СН 26 400. B: принят 15.10, оклад 210 000, 11 дней → 110 000: ОПВ 11 000,
// ВОСМС 2 200, вычет 96 800 → ИПН 0, на руки 96 800, СО 4 950, ООСМС 3 300, ОПВР 3 850, СН (месяц найма) 5 808.
import { PrismaService } from '../src/prisma/prisma.service';
import { PayrollService } from '../src/modules/accounting/payroll/payroll.service';
import { PeriodsService } from '../src/modules/accounting/periods/periods.service';
import { PrintService } from '../src/modules/accounting/print/print.service';
import { render } from '../src/modules/accounting/print/engine';
import { BUILTIN_TEMPLATES } from '../src/modules/accounting/print/templates';
import { makeOrg, makeServices } from './accounting-helpers';
import { runtimeDatabaseUrl } from './http-app';
import { runAsTenant } from '../src/common/db-context';
import { RefsService } from '../src/modules/accounting/refs/refs.service';

const prisma = new PrismaService();
const s = makeServices(prisma);
const payroll = new PayrollService(prisma, s.posting, new PeriodsService(prisma), s.docs);
const print = new PrintService(prisma);
afterAll(() => prisma.$disconnect());
const iin = () => String(Math.floor(1e11 + Math.random() * 8.9e11));
async function code(p: Promise<unknown>) {
  try { await p; return 'OK'; } catch (e: any) { return e?.getResponse?.()?.code ?? e?.message; }
}

describe('Зарплата за месяц', () => {
  it('эталон октября 2026: расчёт, проводки утверждения, отмена с причиной, листки и ведомость', async () => {
    const ctx = await makeOrg(prisma, 'owner');
    const dept = await prisma.department.create({ data: { organizationId: ctx.organizationId, name: 'Офис', kind: 'OFFICE', costAccount: '7030' } });
    const a = await payroll.hire(ctx, { iin: iin(), lastName: 'Ахметов', firstName: 'Ерлан', birthDate: '1990-05-01', hireDate: '2026-01-10', departmentId: dept.id, salary: '500000' });
    const b = await payroll.hire(ctx, { iin: iin(), lastName: 'Сериккызы', firstName: 'Айгерим', birthDate: '1995-02-02', hireDate: '2026-10-15', departmentId: dept.id, salary: '210000' });
    expect(await code(payroll.hire(ctx, { iin: '123', lastName: 'Х', firstName: 'Х', birthDate: '1990-01-01', hireDate: '2026-10-01', departmentId: dept.id, salary: '1' }))).toBe('BAD_IIN');

    await payroll.calculate(ctx, '2026-10');
    const p = await payroll.get(ctx, '2026-10');
    const row = (id: string) => p.results.find((r: any) => r.contractId === id) as any;
    const pick = (r: any) => [r.normDays, Number(r.workedDays), r.totalGrossSalary, r.opvAmount, r.vosmsAmount, r.ipnAmount, r.netSalaryToPay, r.soAmount, r.oosmsAmount, r.opvrAmount, r.snAmount].map(String);
    expect(pick(row(a.contractId))).toEqual(['21', '21', '500000', '50000', '10000', '31025', '408975', '22500', '15000', '17500', '26400']);
    expect(pick(row(b.contractId))).toEqual(['21', '11', '110000', '11000', '2200', '0', '96800', '4950', '3300', '3850', '5808']);

    // Утверждение: проводки; на 3350 остаётся к выплате 505 775.
    await payroll.approve(ctx, '2026-10');
    const ps = await prisma.accPosting.findMany({ where: { organizationId: ctx.organizationId, isActive: true, entry: { sourceType: 'PAYROLL', status: 'ACTIVE' } }, include: { account: { select: { code: true } } } });
    const bal = (code: string) => ps.filter((x) => x.account.code === code).reduce((s2, x) => s2 + (x.side === 'C' ? 1 : -1) * Number(x.amount), 0);
    expect([bal('3350'), bal('3220'), bal('3230'), bal('3120'), bal('3210'), bal('3250'), bal('3150'), -bal('7030')]).toEqual([505775, 61000, 12200 + 18300, 31025, 27450, 21350, 32208, 610000 + 27450 + 18300 + 21350 + 32208]);
    expect(await code(payroll.calculate(ctx, '2026-10'))).toBe('PAYROLL_CLOSED');

    // Листки и ведомость.
    const d: any = await print.data(ctx, 'PAYSLIP', '2026-10');
    expect([d.periodTitle, d.employees.length, d.totals.net, d.totalWords]).toEqual(['октябрь 2026 года', 2, '505775.00', 'Пятьсот пять тысяч семьсот семьдесят пять тенге 00 тиын']);
    const slip = render(BUILTIN_TEMPLATES.find((x) => x.id === 'builtin:PAYSLIP')!.html, d);
    expect(slip).toContain('Ахметов Ерлан');
    expect(slip).toContain('408 975,00');
    expect(slip).toContain('Отработано дней: 11 из 21');
    expect(render(BUILTIN_TEMPLATES.find((x) => x.id === 'builtin:PAYROLL_SHEET')!.html, d)).toContain('Платёжная ведомость № 202610');
    expect(await code(print.data(ctx, 'PAYSLIP', '2026-09'))).toBe('NOT_FOUND');

    // Отмена утверждения — с причиной; проводки снимаются.
    expect(await code(payroll.unapprove(ctx, '2026-10', ''))).not.toBe('OK');
    await payroll.unapprove(ctx, '2026-10', 'Забыли премию');
    expect(await prisma.accPosting.count({ where: { organizationId: ctx.organizationId, isActive: true, entry: { sourceType: 'PAYROLL', status: 'ACTIVE' } } })).toBe(0);
  });

  it('рабочая роль (RLS): общий календарь заполняется, расчёт проходит; подразделения — списком', async () => {
    const ctx = await makeOrg(prisma, 'owner');
    const dept = await prisma.department.create({ data: { organizationId: ctx.organizationId, name: 'Склад', kind: 'WAREHOUSE', costAccount: '7020' } });
    await payroll.hire(ctx, { iin: iin(), lastName: 'Тест', firstName: 'Тест', birthDate: '1990-01-01', hireDate: '2026-01-05', departmentId: dept.id, salary: '300000' });
    // Как в работе: под рабочей ролью без BYPASSRLS, календарь года ещё не заполнен.
    await prisma.hrCalendarDay.deleteMany({ where: { organizationId: null, date: { gte: new Date('2026-01-01'), lte: new Date('2026-12-31') } } });
    PrismaService.nextUrl = runtimeDatabaseUrl();
    const app = new PrismaService();
    try {
      const rt = new PayrollService(app, s.posting, new PeriodsService(app), s.docs);
      const r = await runAsTenant(ctx.tenantId, () => rt.calculate(ctx, '2026-03'));
      expect(r).toMatchObject({ status: 'CALCULATED', results: 1, normDays: 18 }); // март 2026: 22 будних − праздники 9, 23, 24, 25.03
      expect((await runAsTenant(ctx.tenantId, () => new RefsService(app).list(ctx, 'department' as any))).map((d: any) => d.name)).toEqual(['Склад']);
    } finally { await app.$disconnect(); }
  });
});
