import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * FP-009: Outbox Pattern for Event Sourcing
 * Events are durably written in same transaction as business data
 * Then polled and delivered by background worker
 */
export interface DomainEvent {
  aggregateType: string; // e.g., "Document", "User"
  aggregateId: string;
  eventType: string; // e.g., "DocumentCreated", "DocumentApproved"
  data: Record<string, any>;
  metadata?: Record<string, any>;
}

@Injectable()
export class OutboxService {
  constructor(private prisma: PrismaService) {}

  /**
   * FP-009: Record event in outbox (called inside business transaction)
   */
  async recordEvent(tenantId: string, organizationId: string | null, event: DomainEvent) {
    return this.prisma.outbox.create({
      data: {
        id: crypto.randomUUID(),
        tenantId,
        organizationId,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        eventType: event.eventType,
        data: event.data,
        metadata: event.metadata || {},
        version: 1,
      },
    });
  }

  /**
   * FP-009: Get unpublished events for worker to process
   */
  async getUnpublishedEvents(tenantId: string, limit: number = 100) {
    return this.prisma.outbox.findMany({
      where: {
        tenantId,
        published: false,
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
  }

  /**
   * FP-009: Mark event as published (worker success)
   */
  async markPublished(eventId: string) {
    return this.prisma.outbox.update({
      where: { id: eventId },
      data: {
        published: true,
        publishedAt: new Date(),
      },
    });
  }

  /**
   * FP-009: Get event history for aggregate
   */
  async getEventHistory(tenantId: string, aggregateType: string, aggregateId: string) {
    return this.prisma.outbox.findMany({
      where: {
        tenantId,
        aggregateType,
        aggregateId,
      },
      orderBy: { version: 'asc' },
    });
  }

  /**
   * FP-009: Status dashboard
   */
  async getStatus(tenantId: string) {
    const [published, pending] = await Promise.all([
      this.prisma.outbox.count({ where: { tenantId, published: true } }),
      this.prisma.outbox.count({ where: { tenantId, published: false } }),
    ]);
    return { published, pending, total: published + pending };
  }

  /**
   * FP-009: List events (backwards compat with old code)
   */
  async list(tenantId: string, status?: string, cursor?: string, limit = 50) {
    const where: any = { tenantId };
    if (status === 'PENDING') where.published = false;
    if (status === 'DONE') where.published = true;
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
