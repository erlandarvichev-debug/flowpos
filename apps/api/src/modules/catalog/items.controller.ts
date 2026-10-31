import { Controller, Get, Post, Put, Delete, Param, Body, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { OrgGuard, RequirePermission } from '../accounting/access/org-context';
import { CurrentScope, Scope } from '../../common/scope';
import { ItemsService } from './items.service';
import { BarcodesService } from './barcodes.service';

@ApiTags('catalog/items')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard)
@Controller('catalog/items')
export class ItemsController {
  constructor(private items: ItemsService, private barcodes: BarcodesService) {}

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

  // FP-025: поиск по штрихкоду (в т.ч. весовому), дубли штрихкодов, весовые настройки клиента.
  @Get('barcode/:code')
  @RequirePermission('catalog.read')
  resolve(@CurrentScope() s: Scope, @Param('code') code: string) {
    return this.barcodes.resolve(s, code);
  }

  @Get('barcode-duplicates')
  @RequirePermission('catalog.read')
  duplicates(@CurrentScope() s: Scope) {
    return this.barcodes.duplicates(s);
  }

  @Get('settings')
  @RequirePermission('catalog.read')
  settings(@CurrentScope() s: Scope) {
    return this.barcodes.settings(s);
  }

  @Put('settings')
  @RequirePermission('catalog.manage')
  updateSettings(@CurrentScope() s: Scope, @Body() body: any) {
    return this.barcodes.updateSettings(s, body ?? {});
  }

  @Get(':id/versions')
  @RequirePermission('catalog.read')
  versions(@CurrentScope() s: Scope, @Param('id') id: string) {
    return this.items.versions(s, id);
  }

  @Get(':id/mappings')
  @RequirePermission('catalog.read')
  mappings(@CurrentScope() s: Scope, @Param('id') id: string) {
    return this.items.mappings(s, id);
  }

  @Post(':id/barcodes')
  @RequirePermission('catalog.manage')
  addBarcode(@CurrentScope() s: Scope, @Param('id') id: string, @Body() body: any) {
    return this.barcodes.add(s, id, body ?? {});
  }

  @Delete(':id/barcodes/:barcodeId')
  @RequirePermission('catalog.manage')
  removeBarcode(@CurrentScope() s: Scope, @Param('id') id: string, @Param('barcodeId') barcodeId: string) {
    return this.barcodes.remove(s, id, barcodeId);
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
