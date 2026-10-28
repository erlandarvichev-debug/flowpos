import { Controller, Get, Post, Put, Param, Body, Query, UseGuards, Request } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PosService } from './pos.service';

@ApiTags('pos')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('pos')
export class PosController {
  constructor(private pos: PosService) {}

  @Get('terminals')
  findTerminals(@Request() req) {
    return this.pos.findTerminals(req.user.organizationId);
  }

  @Post('terminals')
  createTerminal(@Body() body: any, @Request() req) {
    return this.pos.createTerminal({ ...body, organizationId: req.user.organizationId });
  }

  @Get('terminals/:id/active-shift')
  getActiveShift(@Param('id') id: string) {
    return this.pos.getActiveShift(id);
  }

  @Post('terminals/:id/open-shift')
  openShift(@Param('id') id: string, @Body() body: any) {
    return this.pos.openShift(id, body);
  }

  @Get('shifts')
  findShifts(@Query() query: any) {
    return this.pos.findShifts(query);
  }

  @Put('shifts/:id/close')
  closeShift(@Param('id') id: string) {
    return this.pos.closeShift(id);
  }

  @Post('shifts/:id/cash-in')
  cashIn(@Param('id') id: string, @Body() body: { amount: number; comment?: string }) {
    return this.pos.cashIn(id, body.amount, body.comment);
  }

  @Post('shifts/:id/cash-out')
  cashOut(@Param('id') id: string, @Body() body: { amount: number; comment?: string }) {
    return this.pos.cashOut(id, body.amount, body.comment);
  }

  @Get('receipts')
  findReceipts(@Query() query: any) {
    return this.pos.findReceipts(query);
  }

  @Post('receipts')
  createReceipt(@Body() body: any) {
    return this.pos.createReceipt(body);
  }
}
