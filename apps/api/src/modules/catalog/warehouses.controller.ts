import { Controller, Get, Post, Put, Param, Body, Query, UseGuards, Request } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { WarehousesService } from './warehouses.service';

@ApiTags('catalog/warehouses')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('catalog/warehouses')
export class WarehousesController {
  constructor(private warehouses: WarehousesService) {}

  @Get()
  findAll(@Request() req) {
    return this.warehouses.findAll(req.user.organizationId);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.warehouses.findOne(id);
  }

  @Get(':id/stocks')
  getStocks(@Param('id') id: string, @Query() query: any) {
    return this.warehouses.getStocks(id, query);
  }

  @Post()
  create(@Body() body: any, @Request() req) {
    return this.warehouses.create({ ...body, organizationId: req.user.organizationId });
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() body: any) {
    return this.warehouses.update(id, body);
  }
}
