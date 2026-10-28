import { Controller, Get, Post, Param, Body, Query, UseGuards, Headers, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { SalesService } from './sales.service';

@ApiTags('trade/sales')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('trade')
export class SalesController {
  constructor(private sales: SalesService) {}

  @Get('sales-orders')
  findOrders(@Query() query: any) {
    return this.sales.findOrders(query);
  }

  @Get('sales-orders/:id')
  findOrder(@Param('id') id: string) {
    return this.sales.findOrder(id);
  }

  @Post('sales-orders')
  createOrder(@Body() body: any) {
    return this.sales.createOrder(body);
  }

  @Get('shipments')
  findShipments(@Query() query: any) {
    return this.sales.findShipments(query);
  }

  @Post('shipments')
  createShipment(@Body() body: any) {
    return this.sales.createShipment(body);
  }

  /** POS endpoint: розничная продажа (RETAIL_DEMAND) */
  @Post('pos-sale')
  createPosSale(
    @Body() body: any,
    @Headers('idempotency-key') idempotencyKey: string,
  ) {
    if (!idempotencyKey) throw new BadRequestException('Idempotency-Key header required');
    return this.sales.createPosSale(body, idempotencyKey);
  }
}
