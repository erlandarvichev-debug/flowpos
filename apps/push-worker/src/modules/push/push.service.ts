import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { randomBytes } from 'crypto';
import { hostname } from 'os';
import { PrismaService, runAsSystem, runAsTenant } from '../../prisma.service';
import { OnecHttpClient } from '@flowpos/onec-client';
import { Outcome, classify } from './retry-policy';

const BATCH_SIZE = 50;
/** Аренда записи воркером. Дольше одной отправки (таймаут клиента 1С — 30 с) с запасом. */
export const LEASE_MS = 5 * 60_000;

/** Запись outbox, захваченная этим воркером (поля сырого SQL — в camelCase). */
export interface ClaimedEntry {
  id: string;
  tenantId: string;
  idempotencyKey: string;
  entity: string;
  localId: string;
  connectionId: string;
  operation: string;
  payload: any;
  attempts: number;
  fencingVersion: number;
  conn: { baseUrl: string; baseCode: string; username: string; password: string; instanceType: string };
}

/**
 * FP-021: отправка outbox в 1С с арендой (lease) и fencing.
 * - Захват — одним UPDATE … FOR UPDATE SKIP LOCKED: запись получает владельца, срок аренды и новую fencing_version.
 * - Любое подтверждение (DONE, повтор, UNKNOWN, DLQ) — условное: id + lease_owner + fencing_version + SENDING.
 *   Воркер, чья аренда истекла и перешла к другому, ничего не подтверждает и не записывает GUID.
 * - Перед сетью stage = SENDING (тоже условно): устаревший воркер до отправки не доходит.
 * - Истёкшая аренда: stage CLAIMED (до сети не дошли) — запись можно взять снова; stage SENDING — UNKNOWN
 *   (истёкший lease не доказывает неотправку), без автоматического повтора.
 * - Повторы — retry-policy.ts: jitter, Retry-After, без повтора небезопасного этапа.
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private running = false;
  readonly workerId: string;

  constructor(private prisma: PrismaService, @Optional() workerId?: string) {
    this.workerId = workerId ?? `${hostname()}:${process.pid}:${randomBytes(4).toString('hex')}`;
  }

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

  async processBatch() {
    await this.recoverExpired();
    const entries = await this.claim(BATCH_SIZE);
    for (const entry of entries) await this.processEntry(entry);
    return entries.length;
  }

  /** Аренда истекла после начала отправки — результат неизвестен: UNKNOWN, не повторяем. */
  async recoverExpired(): Promise<number> {
    return runAsSystem(() => this.prisma.$executeRaw`
      UPDATE outbox SET status = 'UNKNOWN', lease_owner = NULL, lease_until = NULL, updated_at = NOW(),
             last_error = 'Аренда истекла после начала отправки — 1С могла принять запрос; нужна сверка'
       WHERE status = 'SENDING' AND stage = 'SENDING' AND lease_until < NOW()`);
  }

  /**
   * Захватить до n записей: ожидающие, срок которых настал, и брошенные до отправки (аренда истекла на CLAIMED).
   * Только записи, чьё подключение 1С принадлежит организации того же клиента (FP-009).
   */
  async claim(n: number): Promise<ClaimedEntry[]> {
    const rows: any[] = await runAsSystem(() => this.prisma.$queryRaw`
      UPDATE outbox o
         SET status = 'SENDING', stage = 'CLAIMED', lease_owner = ${this.workerId},
             lease_until = NOW() + (${LEASE_MS} * INTERVAL '1 millisecond'),
             fencing_version = o.fencing_version + 1, attempts = o.attempts + 1, updated_at = NOW()
        FROM (
          SELECT q.id FROM outbox q
            JOIN onec_connections qc ON qc.id = q.connection_id
            JOIN organizations qorg ON qorg.id = qc.organization_id AND qorg.tenant_id = q.tenant_id
           WHERE (q.status = 'PENDING' AND q.next_attempt_at <= NOW())
              OR (q.status = 'SENDING' AND q.stage = 'CLAIMED' AND q.lease_until < NOW())
           ORDER BY q.next_attempt_at
           LIMIT ${n}
           FOR UPDATE OF q SKIP LOCKED
        ) picked, onec_connections c
       WHERE o.id = picked.id AND c.id = o.connection_id
   RETURNING o.id, o.tenant_id, o.idempotency_key, o.entity, o.local_id, o.connection_id, o.operation, o.payload,
             o.attempts, o.fencing_version, c.base_url, c.base_code, c.username, c.password_enc, c.instance_type`);
    return rows.map((r) => ({
      id: r.id, tenantId: r.tenant_id, idempotencyKey: r.idempotency_key, entity: r.entity, localId: r.local_id,
      connectionId: r.connection_id, operation: r.operation, payload: r.payload, attempts: r.attempts, fencingVersion: r.fencing_version,
      conn: { baseUrl: r.base_url, baseCode: r.base_code, username: r.username, password: r.password_enc, instanceType: r.instance_type },
    }));
  }

  /** Условие «аренда всё ещё моя»: без него подтверждение устаревшего воркера перезаписало бы чужой результат. */
  private fence(e: ClaimedEntry) {
    return { id: e.id, leaseOwner: this.workerId, fencingVersion: e.fencingVersion, status: 'SENDING' as const };
  }

  /** Клиент 1С (переопределяется в тестах). */
  protected createClient(e: ClaimedEntry): Pick<OnecHttpClient, 'createDocument' | 'postDocument' | 'unpostDocument' | 'deleteRef' | 'createRef' | 'updateRef'> {
    return new OnecHttpClient({ baseUrl: e.conn.baseUrl, baseCode: e.conn.baseCode, username: e.conn.username, password: e.conn.password, instanceType: e.conn.instanceType as any });
  }

  /**
   * Повтор безопасен, только если 1С подтверждённо идемпотентна по ключу (ONEC_IDEMPOTENCY_CONFIRMED=1 после
   * проверки на реальной базе) и операция отправляет ключ: создание и обновление документа, создание справочника.
   */
  private idempotentSafe(e: ClaimedEntry) {
    if (process.env.ONEC_IDEMPOTENCY_CONFIRMED !== '1') return false;
    return e.operation === 'CREATE' || (e.entity === 'document' && e.operation === 'UPDATE');
  }

  /** Отправка и запись результата — всегда от имени клиента записи (FP-009, RLS). */
  processEntry(e: ClaimedEntry): Promise<'DONE' | 'STALE' | Outcome['kind']> {
    return runAsTenant(e.tenantId, () => this.attempt(e));
  }

  private async attempt(e: ClaimedEntry): Promise<'DONE' | 'STALE' | Outcome['kind']> {
    // До сети: отметить, что попытка начинает отправку. Не вышло — аренда уже не наша, не отправляем.
    const started = await this.prisma.outbox.updateMany({ where: this.fence(e), data: { stage: 'SENDING' } });
    if (started.count !== 1) {
      this.logger.warn(`Outbox ${e.id}: аренда перешла к другому воркеру до отправки — пропуск`);
      return 'STALE';
    }

    let result: { guid: string; version?: string } | null;
    try {
      result = await this.sendToOnec(this.createClient(e) as OnecHttpClient, e);
    } catch (err: any) {
      return this.onFailure(e, err);
    }
    return this.complete(e, result?.guid, result?.version, null);
  }

  /** DONE + GUID обратно в FlowPOS — одной транзакцией и только при своей аренде. */
  private async complete(e: ClaimedEntry, guid: string | undefined, version: string | undefined, note: string | null): Promise<'DONE' | 'STALE'> {
    const ok = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.outbox.updateMany({
        where: this.fence(e),
        data: { status: 'DONE', stage: null, leaseOwner: null, leaseUntil: null, processedAt: new Date(), lastError: note },
      });
      if (count !== 1) return false;
      if (guid) await this.writeBackGuid(tx, e, guid, version);
      return true;
    });
    if (!ok) {
      this.logger.warn(`Outbox ${e.id}: результат не подтверждён — аренда перешла к другому воркеру`);
      return 'STALE';
    }
    this.logger.log(`Outbox ${e.id} (${e.entity}/${e.operation}) → DONE`);
    return 'DONE';
  }

  private async onFailure(e: ClaimedEntry, err: any): Promise<'DONE' | 'STALE' | Outcome['kind']> {
    // 409: объект уже есть в 1С и она вернула его GUID — это успех, а не ошибка.
    if (err?.response?.status === 409 && err.response.data?.guid) {
      return this.complete(e, err.response.data.guid, err.response.data.version, '409 — объект уже есть в 1С, записан его GUID');
    }
    const outcome = classify(err, e.attempts, this.idempotentSafe(e));
    const release = { stage: null, leaseOwner: null, leaseUntil: null, lastError: outcome.reason };
    const data =
      outcome.kind === 'RETRY'
        ? { ...release, status: 'PENDING' as const, nextAttemptAt: new Date(Date.now() + outcome.delayMs) }
        : { ...release, status: outcome.kind };
    const { count } = await this.prisma.outbox.updateMany({ where: this.fence(e), data });
    if (count !== 1) {
      this.logger.warn(`Outbox ${e.id}: ошибка не записана — аренда перешла к другому воркеру`);
      return 'STALE';
    }
    this.logger.warn(`Outbox ${e.id} попытка ${e.attempts}: ${outcome.kind} — ${outcome.reason}`);
    return outcome.kind;
  }

  private async sendToOnec(client: OnecHttpClient, entry: ClaimedEntry): Promise<{ guid: string; version?: string } | null> {
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

  private async writeBackGuid(tx: any, entry: ClaimedEntry, guid: string, version?: string) {
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
}
