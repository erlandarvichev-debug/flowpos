import { Body, Controller, Get, Param, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { OrgContext, OrgGuard, Org } from '../accounting/access/org-context';
import { PlatformAdminGuard } from './platform.guards';
import { PlatformService } from './platform.service';

/** Раздел «Платформа»: организации всех клиентов и их подписки на решения. Только администратор платформы. */
@ApiTags('platform')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
@Controller('platform')
export class PlatformController {
  constructor(private platform: PlatformService) {}

  @Get('solutions')
  solutions() { return this.platform.solutions(); }

  @Get('organizations')
  organizations(@Query('q') q?: string) { return this.platform.organizations(q); }

  @Put('organizations/:id/subscriptions/:solution')
  setSubscription(@CurrentUser('sub') userId: string, @Param('id') id: string, @Param('solution') solution: string, @Body() body: any) {
    return this.platform.setSubscription(userId, id, solution, body);
  }

  @Get('organizations/:id/events')
  events(@Param('id') id: string) { return this.platform.events(id); }
}

/** Что показывать пользователю: решения его организации и признак администратора платформы. */
@ApiTags('platform')
@ApiBearerAuth()
@Controller('subscriptions')
export class SubscriptionsController {
  constructor(private platform: PlatformService) {}

  @Get('mine')
  @UseGuards(JwtAuthGuard, OrgGuard)
  mine(@Org() ctx: OrgContext) { return this.platform.mine(ctx.organizationId); }

  @Get('platform-admin')
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser('sub') userId: string) { return this.platform.me(userId); }
}
