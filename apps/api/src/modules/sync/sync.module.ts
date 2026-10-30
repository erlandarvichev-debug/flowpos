import { Module } from '@nestjs/common';
import { SyncController } from './sync.controller';
import { SyncService } from './sync.service';
import { OnecAdapter } from './onec.adapter';

@Module({
  controllers: [SyncController],
  // Outbox разбирает только push-worker (аренда и fencing, FP-021); прежний Bull-процессор был вторым
  // потребителем той же таблицы без координации и удалён.
  providers: [SyncService, OnecAdapter],
  exports: [SyncService],
})
export class SyncModule {}
