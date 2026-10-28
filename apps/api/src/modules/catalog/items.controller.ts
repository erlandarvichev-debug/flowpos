import { Controller, Get, Post, Put, Delete, Param, Body, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { ItemsService } from './items.service';

@ApiTags('catalog/items')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('catalog/items')
export class ItemsController {
  constructor(private items: ItemsService) {}

  @Get()
  findAll(@Query() query: any) {
    return this.items.findAll(query);
  }

  @Get('groups')
  findGroups() {
    return this.items.findGroups();
  }

  @Get('units')
  findUnits() {
    return this.items.findUnits();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.items.findOne(id);
  }

  @Get(':id/stock')
  getStock(@Param('id') id: string) {
    return this.items.getStock(id);
  }

  @Post()
  create(@Body() body: any) {
    return this.items.create(body);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() body: any) {
    return this.items.update(id, body);
  }

  @Delete(':id')
  archive(@Param('id') id: string) {
    return this.items.archive(id);
  }
}
