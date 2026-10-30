import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../prisma.service';
import { OnecHttpClient } from '@flowpos/onec-client';

/** Задержки повторных попыток (мс): 1m, 5m, 15m, 1h, 4h, 12h */
const BACKOFF_DELAYS_MS = [
  60_000,
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
  4 * 60 * 60_000,
  12 * 60 * 60_000,
];
const MAX_ATTEMPTS = 12;
const BATCH_SIZE = 50;

@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private running = false;

  constructor(private prisma: PrismaService) {}

  /** Каждые 10 секунд берём очередную порцию из outbox */
  @Cron('*/10 * * * * *')
  async processOutbox() {
    if (this.running) return;
    this.running = true;
    try {
      await this.processBatch();
    } finally {
      this.running = false;
    }
  }

  private async processBatch() {
    // FOR UPDATE SKIP LOCKED — безопасно при нескольких воркерах
    const entries: any[] = await this.prisma.$queryRaw`
      SELECT o.*, c."base_url" as "connBaseUrl", c."base_code" as "connBaseCode",
             c."username" as "connUsername", c."password_enc" as "connPassword",
             c."instance_type" as "connInstanceType"
      FROM outbox o
      JOIN onec_connections c ON c.id = o."connection_id"
      WHERE o.status IN ('PENDING', 'SENDING')
        AND o."next_attempt_at" <= NOW()
        AND o.attempts < ${MAX_ATTEMPTS}
      LIMIT ${BATCH_SIZE}
      FOR UPDATE OF o SKIP LOCKED
    `;

    if (!entries.length) return;

    // Помечаем как SENDING
    const ids = entries.map((e: any) => e.id);
    await this.prisma.$executeRaw`
      UPDATE outbox SET status = 'SENDING' WHERE id = ANY(${ids}::uuid[])
    `;

    for (const entry of entries) {
      await this.processEntry(entry);
    }
  }

  private async processEntry(entry: any) {
    const client = new OnecHttpClient({
      baseUrl: entry.connBaseUrl,
      baseCode: entry.connBaseCode,
      username: entry.connUsername,
      password: entry.connPassword,
      instanceType: entry.connInstanceType,
    });

    try {
      const result = await this.sendToOnec(client, entry);

      // Успех — записываем GUID обратно в mirror-таблицу
      await this.prisma.$transaction(async (tx) => {
        await tx.outbox.update({
          where: { id: entry.id },
          data: {
            status: 'DONE',
            processedAt: new Date(),
            lastError: null,
          },
        });

        if (result?.guid) {
          await this.writeBackGuid(tx, entry, result.guid, result.version);
        }
      });

      this.logger.log(`Outbox ${entry.id} (${entry.entity}/${entry.operation}) → DONE`);
    } catch (err: any) {
      await this.handleError(entry, err);
    }
  }

  private async sendToOnec(client: OnecHttpClient, entry: any): Promise<{ guid: string; version?: string } | null> {
    const payload = entry.payload as any;
    const { entity, operation, localId } = entry;

    if (operation === 'DELETE') {
      await client.deleteRef(entity, payload.onecGuid);
      return null;
    }

    if (entity === 'document') {
      if (operation === 'CREATE') {
        const res = await client.createDocument(payload, entry.idempotencyKey);
        return { guid: res.guid, version: res.version };
      } else if (operation === 'UPDATE') {
        // UPDATE через createDocument идемпотентно по idempotencyKey
        const res = await client.createDocument(payload, entry.idempotencyKey);
        return { guid: res.guid, version: res.version };
      } else if (operation === 'POST') {
        const res = await client.postDocument(payload.onecGuid);
        return { guid: payload.onecGuid, version: res?.version };
      } else if (operation === 'UNPOST') {
        await client.unpostDocument(payload.onecGuid);
        return { guid: payload.onecGuid };
      }
    }

    // Справочники
    if (operation === 'CREATE') {
      const res = await client.createRef(entity, payload, entry.idempotencyKey);
      return { guid: res.guid, version: res.version };
    } else if (operation === 'UPDATE') {
      const res = await client.updateRef(entity, payload.onecGuid, payload);
      return { guid: payload.onecGuid, version: res?.version };
    }

    return null;
  }

  private async writeBackGuid(tx: any, entry: any, guid: string, version?: string) {
    const { entity, localId, connectionId } = entry;

    // Обновляем IdMap
    await tx.idMap.upsert({
      where: { connectionId_entity_localId: { connectionId, entity, localId } },
      create: { entity, localId, connectionId, onecGuid: guid, syncedAt: new Date() },
      update: { onecGuid: guid, syncedAt: new Date() },
    });

    // Обновляем mirror-запись
    if (entity === 'document') {
      await tx.document.update({
        where: { id: localId },
        data: { onecGuid: guid, onecVersion: version ?? null, syncStatus: 'SYNCED', postedIn1c: entry.operation === 'POST' ? true : undefined },
      });
    } else if (entity === 'product') {
      await tx.product.update({
        where: { id: localId },
        data: { onecGuid: guid, onecVersion: version ?? null, syncStatus: 'SYNCED' },
      });
    } else if (entity === 'counterparty') {
      await tx.counterparty.update({
        where: { id: localId },
        data: { onecGuid: guid, onecVersion: version ?? null, syncStatus: 'SYNCED' },
      });
    }
  }

  private async handleError(entry: any, err: any) {
    const attempts = entry.attempts + 1;
    const isConflict = err.response?.status === 409;
    const isBusinessError = err.response?.status === 422;
    const isTransient = !err.response || err.response.status >= 500;

    this.logger.warn(`Outbox ${entry.id} attempt ${attempts} failed: ${err.message} (status=${err.response?.status})`);

    if (isConflict) {
      // 409: объект уже существует в 1С — достаём его GUID из ответа
      const existingGuid = err.response?.data?.guid;
      if (existingGuid) {
        await this.prisma.$transaction(async (tx) => {
          await tx.outbox.update({
            where: { id: entry.id },
            data: { status: 'DONE', processedAt: new Date(), lastError: '409 ConflictAlreadyExists — wrote back existing GUID' },
          });
          await this.writeBackGuid(tx, entry, existingGuid, err.response?.data?.version);
        });
      } else {
        await this.markError(entry, attempts, '409 ConflictAlreadyExists — no guid in response');
      }
      return;
    }

    if (isBusinessError) {
      // 422: бизнес-ошибка — не повторяем, но не DEAD
      await this.prisma.outbox.update({
        where: { id: entry.id },
        data: {
          status: 'ERROR',
          attempts,
          lastError: `422 BusinessError: ${err.response?.data?.message ?? err.message}`,
        },
      });
      return;
    }

    if (attempts >= MAX_ATTEMPTS) {
      await this.prisma.outbox.update({
        where: { id: entry.id },
        data: { status: 'DEAD', attempts, lastError: err.message },
      });
      this.logger.error(`Outbox ${entry.id} DEAD after ${attempts} attempts: ${err.message}`);
      return;
    }

    // Transient — экспоненциальный backoff
    const delayMs = BACKOFF_DELAYS_MS[Math.min(attempts - 1, BACKOFF_DELAYS_MS.length - 1)];
    const nextAttemptAt = new Date(Date.now() + delayMs);
    await this.prisma.outbox.update({
      where: { id: entry.id },
      data: {
        status: 'PENDING',
        attempts,
        lastError: err.message,
        nextAttemptAt,
      },
    });
  }

  private async markError(entry: any, attempts: number, message: string) {
    await this.prisma.outbox.update({
      where: { id: entry.id },
      data: { status: 'ERROR', attempts, lastError: message },
    });
  }
}
