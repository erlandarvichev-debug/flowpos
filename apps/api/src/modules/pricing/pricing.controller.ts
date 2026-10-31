import { Body, Controller, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { OrgGuard, RequirePermission } from '../accounting/access/org-context';
import { CurrentScope, Scope } from '../../common/scope';
import { PricingService } from './pricing.service';

/** FP-027: цены и скидки организации. Просмотр — catalog.read (в т.ч. касса), изменение — catalog.manage. */
@ApiTags('pricing')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard)
@Controller('pricing')
export class PricingController {
  constructor(private pricing: PricingService) {}

  @Get('price-lists') @RequirePermission('catalog.read')
  lists(@CurrentScope() s: Scope) { return this.pricing.listPriceLists(s); }

  @Get('price-lists/:id') @RequirePermission('catalog.read')
  list(@CurrentScope() s: Scope, @Param('id') id: string) { return this.pricing.getPriceList(s, id); }

  @Post('price-lists') @RequirePermission('catalog.manage')
  createList(@CurrentScope() s: Scope, @Body() b: any) { return this.pricing.createPriceList(s, b); }

  @Put('price-lists/:id') @RequirePermission('catalog.manage')
  updateList(@CurrentScope() s: Scope, @Param('id') id: string, @Body() b: any) { return this.pricing.updatePriceList(s, id, b ?? {}); }

  @Post('price-lists/:id/items') @RequirePermission('catalog.manage')
  items(@CurrentScope() s: Scope, @Param('id') id: string, @Body() b: any) { return this.pricing.setItems(s, id, b ?? {}); }

  @Get('discounts') @RequirePermission('catalog.read')
  discounts(@CurrentScope() s: Scope) { return this.pricing.listDiscounts(s); }

  @Post('discounts') @RequirePermission('catalog.manage')
  createDiscount(@CurrentScope() s: Scope, @Body() b: any) { return this.pricing.createDiscount(s, b); }

  @Put('discounts/:id') @RequirePermission('catalog.manage')
  updateDiscount(@CurrentScope() s: Scope, @Param('id') id: string, @Body() b: any) { return this.pricing.updateDiscount(s, id, b); }

  @Get('settings') @RequirePermission('catalog.read')
  settings(@CurrentScope() s: Scope) { return this.pricing.settings(s); }

  @Put('settings') @RequirePermission('catalog.manage')
  updateSettings(@CurrentScope() s: Scope, @Body() b: any) { return this.pricing.updateSettings(s, b); }

  @Post('preview') @RequirePermission('catalog.read')
  preview(@CurrentScope() s: Scope, @Body() b: any) { return this.pricing.preview(s, b ?? {}); }

  @Get('snapshots') @RequirePermission('catalog.read')
  snapshots(@CurrentScope() s: Scope) { return this.pricing.listSnapshots(s); }

  @Post('snapshots') @RequirePermission('catalog.manage')
  publish(@CurrentScope() s: Scope, @Body() b: any) { return this.pricing.publishSnapshot(s, b ?? {}); }

  /** Для кассы: последний снимок магазина (или общий); since — версия у кассы, если новее нет — без тела. */
  @Get('snapshots/latest') @RequirePermission('catalog.read')
  latest(@CurrentScope() s: Scope, @Query('storeId') storeId?: string, @Query('since') since?: string) { return this.pricing.latestSnapshot(s, storeId, since); }
}
