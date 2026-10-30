import { Controller, Get, Post, Put, Delete, Param, Body, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { OrgGuard, RequirePermission } from '../accounting/access/org-context';
import { CurrentScope, Scope } from '../../common/scope';
import { ItemsService } from './items.service';

@ApiTags('catalog/items')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard)
@Controller('catalog/items')
export class ItemsController {
  constructor(private items: ItemsService) {}

  @Get()
  @RequirePermission('catalog.read')
  findAll(@CurrentScope() s: Scope, @Query() query: any) {
    return this.items.findAll(s, query);
  }

  @Get('groups')
  @RequirePermission('catalog.read')
  findGroups(@CurrentScope() s: Scope) {
    return this.items.findGroups(s);
  }

  @Get('units')
  @RequirePermission('catalog.read')
  findUnits(@CurrentScope() s: Scope) {
    return this.items.findUnits(s);
  }

  @Get(':id')
  @RequirePermission('catalog.read')
  findOne(@CurrentScope() s: Scope, @Param('id') id: string) {
    return this.items.findOne(s, id);
  }

  @Get(':id/stock')
  @RequirePermission('stock.read')
  getStock(@CurrentScope() s: Scope, @Param('id') id: string) {
    return this.items.getStock(s, id);
  }

  @Post()
  @RequirePermission('catalog.manage')
  create(@CurrentScope() s: Scope, @Body() body: any) {
    return this.items.create(s, body);
  }

  @Put(':id')
  @RequirePermission('catalog.manage')
  update(@CurrentScope() s: Scope, @Param('id') id: string, @Body() body: any) {
    return this.items.update(s, id, body);
  }

  @Delete(':id')
  @RequirePermission('catalog.manage')
  archive(@CurrentScope() s: Scope, @Param('id') id: string) {
    return this.items.archive(s, id);
  }
}
