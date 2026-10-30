import { Controller, Get, Post, Param, Body, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { OrgGuard, RequireMfa, RequirePermission } from '../accounting/access/org-context';
import { CurrentScope, Scope } from '../../common/scope';
import { SyncService } from './sync.service';

@ApiTags('sync')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard)
@Controller('sync')
export class SyncController {
  constructor(private sync: SyncService) {}

  @Get('status')
  @RequirePermission('sync.read')
  getQueueStatus(@CurrentScope() s: Scope) {
    return this.sync.getQueueStatus(s);
  }

  @Get('queue')
  @RequirePermission('sync.read')
  getQueue(@CurrentScope() s: Scope, @Query() query: any) {
    return this.sync.getQueueItems(s, query);
  }

  @Get('outbox')
  @RequirePermission('sync.read')
  getOutbox(@CurrentScope() s: Scope, @Query() query: any) {
    return this.sync.listOutbox(s, query);
  }

  @Get('outbox/status')
  @RequirePermission('sync.read')
  getOutboxStatus(@CurrentScope() s: Scope) {
    return this.sync.getOutboxStatus(s);
  }

  @Get('conflicts')
  @RequirePermission('sync.read')
  listConflicts(@CurrentScope() s: Scope, @Query() query: any) {
    return this.sync.listConflicts(s, query);
  }

  @Post('conflicts/:id/resolve')
  @RequirePermission('sync.manage')
  @RequireMfa()
  resolveConflict(@CurrentScope() s: Scope, @Param('id') id: string, @Body() body: { resolution: 'keep_local' | 'take_1c' }) {
    return this.sync.resolveConflict(s, id, body.resolution);
  }

  /** Вернуть запись из UNKNOWN/DLQ в очередь после сверки с 1С (FP-021). */
  @Post('outbox/:id/requeue')
  @RequirePermission('sync.manage')
  @RequireMfa()
  requeueOutbox(@CurrentScope() s: Scope, @Param('id') id: string, @Body() body: { reason: string }) {
    return this.sync.requeueOutbox(s, id, body?.reason);
  }

  @Get('instances')
  @RequirePermission('sync.read')
  getInstances(@CurrentScope() s: Scope) {
    return this.sync.getInstances(s);
  }

  @Post('instances')
  @RequirePermission('sync.manage')
  @RequireMfa()
  createInstance(@CurrentScope() s: Scope, @Body() body: any) {
    return this.sync.createInstance(s, body);
  }

  @Post('instances/:id/sync')
  @RequirePermission('sync.manage')
  @RequireMfa()
  triggerSync(@CurrentScope() s: Scope, @Param('id') id: string) {
    return this.sync.triggerSync(s, id);
  }

  @Get('instances/:id/logs')
  @RequirePermission('sync.read')
  getSyncLogs(@CurrentScope() s: Scope, @Param('id') id: string) {
    return this.sync.getSyncLogs(s, id);
  }
}
