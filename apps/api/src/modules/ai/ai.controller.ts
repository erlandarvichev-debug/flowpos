import { Body, Controller, Delete, Get, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentScope, Scope } from '../../common/scope';
import { OrgGuard, RequirePermission } from '../accounting/access/org-context';
import { AiService } from './ai.service';

/** ИИ-помощник компании: адрес коннектора, включение, подключения. */
@ApiTags('ai')
@ApiBearerAuth()
@Controller('ai')
export class AiController {
  constructor(private ai: AiService) {}

  @Get('connector') @UseGuards(JwtAuthGuard, OrgGuard)
  connector(@CurrentScope() s: Scope) { return this.ai.connector(s); }

  @Put('connector') @UseGuards(JwtAuthGuard, OrgGuard) @RequirePermission('org.members.manage')
  setEnabled(@CurrentScope() s: Scope, @Body() b: any) { return this.ai.setEnabled(s, !!b?.enabled); }

  @Post('connector/rotate') @UseGuards(JwtAuthGuard, OrgGuard) @RequirePermission('org.members.manage')
  rotate(@CurrentScope() s: Scope) { return this.ai.rotate(s); }

  @Get('connections') @UseGuards(JwtAuthGuard, OrgGuard)
  connections(@CurrentScope() s: Scope) { return this.ai.connections(s); }

  @Delete('connections/:id') @UseGuards(JwtAuthGuard, OrgGuard)
  revoke(@CurrentScope() s: Scope, @Param('id') id: string, @Req() req: any) { return this.ai.revoke(s, id, !!req.orgContext?.can?.('org.members.manage')); }

  /** Вызывает MCP при первом запросе Claude к компании. */
  @Post('connections') @UseGuards(JwtAuthGuard, OrgGuard)
  register(@CurrentScope() s: Scope, @Body() b: any) { return this.ai.register(s, b); }

  /** Вызывает MCP: какая компания у адреса коннектора. Без входа; перебор кодов ограничен. */
  @Get('connector-by-code/:code')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  byCode(@Param('code') code: string) { return this.ai.byCode(code); }
}
