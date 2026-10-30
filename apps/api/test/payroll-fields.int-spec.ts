// FP-008 приёмка «field-level payroll permissions»: оклад, суммы и реквизиты выплаты видны только с правом
// payroll.read; право на справочник сотрудников (кадровик) или на журнал аудита (аудитор) их не открывает.
import { DEFAULT_TENANT, defaultTenant } from './accounting-helpers';
import { HttpApp, call, login, makeUser, startApp, uid } from './http-app';

let h: HttpApp;
let org: string;
const tok: Record<string, string> = {};
const as = (who: string, method: string, path: string, body?: unknown) => call(h, method, path, { token: tok[who], body, headers: { 'idempotency-key': uid() } });

beforeAll(async () => {
  h = await startApp();
  await defaultTenant(h.prisma);
  const chart = await h.prisma.accChart.findFirstOrThrow({ where: { code: 'KZ-TYPICAL' } });
  org = (await h.prisma.organization.create({ data: { tenantId: DEFAULT_TENANT, name: `Зарплата ${uid()}` } })).id;
  await h.prisma.accPolicy.create({ data: { organizationId: org, validFrom: new Date('2020-01-01'), chartId: chart.id } });
  for (const role of ['hr', 'accountant', 'auditor', 'manager']) {
    const u = await makeUser(h, DEFAULT_TENANT, org, { name: role, role });
    tok[role] = (await login(h, u.email)).token;
  }
}, 60_000);
afterAll(async () => h?.app.close());

describe('FP-008: поля зарплаты — только с payroll.read', () => {
  it('кадровик принимает на работу с окладом, но оклада и IBAN в списке не видит; бухгалтер видит', async () => {
    const dept = await h.prisma.department.create({ data: { organizationId: org, name: 'Офис' } });
    const iin = `9001013${String(Date.now()).slice(-5)}`;
    const iban = `KZ${String(Date.now()).padStart(18, '0')}`;
    const hire = await as('hr', 'POST', '/accounting/hr/hire', {
      iin, lastName: 'Секретов', firstName: 'Оклад', birthDate: '1990-01-01', hireDate: '2026-10-01',
      departmentId: dept.id, salary: '750000', iban,
    });
    expect([hire.status, hire.status === 201 ? '' : hire.text]).toEqual([201, '']);
    expect(hire.text).not.toContain('750000');

    const forHr = (await as('hr', 'GET', '/accounting/hr/employees')).body.find((e: any) => e.iin === iin);
    expect([forHr.name, forHr.salary, forHr.iban]).toEqual(['Секретов Оклад', null, null]);
    const forAcc = (await as('accountant', 'GET', '/accounting/hr/employees')).body.find((e: any) => e.iin === iin);
    expect([forAcc.salary, forAcc.iban]).toEqual(['750000.00', iban]);
    // Руководитель: hr.read есть, payroll.read — нет.
    expect((await as('manager', 'GET', '/accounting/hr/employees')).body.find((e: any) => e.iin === iin).salary).toBeNull();
  });

  it('ведомость, расчёт и выплата — только с payroll.read', async () => {
    expect((await as('hr', 'GET', '/accounting/payroll/2026-10')).status).toBe(403);
    expect((await as('hr', 'POST', '/accounting/payroll/2026-10/calculate', {})).status).toBe(403);
    expect((await as('hr', 'GET', '/accounting/payroll/2026-10/payout')).status).toBe(403);
    expect((await as('manager', 'GET', '/accounting/payroll/2026-10')).status).toBe(403);
    expect((await as('accountant', 'GET', '/accounting/payroll/2026-10')).status).toBe(200);
  });

  it('журнал аудита: аудитор видит запись о приёме, но без оклада; бухгалтер — с окладом', async () => {
    const forAuditor = (await as('auditor', 'GET', '/accounting/audit?entity=employment_contract')).body.find((r: any) => r.action === 'HR_HIRE');
    expect(forAuditor.after.iin).toBeTruthy();
    expect(forAuditor.after.salary).toBeNull();
    expect(JSON.stringify(forAuditor)).not.toContain('750000');
    // У бухгалтера нет acc.audit.read — проверяем через роль с обоими правами: владелец видит сумму.
    const owner = await makeUser(h, DEFAULT_TENANT, org, { name: 'owner', role: 'owner' });
    tok.owner = (await login(h, owner.email)).token;
    const forOwner = (await as('owner', 'GET', '/accounting/audit?entity=employment_contract')).body.find((r: any) => r.action === 'HR_HIRE');
    expect(forOwner.after.salary).toBe('750000.00');
  });

  it('старый модуль кадров: оклад сотрудника скрыт без payroll.read', async () => {
    const emp = await h.prisma.employee.create({ data: { organizationId: org, firstName: 'Ставка', lastName: `Л-${uid()}`, salary: 333000, hourlyRate: 2000 } });
    const forHr = await as('hr', 'GET', `/hr/employees/${emp.id}`);
    expect([forHr.status, forHr.body.salary, forHr.body.hourlyRate]).toEqual([200, null, null]);
    const list = (await as('hr', 'GET', '/hr/employees?limit=500')).body.employees.find((e: any) => e.id === emp.id);
    expect(list.salary).toBeNull();
    expect(Number((await as('accountant', 'GET', `/hr/employees/${emp.id}`)).body.salary)).toBe(333000);
  });
});
