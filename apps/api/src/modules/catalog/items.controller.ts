import { Controller, Get, Post, Put, Delete, Param, Body, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentScope, Scope } from '../../common/scope';
import { ItemsService } from './items.service';

@ApiTags('catalog/items')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('catalog/items')
export class ItemsController {
  constructor(private items: ItemsService) {}

  @Get()
  findAll(@CurrentScope() s: Scope, @Query() query: any) {
    return this.items.findAll(s, query);
  }

  @Get('groups')
  findGroups(@CurrentScope() s: Scope) {
    return this.items.findGroups(s);
  }

  @Get('units')
  findUnits(@CurrentScope() s: Scope) {
    return this.items.findUnits(s);
  }

  @Get(':id')
  findOne(@CurrentScope() s: Scope, @Param('id') id: string) {
    return this.items.findOne(s, id);
  }

  @Get(':id/stock')
  getStock(@CurrentScope() s: Scope, @Param('id') id: string) {
    return this.items.getStock(s, id);
  }

  @Post()
  create(@CurrentScope() s: Scope, @Body() body: any) {
    return this.items.create(s, body);
  }

  @Put(':id')
  update(@CurrentScope() s: Scope, @Param('id') id: string, @Body() body: any) {
    return this.items.update(s, id, body);
  }

  @Delete(':id')
  archive(@CurrentScope() s: Scope, @Param('id') id: string) {
    return this.items.archive(s, id);
  }
}
