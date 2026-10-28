import { Controller, Get, Query, UseGuards, Request } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AnalyticsService } from './analytics.service';

@ApiTags('analytics')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('analytics')
export class AnalyticsController {
  constructor(private analytics: AnalyticsService) {}

  @Get('dashboard')
  getDashboard(@Request() req, @Query('from') from: string, @Query('to') to: string) {
    const period = {
      from: from || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString(),
      to: to || new Date().toISOString(),
    };
    return this.analytics.getDashboard(req.user.organizationId, period);
  }

  @Get('stocks')
  getStockReport(@Query('warehouseId') warehouseId?: string) {
    return this.analytics.getStockReport(warehouseId);
  }

  @Get('sales-turnover')
  getSalesTurnover(@Query('from') from: string, @Query('to') to: string) {
    return this.analytics.getSalesTurnover({ from, to });
  }

  @Get('hr-dashboard')
  getHrDashboard(@Query('from') from: string, @Query('to') to: string) {
    const period = {
      from: from || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString(),
      to: to || new Date().toISOString(),
    };
    return this.analytics.getHrDashboard(period);
  }
}
