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

  async getStatus(ids?: string[]) {
    const scope = ids ? { id: { in: ids } } : {};
    const [pending, sending, done, error, dead] = await Promise.all([
      this.prisma.outbox.count({ where: { ...scope, status: 'PENDING' } }),
      this.prisma.outbox.count({ where: { ...scope, status: 'SENDING' } }),
      this.prisma.outbox.count({ where: { ...scope, status: 'DONE' } }),
      this.prisma.outbox.count({ where: { ...scope, status: 'ERROR' } }),
      this.prisma.outbox.count({ where: { ...scope, status: 'DEAD' } }),
    ]);
    return { pending, sending, done, error, dead };
  }

  /** ids — ограничение видимости (FP-007: записи своей организации); не задано — все (служебное использование). */
  async list(status?: string, cursor?: string, limit = 50, ids?: string[]) {
    const where: any = ids ? { id: { in: ids } } : {};
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
