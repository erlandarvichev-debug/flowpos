import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from '../../prisma/prisma.service';
import { OutboxService } from '../../common/outbox/outbox.service';
import { OnecAdapter } from './onec.adapter';

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    private prisma: PrismaService,
    private onec: OnecAdapter,
    private outbox: OutboxService,
    @InjectQueue('sync-to-1c') private syncQueue: Queue,
  ) {}

  async enqueue(operation: string, entity: string, entityId: string, payload: any, connectionId?: string) {
    const idempotencyKey = `${operation}:${entity}:${entityId}:${uuidv4()}`;
    const record = await this.prisma.outbox.create({
      data: {
        connectionId,
        operation,
        entity,
        localId: entityId,
        payload,
        idempotencyKey,
        status: 'PENDING',
        nextAttemptAt: new Date(),
      },
    });

    await this.syncQueue.add('process', { syncQueueId: record.id }, {
      attempts: 5,
      backoff: { type: 'exponential', delay: 5000 },
    });

    return record;
  }

  async getQueueStatus() {
    const [pending, processing, failed, sent] = await Promise.all([
      this.prisma.outbox.count({ where: { status: 'PENDING' } }),
      this.prisma.outbox.count({ where: { status: 'SENDING' } }),
      this.prisma.outbox.count({ where: { status: 'ERROR' } }),
      this.prisma.outbox.count({ where: { status: 'DONE' } }),
    ]);
    return { pending, processing, failed, sent };
  }

  async getQueueItems(query: { status?: string; page?: number; limit?: number }) {
    const page = query.page || 1;
    const limit = query.limit || 50;
    const skip = (page - 1) * limit;
    const where: any = {};
    if (query.status) where.status = query.status;
    const [items, total] = await Promise.all([
      this.prisma.outbox.findMany({
        where, skip, take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.outbox.count({ where }),
    ]);
    return { items, total, page, limit };
  }

  async getInstances() {
    return this.prisma.onecConnection.findMany({
      include: { organization: true },
      orderBy: { name: 'asc' },
    });
  }

  async createInstance(data: any) {
    return this.prisma.onecConnection.create({ data });
  }

  async triggerSync(connectionId: string) {
    this.logger.log(`Triggering sync for connection ${connectionId}`);
    await this.onec.syncItemsFromOnec(connectionId);
    return { message: 'Sync started' };
  }

  async getSyncLogs(connectionId: string) {
    return this.prisma.syncLog.findMany({
      where: { connectionId },
      orderBy: { startedAt: 'desc' },
      take: 100,
    });
  }

  // ── Outbox ──────────────────────────────────────────────────────────────────

  async getOutboxStatus() {
    return this.outbox.getStatus();
  }

  async listOutbox(query: { status?: string; cursor?: string; limit?: number }) {
    return this.outbox.list(query.status, query.cursor, Number(query.limit) || 50);
  }

  // ── Конфликты ───────────────────────────────────────────────────────────────

  async listConflicts(query: { entity?: string; cursor?: string; limit?: number }) {
    const limit = Math.min(Number(query.limit) || 50, 200);

    const [purchaseConflicts, salesConflicts] = await Promise.all([
      this.prisma.document.findMany({
        where: { docType: 'PURCHASE_ORDER', deleted: false } as any,
        orderBy: { updatedAt: 'desc' },
        take: limit,
      }).catch(() => []),
      this.prisma.document.findMany({
        where: { docType: 'DEMAND' },
        orderBy: { date: 'desc' },
        take: limit,
      }).catch(() => []),
    ]);

    return { data: [], meta: { nextCursor: null, hasMore: false }, note: 'conflicts endpoint - expand per entity' };
  }

  async resolveConflict(id: string, resolution: 'keep_local' | 'take_1c') {
    const item = await this.prisma.document.findUnique({ where: { id } }).catch(() => null);
    if (!item) throw new NotFoundException(`Запись ${id} не найдена`);

    if (resolution === 'keep_local') {
      await this.outbox.enqueueInTx(this.prisma as any, {
        idempotencyKey: `conflict-resolve-local-${id}-${Date.now()}`,
        entity: 'document',
        localId: id,
        operation: 'UPDATE',
        payload: { docType: item.docType, resolution: 'keep_local' },
      });
    }

    return { ok: true, resolution };
  }
}
