import { Controller, Get, Post, Put, Param, Body, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { OrgGuard, RequirePermission } from '../accounting/access/org-context';
import { CurrentScope, Scope } from '../../common/scope';
import { PosService } from './pos.service';

@ApiTags('pos')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard)
@Controller('pos')
export class PosController {
  constructor(private pos: PosService) {}

  @Get('terminals')
  @RequirePermission('pos.operate')
  findTerminals(@CurrentScope() s: Scope) {
    return this.pos.findTerminals(s);
  }

  @Post('terminals')
  @RequirePermission('pos.manage')
  createTerminal(@CurrentScope() s: Scope, @Body() body: any) {
    return this.pos.createTerminal(s, body);
  }

  @Get('terminals/:id/active-shift')
  @RequirePermission('pos.operate')
  getActiveShift(@CurrentScope() s: Scope, @Param('id') id: string) {
    return this.pos.getActiveShift(s, id);
  }

  @Post('terminals/:id/open-shift')
  @RequirePermission('pos.operate')
  openShift(@CurrentScope() s: Scope, @Param('id') id: string, @Body() body: any) {
    return this.pos.openShift(s, id, body);
  }

  @Get('shifts')
  @RequirePermission('pos.operate')
  findShifts(@CurrentScope() s: Scope, @Query() query: any) {
    return this.pos.findShifts(s, query);
  }

  @Put('shifts/:id/close')
  @RequirePermission('pos.operate')
  closeShift(@CurrentScope() s: Scope, @Param('id') id: string) {
    return this.pos.closeShift(s, id);
  }

  @Post('shifts/:id/cash-in')
  @RequirePermission('pos.operate')
  cashIn(@CurrentScope() s: Scope, @Param('id') id: string, @Body() body: { amount: number; comment?: string }) {
    return this.pos.cashIn(s, id, body.amount, body.comment);
  }

  @Post('shifts/:id/cash-out')
  @RequirePermission('pos.operate')
  cashOut(@CurrentScope() s: Scope, @Param('id') id: string, @Body() body: { amount: number; comment?: string }) {
    return this.pos.cashOut(s, id, body.amount, body.comment);
  }

  @Get('receipts')
  @RequirePermission('pos.operate')
  findReceipts(@CurrentScope() s: Scope, @Query() query: any) {
    return this.pos.findReceipts(s, query);
  }

  @Post('receipts')
  @RequirePermission('pos.operate')
  createReceipt(@CurrentScope() s: Scope, @Body() body: any) {
    return this.pos.createReceipt(s, body);
  }
}
