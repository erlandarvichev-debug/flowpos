import { Controller, Get, Post, Put, Param, Body, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { OrgGuard, RequirePermission } from '../accounting/access/org-context';
import { CurrentScope, Scope } from '../../common/scope';
import { WarehousesService } from './warehouses.service';

@ApiTags('catalog/warehouses')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard)
@Controller('catalog/warehouses')
export class WarehousesController {
  constructor(private warehouses: WarehousesService) {}

  @Get()
  @RequirePermission('catalog.read')
  findAll(@CurrentScope() s: Scope) {
    return this.warehouses.findAll(s);
  }

  @Get(':id')
  @RequirePermission('catalog.read')
  findOne(@CurrentScope() s: Scope, @Param('id') id: string) {
    return this.warehouses.findOne(s, id);
  }

  @Get(':id/stocks')
  @RequirePermission('stock.read')
  getStocks(@CurrentScope() s: Scope, @Param('id') id: string, @Query() query: any) {
    return this.warehouses.getStocks(s, id, query);
  }

  @Post()
  @RequirePermission('catalog.manage')
  create(@CurrentScope() s: Scope, @Body() body: any) {
    return this.warehouses.create(s, body);
  }

  @Put(':id')
  @RequirePermission('catalog.manage')
  update(@CurrentScope() s: Scope, @Param('id') id: string, @Body() body: any) {
    return this.warehouses.update(s, id, body);
  }
}
