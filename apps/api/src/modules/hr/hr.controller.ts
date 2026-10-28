import { Controller, Get, Post, Put, Param, Body, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { HrService } from './hr.service';

@ApiTags('hr')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('hr')
export class HrController {
  constructor(private hr: HrService) {}

  @Get('employees')
  findEmployees(@Query() query: any) {
    return this.hr.findEmployees(query);
  }

  @Get('employees/:id')
  findEmployee(@Param('id') id: string) {
    return this.hr.findEmployee(id);
  }

  @Post('employees')
  createEmployee(@Body() body: any) {
    return this.hr.createEmployee(body);
  }

  @Put('employees/:id')
  updateEmployee(@Param('id') id: string, @Body() body: any) {
    return this.hr.updateEmployee(id, body);
  }

  @Post('employees/:id/check-in')
  checkIn(@Param('id') id: string) {
    return this.hr.checkIn(id);
  }

  @Post('employees/:id/check-out')
  checkOut(@Param('id') id: string) {
    return this.hr.checkOut(id);
  }

  @Get('employees/:id/time-records')
  getTimeRecords(@Param('id') id: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.hr.getTimeRecords(id, from, to);
  }

  @Get('shift-templates')
  findShiftTemplates() {
    return this.hr.findShiftTemplates();
  }

  @Post('shift-templates')
  createShiftTemplate(@Body() body: any) {
    return this.hr.createShiftTemplate(body);
  }

  @Get('schedule')
  getSchedule(@Query('from') from: string, @Query('to') to: string, @Query('employeeId') employeeId?: string) {
    return this.hr.getSchedule(from, to, employeeId);
  }

  @Post('schedule')
  assignShift(@Body() body: any) {
    return this.hr.assignShift(body);
  }

  @Put('schedule/:id')
  updateShift(@Param('id') id: string, @Body() body: any) {
    return this.hr.updateShiftAssignment(id, body);
  }

  @Get('timesheet')
  getTimesheet(@Query('month') month: string, @Query('year') year: string) {
    return this.hr.getTimesheet(parseInt(month), parseInt(year));
  }

  @Post('timesheet/calculate')
  calculateTimesheet(@Body() body: { month: number; year: number }) {
    return this.hr.calculateTimesheet(body.month, body.year);
  }

  @Get('payrolls')
  getPayrolls(@Query() query: any) {
    return this.hr.getPayrolls(query);
  }

  @Post('payrolls')
  createPayroll(@Body() body: any) {
    return this.hr.createPayroll(body);
  }
}
