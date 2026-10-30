import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { OrgGuard, RequirePermission } from '../accounting/access/org-context';
import { CurrentScope, Scope } from '../../common/scope';
import { AnalyticsService } from './analytics.service';

@ApiTags('analytics')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard)
@Controller('analytics')
export class AnalyticsController {
  constructor(private analytics: AnalyticsService) {}

  @Get('dashboard')
  @RequirePermission('analytics.read')
  getDashboard(@CurrentScope() s: Scope, @Query('from') from: string, @Query('to') to: string) {
    const period = {
      from: from || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString(),
      to: to || new Date().toISOString(),
    };
    return this.analytics.getDashboard(s, period);
  }

  @Get('stocks')
  @RequirePermission('stock.read')
  getStockReport(@CurrentScope() s: Scope, @Query('warehouseId') warehouseId?: string) {
    return this.analytics.getStockReport(s, warehouseId);
  }

  @Get('sales-turnover')
  @RequirePermission('analytics.read')
  getSalesTurnover(@CurrentScope() s: Scope, @Query('from') from: string, @Query('to') to: string) {
    return this.analytics.getSalesTurnover(s, { from, to });
  }

  @Get('hr-dashboard')
  @RequirePermission('hr.read')
  getHrDashboard(@CurrentScope() s: Scope, @Query('from') from: string, @Query('to') to: string) {
    const period = {
      from: from || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString(),
      to: to || new Date().toISOString(),
    };
    return this.analytics.getHrDashboard(s, period);
  }
}
