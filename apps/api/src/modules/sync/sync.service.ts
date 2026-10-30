import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from '../../prisma/prisma.service';
import { OutboxService } from '../../common/outbox/outbox.service';
import { Scope, orgDocument, scopeError, writable } from '../../common/scope';
import { OnecAdapter } from './onec.adapter';

/** Подключение 1С наружу — без пароля (раньше список отдавал passwordEnc всех организаций). */
const CONNECTION_PUBLIC = { id: true, organizationId: true, name: true, baseCode: true, baseUrl: true, instanceType: true, username: true, isActive: true, createdAt: true, updatedAt: true } as const;

/** Обмен с 1С: подключения, очередь и журналы — только своей организации (FP-007). */
@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    private prisma: PrismaService,
    private onec: OnecAdapter,
    private outbox: OutboxService,
    @InjectQueue('sync-to-1c') private syncQueue: Queue,
  ) {}

  private async connection(s: Scope, id: string) {
    const c = await this.prisma.onecConnection.findFirst({ where: { id, organizationId: s.organizationId }, select: { id: true } });
    if (!c) throw new NotFoundException('Подключение 1С не найдено');
    return c;
  }

  /**
   * Записи очереди своей организации: по подключению организации или по документу организации
   * (у старых документов без организации — по складу). У outbox нет своей организации — это FP-009.
   */
  private async outboxIds(s: Scope): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT o.id FROM outbox o
      LEFT JOIN onec_connections c ON c.id = o.connection_id
      LEFT JOIN documents d ON o.entity = 'document' AND d.id = o.local_id
      LEFT JOIN stores st ON st.id = d.store_id
      WHERE c.organization_id = ${s.organizationId}
         OR d.organization_id = ${s.organizationId}
         OR (d.organization_id IS NULL AND st.organization_id = ${s.organizationId})`;
    return rows.map((r) => r.id);
  }

  async enqueue(s: Scope, operation: string, entity: string, entityId: string, payload: any, connectionId?: string) {
    if (connectionId) await this.connection(s, connectionId);
    const idempotencyKey = `${operation}:${entity}:${entityId}:${uuidv4()}`;
    const record = await this.prisma.outbox.create({
      data: {
        tenantId: s.tenantId,
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

  async getQueueStatus(s: Scope) {
    const scope = { id: { in: await this.outboxIds(s) } };
    const [pending, processing, failed, sent] = await Promise.all([
      this.prisma.outbox.count({ where: { ...scope, status: 'PENDING' } }),
      this.prisma.outbox.count({ where: { ...scope, status: 'SENDING' } }),
      this.prisma.outbox.count({ where: { ...scope, status: 'ERROR' } }),
      this.prisma.outbox.count({ where: { ...scope, status: 'DONE' } }),
    ]);
    return { pending, processing, failed, sent };
  }

  async getQueueItems(s: Scope, query: { status?: string; page?: number; limit?: number }) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 50;
    const skip = (page - 1) * limit;
    const where: any = { id: { in: await this.outboxIds(s) } };
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

  async getInstances(s: Scope) {
    return this.prisma.onecConnection.findMany({
      where: { organizationId: s.organizationId },
      select: { ...CONNECTION_PUBLIC, organization: true },
      orderBy: { name: 'asc' },
    });
  }

  async createInstance(s: Scope, body: any) {
    const { data } = writable(body, s);
    const { name, baseCode, baseUrl, instanceType, username, passwordEnc, isActive } = data as any;
    return this.prisma.onecConnection.create({
      data: { organizationId: s.organizationId, name, baseCode, baseUrl, instanceType, username, passwordEnc, isActive },
      select: CONNECTION_PUBLIC,
    }).catch(scopeError);
  }

  async triggerSync(s: Scope, connectionId: string) {
    await this.connection(s, connectionId);
    this.logger.log(`Triggering sync for connection ${connectionId}`);
    await this.onec.syncItemsFromOnec(connectionId);
    return { message: 'Sync started' };
  }

  async getSyncLogs(s: Scope, connectionId: string) {
    await this.connection(s, connectionId);
    return this.prisma.syncLog.findMany({
      where: { connectionId },
      orderBy: { startedAt: 'desc' },
      take: 100,
    });
  }

  // ── Outbox ──────────────────────────────────────────────────────────────────

  async getOutboxStatus(s: Scope) {
    return this.outbox.getStatus(await this.outboxIds(s));
  }

  async listOutbox(s: Scope, query: { status?: string; cursor?: string; limit?: number }) {
    return this.outbox.list(query.status, query.cursor, Number(query.limit) || 50, await this.outboxIds(s));
  }

  // ── Конфликты ───────────────────────────────────────────────────────────────

  async listConflicts(_s: Scope, _query: { entity?: string; cursor?: string; limit?: number }) {
    return { data: [], meta: { nextCursor: null, hasMore: false }, note: 'conflicts endpoint - expand per entity' };
  }

  async resolveConflict(s: Scope, id: string, resolution: 'keep_local' | 'take_1c') {
    const item = await this.prisma.document.findFirst({ where: { AND: [orgDocument(s), { id }] } }).catch(() => null);
    if (!item) throw new NotFoundException(`Запись ${id} не найдена`);

    if (resolution === 'keep_local') {
      await this.outbox.enqueueInTx(this.prisma as any, {
        tenantId: s.tenantId,
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
