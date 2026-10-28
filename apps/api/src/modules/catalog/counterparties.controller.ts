import { Controller, Get, Post, Put, Delete, Param, Body, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CounterpartiesService } from './counterparties.service';

@ApiTags('catalog/counterparties')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('catalog/counterparties')
export class CounterpartiesController {
  constructor(private cp: CounterpartiesService) {}

  @Get()
  findAll(@Query() query: any) {
    return this.cp.findAll(query);
  }

  @Get('groups')
  findGroups() {
    return this.cp.findGroups();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.cp.findOne(id);
  }

  @Post()
  create(@Body() body: any) {
    return this.cp.create(body);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() body: any) {
    return this.cp.update(id, body);
  }

  @Delete(':id')
  archive(@Param('id') id: string) {
    return this.cp.archive(id);
  }
}
