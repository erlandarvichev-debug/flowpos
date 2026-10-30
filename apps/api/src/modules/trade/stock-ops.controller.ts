import { Controller, Get, Post, Body, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentScope, Scope } from '../../common/scope';
import { StockOpsService } from './stock-ops.service';

@ApiTags('trade/stock-ops')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('trade')
export class StockOpsController {
  constructor(private stockOps: StockOpsService) {}

  @Get('stocks')
  getStockReport(@CurrentScope() s: Scope, @Query('warehouseId') warehouseId?: string) {
    return this.stockOps.getStockReport(s, warehouseId);
  }

  @Get('transfers')
  findTransfers(@CurrentScope() s: Scope, @Query() query: any) {
    return this.stockOps.findTransfers(s, query);
  }

  @Post('transfers')
  createTransfer(@CurrentScope() s: Scope, @Body() body: any) {
    return this.stockOps.createTransfer(s, body);
  }

  @Post('write-offs')
  createWriteOff(@CurrentScope() s: Scope, @Body() body: any) {
    return this.stockOps.createWriteOff(s, body);
  }

  @Get('inventories')
  findInventories(@CurrentScope() s: Scope, @Query() query: any) {
    return this.stockOps.findInventories(s, query);
  }

  @Post('inventories')
  createInventory(@CurrentScope() s: Scope, @Body() body: any) {
    return this.stockOps.createInventory(s, body);
  }
}
