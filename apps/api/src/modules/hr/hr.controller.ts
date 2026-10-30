import { Controller, Get, Post, Put, Param, Body, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { OrgGuard, RequirePermission } from '../accounting/access/org-context';
import { CurrentScope, Scope } from '../../common/scope';
import { HrService } from './hr.service';

@ApiTags('hr')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard)
@Controller('hr')
export class HrController {
  constructor(private hr: HrService) {}

  @Get('employees')
  @RequirePermission('hr.read')
  findEmployees(@CurrentScope() s: Scope, @Query() query: any) {
    return this.hr.findEmployees(s, query);
  }

  @Get('employees/:id')
  @RequirePermission('hr.read')
  findEmployee(@CurrentScope() s: Scope, @Param('id') id: string) {
    return this.hr.findEmployee(s, id);
  }

  @Post('employees')
  @RequirePermission('hr.manage')
  createEmployee(@CurrentScope() s: Scope, @Body() body: any) {
    return this.hr.createEmployee(s, body);
  }

  @Put('employees/:id')
  @RequirePermission('hr.manage')
  updateEmployee(@CurrentScope() s: Scope, @Param('id') id: string, @Body() body: any) {
    return this.hr.updateEmployee(s, id, body);
  }

  @Post('employees/:id/check-in')
  @RequirePermission('hr.manage')
  checkIn(@CurrentScope() s: Scope, @Param('id') id: string) {
    return this.hr.checkIn(s, id);
  }

  @Post('employees/:id/check-out')
  @RequirePermission('hr.manage')
  checkOut(@CurrentScope() s: Scope, @Param('id') id: string) {
    return this.hr.checkOut(s, id);
  }

  @Get('employees/:id/time-records')
  @RequirePermission('hr.read')
  getTimeRecords(@CurrentScope() s: Scope, @Param('id') id: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.hr.getTimeRecords(s, id, from, to);
  }

  @Get('shift-templates')
  @RequirePermission('hr.read')
  findShiftTemplates(@CurrentScope() s: Scope) {
    return this.hr.findShiftTemplates(s);
  }

  @Post('shift-templates')
  @RequirePermission('hr.manage')
  createShiftTemplate(@CurrentScope() s: Scope, @Body() body: any) {
    return this.hr.createShiftTemplate(s, body);
  }

  @Get('schedule')
  @RequirePermission('hr.read')
  getSchedule(@CurrentScope() s: Scope, @Query('from') from: string, @Query('to') to: string, @Query('employeeId') employeeId?: string) {
    return this.hr.getSchedule(s, from, to, employeeId);
  }

  @Post('schedule')
  @RequirePermission('hr.manage')
  assignShift(@CurrentScope() s: Scope, @Body() body: any) {
    return this.hr.assignShift(s, body);
  }

  @Put('schedule/:id')
  @RequirePermission('hr.manage')
  updateShift(@CurrentScope() s: Scope, @Param('id') id: string, @Body() body: any) {
    return this.hr.updateShiftAssignment(s, id, body);
  }

  @Get('timesheet')
  @RequirePermission('hr.read')
  getTimesheet(@CurrentScope() s: Scope, @Query('month') month: string, @Query('year') year: string) {
    return this.hr.getTimesheet(s, parseInt(month), parseInt(year));
  }

  @Post('timesheet/calculate')
  @RequirePermission('hr.manage')
  calculateTimesheet(@CurrentScope() s: Scope, @Body() body: { month: number; year: number }) {
    return this.hr.calculateTimesheet(s, body.month, body.year);
  }

  @Get('payrolls')
  @RequirePermission('payroll.read')
  getPayrolls(@CurrentScope() s: Scope, @Query() query: any) {
    return this.hr.getPayrolls(s, query);
  }

  @Post('payrolls')
  @RequirePermission('payroll.approve')
  createPayroll(@CurrentScope() s: Scope, @Body() body: any) {
    return this.hr.createPayroll(s, body);
  }
}
