import { Controller, Get, Post, Put, Param, Body, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentScope, Scope } from '../../common/scope';
import { WarehousesService } from './warehouses.service';

@ApiTags('catalog/warehouses')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('catalog/warehouses')
export class WarehousesController {
  constructor(private warehouses: WarehousesService) {}

  @Get()
  findAll(@CurrentScope() s: Scope) {
    return this.warehouses.findAll(s);
  }

  @Get(':id')
  findOne(@CurrentScope() s: Scope, @Param('id') id: string) {
    return this.warehouses.findOne(s, id);
  }

  @Get(':id/stocks')
  getStocks(@CurrentScope() s: Scope, @Param('id') id: string, @Query() query: any) {
    return this.warehouses.getStocks(s, id, query);
  }

  @Post()
  create(@CurrentScope() s: Scope, @Body() body: any) {
    return this.warehouses.create(s, body);
  }

  @Put(':id')
  update(@CurrentScope() s: Scope, @Param('id') id: string, @Body() body: any) {
    return this.warehouses.update(s, id, body);
  }
}
