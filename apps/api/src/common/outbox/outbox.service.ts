import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

export interface OutboxEntry {
  idempotencyKey: string;
  entity: string;
  localId: string;
  connectionId?: string;
  operation: 'CREATE' | 'UPDATE' | 'DELETE' | 'POST' | 'UNPOST';
  payload: object;
}

@Injectable()
export class OutboxService {
  constructor(private prisma: PrismaService) {}

  /** Записывает в outbox внутри уже открытой транзакции */
  async enqueueInTx(tx: any, entry: OutboxEntry) {
    await tx.outbox.create({
      data: {
        idempotencyKey: entry.idempotencyKey,
        entity: entry.entity,
        localId: entry.localId,
        connectionId: entry.connectionId ?? null,
        operation: entry.operation,
        payload: entry.payload,
      },
    });
  }

  async getStatus() {
    const [pending, sending, done, error, dead] = await Promise.all([
      this.prisma.outbox.count({ where: { status: 'PENDING' } }),
      this.prisma.outbox.count({ where: { status: 'SENDING' } }),
      this.prisma.outbox.count({ where: { status: 'DONE' } }),
      this.prisma.outbox.count({ where: { status: 'ERROR' } }),
      this.prisma.outbox.count({ where: { status: 'DEAD' } }),
    ]);
    return { pending, sending, done, error, dead };
  }

  async list(status?: string, cursor?: string, limit = 50) {
    const where: any = {};
    if (status) where.status = status;
    if (cursor) where.createdAt = { lt: new Date(cursor) };

    const items = await this.prisma.outbox.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
    });

    const hasMore = items.length > limit;
    const data = hasMore ? items.slice(0, limit) : items;
    const nextCursor = hasMore ? data[data.length - 1].createdAt.toISOString() : null;

    return { data, meta: { nextCursor, hasMore } };
  }
}
