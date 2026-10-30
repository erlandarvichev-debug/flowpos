import { Controller, Get, Post, Put, Param, Body, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { OrgGuard, RequirePermission } from '../accounting/access/org-context';
import { CurrentScope, Scope } from '../../common/scope';
import { PurchasesService } from './purchases.service';

@ApiTags('trade/purchases')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard)
@Controller('trade')
export class PurchasesController {
  constructor(private purchases: PurchasesService) {}

  @Get('purchase-orders')
  @RequirePermission('trade.read')
  findOrders(@CurrentScope() s: Scope, @Query() query: any) {
    return this.purchases.findOrders(s, query);
  }

  @Get('purchase-orders/:id')
  @RequirePermission('trade.read')
  findOrder(@CurrentScope() s: Scope, @Param('id') id: string) {
    return this.purchases.findOrder(s, id);
  }

  @Post('purchase-orders')
  @RequirePermission('trade.write')
  createOrder(@CurrentScope() s: Scope, @Body() body: any) {
    return this.purchases.createOrder(s, body);
  }

  @Put('purchase-orders/:id')
  @RequirePermission('trade.write')
  updateOrder(@CurrentScope() s: Scope, @Param('id') id: string, @Body() body: any) {
    return this.purchases.updateOrder(s, id, body);
  }

  @Get('goods-receipts')
  @RequirePermission('trade.read')
  findReceipts(@CurrentScope() s: Scope, @Query() query: any) {
    return this.purchases.findReceipts(s, query);
  }

  @Post('goods-receipts')
  @RequirePermission('trade.write')
  createReceipt(@CurrentScope() s: Scope, @Body() body: any) {
    return this.purchases.createReceipt(s, body);
  }
}
