import { Controller, Get, Post, Put, Param, Body, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentScope, Scope } from '../../common/scope';
import { HrService } from './hr.service';

@ApiTags('hr')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('hr')
export class HrController {
  constructor(private hr: HrService) {}

  @Get('employees')
  findEmployees(@CurrentScope() s: Scope, @Query() query: any) {
    return this.hr.findEmployees(s, query);
  }

  @Get('employees/:id')
  findEmployee(@CurrentScope() s: Scope, @Param('id') id: string) {
    return this.hr.findEmployee(s, id);
  }

  @Post('employees')
  createEmployee(@CurrentScope() s: Scope, @Body() body: any) {
    return this.hr.createEmployee(s, body);
  }

  @Put('employees/:id')
  updateEmployee(@CurrentScope() s: Scope, @Param('id') id: string, @Body() body: any) {
    return this.hr.updateEmployee(s, id, body);
  }

  @Post('employees/:id/check-in')
  checkIn(@CurrentScope() s: Scope, @Param('id') id: string) {
    return this.hr.checkIn(s, id);
  }

  @Post('employees/:id/check-out')
  checkOut(@CurrentScope() s: Scope, @Param('id') id: string) {
    return this.hr.checkOut(s, id);
  }

  @Get('employees/:id/time-records')
  getTimeRecords(@CurrentScope() s: Scope, @Param('id') id: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.hr.getTimeRecords(s, id, from, to);
  }

  @Get('shift-templates')
  findShiftTemplates(@CurrentScope() s: Scope) {
    return this.hr.findShiftTemplates(s);
  }

  @Post('shift-templates')
  createShiftTemplate(@CurrentScope() s: Scope, @Body() body: any) {
    return this.hr.createShiftTemplate(s, body);
  }

  @Get('schedule')
  getSchedule(@CurrentScope() s: Scope, @Query('from') from: string, @Query('to') to: string, @Query('employeeId') employeeId?: string) {
    return this.hr.getSchedule(s, from, to, employeeId);
  }

  @Post('schedule')
  assignShift(@CurrentScope() s: Scope, @Body() body: any) {
    return this.hr.assignShift(s, body);
  }

  @Put('schedule/:id')
  updateShift(@CurrentScope() s: Scope, @Param('id') id: string, @Body() body: any) {
    return this.hr.updateShiftAssignment(s, id, body);
  }

  @Get('timesheet')
  getTimesheet(@CurrentScope() s: Scope, @Query('month') month: string, @Query('year') year: string) {
    return this.hr.getTimesheet(s, parseInt(month), parseInt(year));
  }

  @Post('timesheet/calculate')
  calculateTimesheet(@CurrentScope() s: Scope, @Body() body: { month: number; year: number }) {
    return this.hr.calculateTimesheet(s, body.month, body.year);
  }

  @Get('payrolls')
  getPayrolls(@CurrentScope() s: Scope, @Query() query: any) {
    return this.hr.getPayrolls(s, query);
  }

  @Post('payrolls')
  createPayroll(@CurrentScope() s: Scope, @Body() body: any) {
    return this.hr.createPayroll(s, body);
  }
}
