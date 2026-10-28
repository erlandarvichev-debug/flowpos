import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { SyncController } from './sync.controller';
import { SyncService } from './sync.service';
import { SyncQueueProcessor } from './sync-queue.processor';
import { OnecAdapter } from './onec.adapter';

@Module({
  imports: [
    BullModule.registerQueue({ name: 'sync-to-1c' }),
  ],
  controllers: [SyncController],
  providers: [SyncService, SyncQueueProcessor, OnecAdapter],
  exports: [SyncService],
})
export class SyncModule {}
