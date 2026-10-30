import { Controller, Get, Post, Put, Param, Body, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentScope, Scope } from '../../common/scope';
import { PurchasesService } from './purchases.service';

@ApiTags('trade/purchases')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('trade')
export class PurchasesController {
  constructor(private purchases: PurchasesService) {}

  @Get('purchase-orders')
  findOrders(@CurrentScope() s: Scope, @Query() query: any) {
    return this.purchases.findOrders(s, query);
  }

  @Get('purchase-orders/:id')
  findOrder(@CurrentScope() s: Scope, @Param('id') id: string) {
    return this.purchases.findOrder(s, id);
  }

  @Post('purchase-orders')
  createOrder(@CurrentScope() s: Scope, @Body() body: any) {
    return this.purchases.createOrder(s, body);
  }

  @Put('purchase-orders/:id')
  updateOrder(@CurrentScope() s: Scope, @Param('id') id: string, @Body() body: any) {
    return this.purchases.updateOrder(s, id, body);
  }

  @Get('goods-receipts')
  findReceipts(@CurrentScope() s: Scope, @Query() query: any) {
    return this.purchases.findReceipts(s, query);
  }

  @Post('goods-receipts')
  createReceipt(@CurrentScope() s: Scope, @Body() body: any) {
    return this.purchases.createReceipt(s, body);
  }
}
