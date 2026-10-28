import { Controller, Get, Post, Param, Body, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { SyncService } from './sync.service';

@ApiTags('sync')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('sync')
export class SyncController {
  constructor(private sync: SyncService) {}

  @Get('status')
  getQueueStatus() {
    return this.sync.getQueueStatus();
  }

  @Get('queue')
  getQueue(@Query() query: any) {
    return this.sync.getQueueItems(query);
  }

  @Get('outbox')
  getOutbox(@Query() query: any) {
    return this.sync.listOutbox(query);
  }

  @Get('outbox/status')
  getOutboxStatus() {
    return this.sync.getOutboxStatus();
  }

  @Get('conflicts')
  listConflicts(@Query() query: any) {
    return this.sync.listConflicts(query);
  }

  @Post('conflicts/:id/resolve')
  resolveConflict(@Param('id') id: string, @Body() body: { resolution: 'keep_local' | 'take_1c' }) {
    return this.sync.resolveConflict(id, body.resolution);
  }

  @Get('instances')
  getInstances() {
    return this.sync.getInstances();
  }

  @Post('instances')
  createInstance(@Body() body: any) {
    return this.sync.createInstance(body);
  }

  @Post('instances/:id/sync')
  triggerSync(@Param('id') id: string) {
    return this.sync.triggerSync(id);
  }

  @Get('instances/:id/logs')
  getSyncLogs(@Param('id') id: string) {
    return this.sync.getSyncLogs(id);
  }
}
