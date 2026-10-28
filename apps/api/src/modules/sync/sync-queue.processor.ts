import { Processor, Process } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { PrismaService } from '../../prisma/prisma.service';
import { OnecAdapter } from './onec.adapter';

const MAX_ATTEMPTS = 5;

@Processor('sync-to-1c')
export class SyncQueueProcessor {
  private readonly logger = new Logger(SyncQueueProcessor.name);

  constructor(
    private prisma: PrismaService,
    private onec: OnecAdapter,
  ) {}

  @Process('process')
  async handleProcess(job: Job<{ syncQueueId: string }>) {
    const record = await this.prisma.outbox.findUnique({
      where: { id: job.data.syncQueueId },
    });

    if (!record || record.status === 'DONE' || record.status === 'DEAD') return;

    await this.prisma.outbox.update({
      where: { id: record.id },
      data: { status: 'SENDING', attempts: { increment: 1 } },
    });

    try {
      if (record.connectionId) {
        await this.onec.sendToOnec(
          record.connectionId,
          record.operation,
          record.entity,
          record.payload,
        );
      }

      await this.prisma.outbox.update({
        where: { id: record.id },
        data: { status: 'DONE', processedAt: new Date() },
      });

      this.logger.log(`Sent ${record.operation}:${record.entity}:${record.localId} to 1C`);
    } catch (err) {
      const delay = Math.min(5000 * Math.pow(2, record.attempts), 3600000);
      const nextAttempt = new Date(Date.now() + delay);

      if (record.attempts >= MAX_ATTEMPTS) {
        await this.prisma.outbox.update({
          where: { id: record.id },
          data: { status: 'DEAD', lastError: err.message },
        });
        this.logger.error(`Failed to send ${record.entity}:${record.localId} after ${record.attempts} attempts`);
      } else {
        await this.prisma.outbox.update({
          where: { id: record.id },
          data: { status: 'PENDING', lastError: err.message, nextAttemptAt: nextAttempt },
        });
        throw err;
      }
    }
  }
}
