import { Module } from '@nestjs/common';
import { PurchasesController } from './purchases.controller';
import { PurchasesService } from './purchases.service';
import { SalesController } from './sales.controller';
import { SalesService } from './sales.service';
import { StockOpsController } from './stock-ops.controller';
import { StockOpsService } from './stock-ops.service';

@Module({
  controllers: [PurchasesController, SalesController, StockOpsController],
  providers: [PurchasesService, SalesService, StockOpsService],
  exports: [PurchasesService, SalesService, StockOpsService],
})
export class TradeModule {}
