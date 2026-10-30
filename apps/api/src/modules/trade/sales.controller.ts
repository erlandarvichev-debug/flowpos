import { Controller, Get, Post, Param, Body, Query, UseGuards, Headers, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { OrgGuard, RequirePermission } from '../accounting/access/org-context';
import { CurrentScope, Scope } from '../../common/scope';
import { SalesService } from './sales.service';

@ApiTags('trade/sales')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard)
@Controller('trade')
export class SalesController {
  constructor(private sales: SalesService) {}

  @Get('sales-orders')
  @RequirePermission('trade.read')
  findOrders(@CurrentScope() s: Scope, @Query() query: any) {
    return this.sales.findOrders(s, query);
  }

  @Get('sales-orders/:id')
  @RequirePermission('trade.read')
  findOrder(@CurrentScope() s: Scope, @Param('id') id: string) {
    return this.sales.findOrder(s, id);
  }

  @Post('sales-orders')
  @RequirePermission('trade.write')
  createOrder(@CurrentScope() s: Scope, @Body() body: any) {
    return this.sales.createOrder(s, body);
  }

  @Get('shipments')
  @RequirePermission('trade.read')
  findShipments(@CurrentScope() s: Scope, @Query() query: any) {
    return this.sales.findShipments(s, query);
  }

  @Post('shipments')
  @RequirePermission('trade.write')
  createShipment(@CurrentScope() s: Scope, @Body() body: any) {
    return this.sales.createShipment(s, body);
  }

  /** POS endpoint: розничная продажа (RETAIL_DEMAND) */
  @Post('pos-sale')
  @RequirePermission('pos.operate')
  createPosSale(@CurrentScope() s: Scope, @Body() body: any,
    @Headers('idempotency-key') idempotencyKey: string,
  ) {
    if (!idempotencyKey) throw new BadRequestException('Idempotency-Key header required');
    return this.sales.createPosSale(s, body, idempotencyKey);
  }
}
