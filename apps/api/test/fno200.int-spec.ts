// 200.00 за IV кв. 2026 из утверждённых расчётов зарплаты — эталон test/golden/fno-200-2026-q4.json (вручную).
import { readFileSync } from 'fs';
import { join } from 'path';
import { PrismaService } from '../src/prisma/prisma.service';
import { PayrollService } from '../src/modules/accounting/payroll/payroll.service';
import { PeriodsService } from '../src/modules/accounting/periods/periods.service';
import { TaxService } from '../src/modules/accounting/tax/tax.service';
import { DeclarationsService } from '../src/modules/accounting/tax/declarations.service';
import { KZ_2026_1 } from '../src/modules/accounting/tax/rule-packs';
import { makeOrg, makeServices } from './accounting-helpers';

const prisma = new PrismaService();
const s = makeServices(prisma);
const payroll = new PayrollService(prisma, s.posting, new PeriodsService(prisma), s.docs);
const tax = new TaxService(prisma, s.autopilot);
const decl = new DeclarationsService(prisma, tax);
const golden = JSON.parse(readFileSync(join(__dirname, 'golden/fno-200-2026-q4.json'), 'utf8'));
const iin = () => String(Math.floor(1e11 + Math.random() * 8.9e11));
afterAll(() => prisma.$disconnect());
async function code(p: Promise<unknown>) {
  try { await p; return 'OK'; } catch (e: any) { return e?.getResponse?.()?.code ?? e?.message; }
}

describe('FP-054: 200.00', () => {
  it('эталон IV квартала: ИПН, ОПВ, СН, СО, ОСМС, ОПВР по месяцам и итого; неутверждённый месяц — ошибка', async () => {
    const ctx = await makeOrg(prisma, 'owner');
    const pack = (await tax.packs(ctx)).find((p) => p.code === 'KZ' && p.version === '2026.1')!;
    await tax.adopt(ctx, pack.id, { acknowledged: KZ_2026_1.unverified.map((u) => u.key) });
    const dept = await prisma.department.create({ data: { organizationId: ctx.organizationId, name: 'Офис', kind: 'OFFICE', costAccount: '7030' } });
    await payroll.hire(ctx, { iin: iin(), lastName: 'Ахметов', firstName: 'Ерлан', birthDate: '1990-05-01', hireDate: '2026-01-10', departmentId: dept.id, salary: '500000' });
    await payroll.hire(ctx, { iin: iin(), lastName: 'Сериккызы', firstName: 'Айгерим', birthDate: '1995-02-02', hireDate: '2026-10-15', departmentId: dept.id, salary: '210000' });
    for (const p of ['2026-10', '2026-11']) { await payroll.calculate(ctx, p); await payroll.approve(ctx, p); }
    const draft = await tax.buildPayroll(ctx, 2026, 'Q4');
    expect((draft.data as any).issues.filter((i: any) => i.severity === 'ERROR').map((i: any) => i.code)).toEqual(['PAYROLL_NOT_APPROVED']);
    expect(await code(tax.fix(ctx, draft.id, {}))).toBe('REGISTER_HAS_ERRORS');
    await payroll.calculate(ctx, '2026-12'); await payroll.approve(ctx, '2026-12');
    const reg = await tax.buildPayroll(ctx, 2026, 'Q4');
    await tax.fix(ctx, reg.id, {});
    const d = await decl.build(ctx, { form: '200.00', year: 2026, period: 'Q4' });
    const got = Object.fromEntries((d.lines as any[]).map((l) => [l.code, l.value]));
    for (const [k, v] of Object.entries(golden.lines)) expect([k, got[k]]).toEqual([k, v]);
    expect((d.checks as any[]).filter((c) => !c.ok && c.severity === 'ERROR')).toEqual([]);
    expect((await decl.finalize(ctx, d.id)).status).toBe('FINAL');
  });
});
