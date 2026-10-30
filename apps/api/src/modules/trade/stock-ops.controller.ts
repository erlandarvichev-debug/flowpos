import { Controller, Get, Post, Body, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { OrgGuard, RequirePermission } from '../accounting/access/org-context';
import { CurrentScope, Scope } from '../../common/scope';
import { StockOpsService } from './stock-ops.service';

@ApiTags('trade/stock-ops')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard)
@Controller('trade')
export class StockOpsController {
  constructor(private stockOps: StockOpsService) {}

  @Get('stocks')
  @RequirePermission('stock.read')
  getStockReport(@CurrentScope() s: Scope, @Query('warehouseId') warehouseId?: string) {
    return this.stockOps.getStockReport(s, warehouseId);
  }

  @Get('transfers')
  @RequirePermission('trade.read')
  findTransfers(@CurrentScope() s: Scope, @Query() query: any) {
    return this.stockOps.findTransfers(s, query);
  }

  @Post('transfers')
  @RequirePermission('trade.write')
  createTransfer(@CurrentScope() s: Scope, @Body() body: any) {
    return this.stockOps.createTransfer(s, body);
  }

  @Post('write-offs')
  @RequirePermission('trade.write')
  createWriteOff(@CurrentScope() s: Scope, @Body() body: any) {
    return this.stockOps.createWriteOff(s, body);
  }

  @Get('inventories')
  @RequirePermission('trade.read')
  findInventories(@CurrentScope() s: Scope, @Query() query: any) {
    return this.stockOps.findInventories(s, query);
  }

  @Post('inventories')
  @RequirePermission('trade.write')
  createInventory(@CurrentScope() s: Scope, @Body() body: any) {
    return this.stockOps.createInventory(s, body);
  }
}
