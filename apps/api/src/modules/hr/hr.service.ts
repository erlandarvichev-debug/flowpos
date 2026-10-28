import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class HrService {
  constructor(private prisma: PrismaService) {}

  async findEmployees(query: { search?: string; isActive?: boolean; page?: number; limit?: number }) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 50;
    const skip = (page - 1) * limit;
    const where: any = {};
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
    return { employees, total, page, limit };
  }

  async findEmployee(id: string) {
    const emp = await this.prisma.employee.findUnique({
      where: { id },
      include: { timeEvents: { orderBy: { ts: 'desc' }, take: 30 } },
    });
    if (!emp) throw new NotFoundException('Сотрудник не найден');
    return emp;
  }

  async createEmployee(data: any) {
    return this.prisma.employee.create({ data });
  }

  async updateEmployee(id: string, data: any) {
    await this.findEmployee(id);
    return this.prisma.employee.update({ where: { id }, data });
  }

  async checkIn(employeeId: string) {
    return this.prisma.timeEvent.create({
      data: { employeeId, type: 'IN', ts: new Date() },
    });
  }

  async checkOut(employeeId: string) {
    return this.prisma.timeEvent.create({
      data: { employeeId, type: 'OUT', ts: new Date() },
    });
  }

  async getTimeRecords(employeeId: string, from?: string, to?: string) {
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

  async findShiftTemplates() {
    return this.prisma.workSchedule.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } });
  }

  async createShiftTemplate(data: any) {
    return this.prisma.workSchedule.create({ data });
  }

  async getSchedule(from: string, to: string, storeId?: string) {
    const where: any = {
      date: { gte: new Date(from), lte: new Date(to) },
    };
    if (storeId) where.storeId = storeId;
    return this.prisma.shiftPlan.findMany({
      where,
      include: { workSchedule: true },
      orderBy: [{ date: 'asc' }],
    });
  }

  async assignShift(data: any) {
    return this.prisma.shiftPlan.create({ data });
  }

  async updateShiftAssignment(id: string, data: any) {
    return this.prisma.shiftPlan.update({ where: { id }, data });
  }

  async getTimesheet(month: number, year: number) {
    let timesheet = await this.prisma.timeSheet.findUnique({
      where: { month_year: { month, year } },
      include: { rows: true },
    });

    if (!timesheet) {
      timesheet = await this.prisma.timeSheet.create({
        data: { month, year },
        include: { rows: true },
      });
    }

    return timesheet;
  }

  async calculateTimesheet(month: number, year: number) {
    const start = new Date(year, month - 1, 1);
    const end = new Date(year, month, 0, 23, 59, 59);

    const employees = await this.prisma.employee.findMany({ where: { isActive: true } });
    const timesheet = await this.getTimesheet(month, year);

    for (const employee of employees) {
      const events = await this.prisma.timeEvent.findMany({
        where: { employeeId: employee.id, ts: { gte: start, lte: end }, type: 'IN' },
      });

      const daysWorked = events.length;
      const hoursWorked = daysWorked * 8;

      await this.prisma.timeSheetRow.upsert({
        where: { timeSheetId_employeeId: { timeSheetId: timesheet.id, employeeId: employee.id } },
        create: { timeSheetId: timesheet.id, employeeId: employee.id, daysWorked, hoursWorked },
        update: { daysWorked, hoursWorked },
      });
    }

    return this.getTimesheet(month, year);
  }

  async getPayrolls(query: { month?: number; year?: number; employeeId?: string }) {
    const where: any = {};
    if (query.month) where.month = query.month;
    if (query.year) where.year = query.year;
    if (query.employeeId) where.employeeId = query.employeeId;
    return this.prisma.payroll.findMany({
      where,
      include: { employee: true },
      orderBy: [{ year: 'desc' }, { month: 'desc' }],
    });
  }

  async createPayroll(data: any) {
    return this.prisma.payroll.create({
      data,
      include: { employee: true },
    });
  }
}
