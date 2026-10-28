import { Controller, Get, Post, Body, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { StockOpsService } from './stock-ops.service';

@ApiTags('trade/stock-ops')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('trade')
export class StockOpsController {
  constructor(private stockOps: StockOpsService) {}

  @Get('stocks')
  getStockReport(@Query('warehouseId') warehouseId?: string) {
    return this.stockOps.getStockReport(warehouseId);
  }

  @Get('transfers')
  findTransfers(@Query() query: any) {
    return this.stockOps.findTransfers(query);
  }

  @Post('transfers')
  createTransfer(@Body() body: any) {
    return this.stockOps.createTransfer(body);
  }

  @Post('write-offs')
  createWriteOff(@Body() body: any) {
    return this.stockOps.createWriteOff(body);
  }

  @Get('inventories')
  findInventories(@Query() query: any) {
    return this.stockOps.findInventories(query);
  }

  @Post('inventories')
  createInventory(@Body() body: any) {
    return this.stockOps.createInventory(body);
  }
}
