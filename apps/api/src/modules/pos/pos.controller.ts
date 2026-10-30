import { Controller, Get, Post, Put, Param, Body, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentScope, Scope } from '../../common/scope';
import { PosService } from './pos.service';

@ApiTags('pos')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('pos')
export class PosController {
  constructor(private pos: PosService) {}

  @Get('terminals')
  findTerminals(@CurrentScope() s: Scope) {
    return this.pos.findTerminals(s);
  }

  @Post('terminals')
  createTerminal(@CurrentScope() s: Scope, @Body() body: any) {
    return this.pos.createTerminal(s, body);
  }

  @Get('terminals/:id/active-shift')
  getActiveShift(@CurrentScope() s: Scope, @Param('id') id: string) {
    return this.pos.getActiveShift(s, id);
  }

  @Post('terminals/:id/open-shift')
  openShift(@CurrentScope() s: Scope, @Param('id') id: string, @Body() body: any) {
    return this.pos.openShift(s, id, body);
  }

  @Get('shifts')
  findShifts(@CurrentScope() s: Scope, @Query() query: any) {
    return this.pos.findShifts(s, query);
  }

  @Put('shifts/:id/close')
  closeShift(@CurrentScope() s: Scope, @Param('id') id: string) {
    return this.pos.closeShift(s, id);
  }

  @Post('shifts/:id/cash-in')
  cashIn(@CurrentScope() s: Scope, @Param('id') id: string, @Body() body: { amount: number; comment?: string }) {
    return this.pos.cashIn(s, id, body.amount, body.comment);
  }

  @Post('shifts/:id/cash-out')
  cashOut(@CurrentScope() s: Scope, @Param('id') id: string, @Body() body: { amount: number; comment?: string }) {
    return this.pos.cashOut(s, id, body.amount, body.comment);
  }

  @Get('receipts')
  findReceipts(@CurrentScope() s: Scope, @Query() query: any) {
    return this.pos.findReceipts(s, query);
  }

  @Post('receipts')
  createReceipt(@CurrentScope() s: Scope, @Body() body: any) {
    return this.pos.createReceipt(s, body);
  }
}
