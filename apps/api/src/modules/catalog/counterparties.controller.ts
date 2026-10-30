import { Controller, Get, Post, Put, Delete, Param, Body, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { OrgGuard, RequirePermission } from '../accounting/access/org-context';
import { CurrentScope, Scope } from '../../common/scope';
import { CounterpartiesService } from './counterparties.service';

@ApiTags('catalog/counterparties')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard)
@Controller('catalog/counterparties')
export class CounterpartiesController {
  constructor(private cp: CounterpartiesService) {}

  @Get()
  @RequirePermission('catalog.read')
  findAll(@CurrentScope() s: Scope, @Query() query: any) {
    return this.cp.findAll(s, query);
  }

  @Get('groups')
  @RequirePermission('catalog.read')
  findGroups(@CurrentScope() s: Scope) {
    return this.cp.findGroups(s);
  }

  @Get(':id')
  @RequirePermission('catalog.read')
  findOne(@CurrentScope() s: Scope, @Param('id') id: string) {
    return this.cp.findOne(s, id);
  }

  @Post()
  @RequirePermission('catalog.manage')
  create(@CurrentScope() s: Scope, @Body() body: any) {
    return this.cp.create(s, body);
  }

  @Put(':id')
  @RequirePermission('catalog.manage')
  update(@CurrentScope() s: Scope, @Param('id') id: string, @Body() body: any) {
    return this.cp.update(s, id, body);
  }

  @Delete(':id')
  @RequirePermission('catalog.manage')
  archive(@CurrentScope() s: Scope, @Param('id') id: string) {
    return this.cp.archive(s, id);
  }
}
