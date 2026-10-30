import { Controller, Get, Post, Param, Body, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentScope, Scope } from '../../common/scope';
import { SyncService } from './sync.service';

@ApiTags('sync')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('sync')
export class SyncController {
  constructor(private sync: SyncService) {}

  @Get('status')
  getQueueStatus(@CurrentScope() s: Scope) {
    return this.sync.getQueueStatus(s);
  }

  @Get('queue')
  getQueue(@CurrentScope() s: Scope, @Query() query: any) {
    return this.sync.getQueueItems(s, query);
  }

  @Get('outbox')
  getOutbox(@CurrentScope() s: Scope, @Query() query: any) {
    return this.sync.listOutbox(s, query);
  }

  @Get('outbox/status')
  getOutboxStatus(@CurrentScope() s: Scope) {
    return this.sync.getOutboxStatus(s);
  }

  @Get('conflicts')
  listConflicts(@CurrentScope() s: Scope, @Query() query: any) {
    return this.sync.listConflicts(s, query);
  }

  @Post('conflicts/:id/resolve')
  resolveConflict(@CurrentScope() s: Scope, @Param('id') id: string, @Body() body: { resolution: 'keep_local' | 'take_1c' }) {
    return this.sync.resolveConflict(s, id, body.resolution);
  }

  @Get('instances')
  getInstances(@CurrentScope() s: Scope) {
    return this.sync.getInstances(s);
  }

  @Post('instances')
  createInstance(@CurrentScope() s: Scope, @Body() body: any) {
    return this.sync.createInstance(s, body);
  }

  @Post('instances/:id/sync')
  triggerSync(@CurrentScope() s: Scope, @Param('id') id: string) {
    return this.sync.triggerSync(s, id);
  }

  @Get('instances/:id/logs')
  getSyncLogs(@CurrentScope() s: Scope, @Param('id') id: string) {
    return this.sync.getSyncLogs(s, id);
  }
}
