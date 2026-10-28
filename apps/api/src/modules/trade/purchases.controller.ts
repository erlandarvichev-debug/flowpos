import { Controller, Get, Post, Put, Param, Body, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PurchasesService } from './purchases.service';

@ApiTags('trade/purchases')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('trade')
export class PurchasesController {
  constructor(private purchases: PurchasesService) {}

  @Get('purchase-orders')
  findOrders(@Query() query: any) {
    return this.purchases.findOrders(query);
  }

  @Get('purchase-orders/:id')
  findOrder(@Param('id') id: string) {
    return this.purchases.findOrder(id);
  }

  @Post('purchase-orders')
  createOrder(@Body() body: any) {
    return this.purchases.createOrder(body);
  }

  @Put('purchase-orders/:id')
  updateOrder(@Param('id') id: string, @Body() body: any) {
    return this.purchases.updateOrder(id, body);
  }

  @Get('goods-receipts')
  findReceipts(@Query() query: any) {
    return this.purchases.findReceipts(query);
  }

  @Post('goods-receipts')
  createReceipt(@Body() body: any) {
    return this.purchases.createReceipt(body);
  }
}
