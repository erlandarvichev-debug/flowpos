import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { Scope, scopeError, writable } from '../../common/scope';
import { payView } from '../../common/pay-fields';
import { hasPermission } from '../accounting/access/roles';

const own = (s: Scope) => ({ organizationId: s.organizationId });
/** Оклад и ставка сотрудника — только с payroll.read (FP-008). */
const pay = <T>(s: Scope, v: T) => payView(v, !!s.role && hasPermission(s.role, 'payroll.read'));

/** Кадры старого модуля: сотрудники, отметки, графики, табель, начисления — только своей организации (FP-007). */
@Injectable()
export class HrService {
  constructor(private prisma: PrismaService) {}

  async findEmployees(s: Scope, query: { search?: string; isActive?: boolean; page?: number; limit?: number }) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 50;
    const skip = (page - 1) * limit;
    const where: Prisma.EmployeeWhereInput = { ...own(s) };
    if (query.isActive !== undefined) where.isActive = query.isActive;
    if (query.search) {
      where.OR = [
        { firstName: { contains: query.search, mode: 'insensitive' } },
        { lastName: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    const [employees, total] = await Promise.all([
      this.prisma.employee.findMany({
        where, skip, take: limit,
        include: { position: true, department: true },
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      }),
      this.prisma.employee.count({ where }),
    ]);
    return { employees: pay(s, employees), total, page, limit };
  }

  async findEmployee(s: Scope, id: string) {
    const emp = await this.prisma.employee.findFirst({
      where: { id, ...own(s) },
      include: { timeEvents: { orderBy: { ts: 'desc' }, take: 30 } },
    });
    if (!emp) throw new NotFoundException('Сотрудник не найден');
    return pay(s, emp);
  }

  /** Пользователь, привязанный к сотруднику, — только своей организации. */
  private async assertUser(s: Scope, userId?: string | null) {
    if (userId && !(await this.prisma.user.findFirst({ where: { id: userId, ...own(s) }, select: { id: true } }))) {
      throw new BadRequestException({ code: 'REF_FOREIGN', message: 'Указан пользователь, которого нет в этой организации' });
    }
  }

  async createEmployee(s: Scope, body: any) {
    const { data } = writable(body, s);
    await this.assertUser(s, (data as any).userId);
    return pay(s, await this.prisma.employee.create({ data: { ...(data as any), ...own(s) } }).catch(scopeError));
  }

  async updateEmployee(s: Scope, id: string, body: any) {
    await this.findEmployee(s, id);
    const { data } = writable(body, s);
    await this.assertUser(s, (data as any).userId);
    return pay(s, await this.prisma.employee.update({ where: { id }, data: data as any }).catch(scopeError));
  }

  async checkIn(s: Scope, employeeId: string) {
    await this.findEmployee(s, employeeId);
    return this.prisma.timeEvent.create({
      data: { employeeId, type: 'IN', ts: new Date() },
    });
  }

  async checkOut(s: Scope, employeeId: string) {
    await this.findEmployee(s, employeeId);
    return this.prisma.timeEvent.create({
      data: { employeeId, type: 'OUT', ts: new Date() },
    });
  }

  async getTimeRecords(s: Scope, employeeId: string, from?: string, to?: string) {
    await this.findEmployee(s, employeeId);
    const where: any = { employeeId };
    if (from || to) {
      where.ts = {};
      if (from) where.ts.gte = new Date(from);
      if (to) where.ts.lte = new Date(to);
    }
    return this.prisma.timeEvent.findMany({
      where,
      orderBy: { ts: 'asc' },
    });
  }

  async findShiftTemplates(s: Scope) {
    return this.prisma.workSchedule.findMany({ where: { ...own(s), isActive: true }, orderBy: { name: 'asc' } });
  }

  async createShiftTemplate(s: Scope, body: any) {
    const { data } = writable(body, s);
    return this.prisma.workSchedule.create({ data: { ...(data as any), ...own(s) } }).catch(scopeError);
  }

  async getSchedule(s: Scope, from: string, to: string, storeId?: string) {
    const where: Prisma.ShiftPlanWhereInput = {
      ...own(s),
      date: { gte: new Date(from), lte: new Date(to) },
    };
    if (storeId) where.storeId = storeId;
    return this.prisma.shiftPlan.findMany({
      where,
      include: { workSchedule: true },
      orderBy: [{ date: 'asc' }],
    });
  }

  async assignShift(s: Scope, body: any) {
    const { data } = writable(body, s);
    return this.prisma.shiftPlan.create({ data: { ...(data as any), ...own(s) } }).catch(scopeError);
  }

  async updateShiftAssignment(s: Scope, id: string, body: any) {
    if (!(await this.prisma.shiftPlan.findFirst({ where: { id, ...own(s) }, select: { id: true } }))) throw new NotFoundException('Смена не найдена');
    const { data } = writable(body, s);
    return this.prisma.shiftPlan.update({ where: { id }, data: data as any }).catch(scopeError);
  }

  async getTimesheet(s: Scope, month: number, year: number) {
    const key = { organizationId_month_year: { organizationId: s.organizationId, month, year } };
    let timesheet = await this.prisma.timeSheet.findUnique({
      where: key,
      include: { rows: true },
    });

    if (!timesheet) {
      timesheet = await this.prisma.timeSheet.create({
        data: { ...own(s), month, year },
        include: { rows: true },
      });
    }

    return timesheet;
  }

  async calculateTimesheet(s: Scope, month: number, year: number) {
    const start = new Date(year, month - 1, 1);
    const end = new Date(year, month, 0, 23, 59, 59);

    const employees = await this.prisma.employee.findMany({ where: { ...own(s), isActive: true } });
    const timesheet = await this.getTimesheet(s, month, year);

    for (const employee of employees) {
      const events = await this.prisma.timeEvent.findMany({
        where: { employeeId: employee.id, ts: { gte: start, lte: end }, type: 'IN' },
      });

      const daysWorked = events.length;
      const hoursWorked = daysWorked * 8;

      await this.prisma.timeSheetRow.upsert({
        where: { timeSheetId_employeeId: { timeSheetId: timesheet.id, employeeId: employee.id } },
        create: { timeSheetId: timesheet.id, employeeId: employee.id, ...own(s), daysWorked, hoursWorked },
        update: { daysWorked, hoursWorked },
      });
    }

    return this.getTimesheet(s, month, year);
  }

  async getPayrolls(s: Scope, query: { month?: number; year?: number; employeeId?: string }) {
    const where: Prisma.PayrollWhereInput = { employee: own(s) };
    if (query.month) where.month = Number(query.month);
    if (query.year) where.year = Number(query.year);
    if (query.employeeId) where.employeeId = query.employeeId;
    return this.prisma.payroll.findMany({
      where,
      include: { employee: true },
      orderBy: [{ year: 'desc' }, { month: 'desc' }],
    });
  }

  async createPayroll(s: Scope, body: any) {
    const { data } = writable(body, s);
    await this.findEmployee(s, (data as any).employeeId);
    return this.prisma.payroll.create({
      data: data as any,
      include: { employee: true },
    }).catch(scopeError);
  }
}
