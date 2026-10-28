import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma.service';
import { OnecHttpClient } from '@flowpos/onec-client';
import type { OnecEntity, DeltaItem } from '@flowpos/onec-client';

const OPERATIONAL_ENTITIES: OnecEntity[] = ['product', 'counterparty', 'store', 'uom', 'price_type'];
const SLOW_ENTITIES: OnecEntity[] = ['product_group', 'currency'];

@Injectable()
export class PullService {
  private readonly logger = new Logger(PullService.name);

  constructor(private prisma: PrismaService) {}

  /** Оперативная синхронизация каждые 2 минуты */
  @Cron('*/2 * * * *')
  async pullOperational() {
    await this.pullEntities(OPERATIONAL_ENTITIES);
  }

  /** Справочники каждые 20 минут */
  @Cron('*/20 * * * *')
  async pullSlow() {
    await this.pullEntities(SLOW_ENTITIES);
  }

  async pullEntities(entities: OnecEntity[]) {
    const connections = await this.prisma.onecConnection.findMany({ where: { isActive: true } });

    for (const conn of connections) {
      const client = new OnecHttpClient({
        baseUrl: conn.baseUrl,
        baseCode: conn.baseCode,
        username: conn.username,
        password: conn.passwordEnc,
        instanceType: conn.instanceType,
      });

      for (const entity of entities) {
        await this.pullEntity(client, conn.id, conn.baseCode, entity);
      }
    }
  }

  private async pullEntity(
    client: OnecHttpClient,
    connectionId: string,
    baseCode: string,
    entity: OnecEntity,
  ) {
    const startedAt = new Date();
    let count = 0;
    let error: string | undefined;

    try {
      const cursor = await this.prisma.syncCursor.findUnique({
        where: { entity_connectionId: { entity, connectionId } },
      });

      let since = cursor?.lastTs?.toISOString() ?? '2000-01-01T00:00:00Z';
      let afterGuid = cursor?.lastGuid ?? undefined;

      while (true) {
        const resp = await client.getDelta(entity, since, afterGuid, 500);

        if (resp.items.length > 0) {
          await this.prisma.$transaction(async (tx) => {
            for (const item of resp.items) {
              await this.upsertMirror(tx, entity, baseCode, connectionId, item);
              count++;
            }

            await tx.syncCursor.upsert({
              where: { entity_connectionId: { entity, connectionId } },
              create: { entity, connectionId, lastTs: new Date(resp.nextSince), lastGuid: resp.nextGuid ?? null },
              update: { lastTs: new Date(resp.nextSince), lastGuid: resp.nextGuid ?? null },
            });
          });
        }

        since = resp.nextSince;
        afterGuid = resp.nextGuid;
        if (!resp.hasMore) break;
      }
    } catch (err: any) {
      error = err.message;
      this.logger.error(`Pull ${entity} from ${baseCode} failed: ${err.message}`);
    }

    await this.prisma.syncLog.create({
      data: {
        direction: 'PULL',
        entity,
        connectionId,
        ok: !error,
        count,
        error: error ?? null,
        startedAt,
        finishedAt: new Date(),
      },
    });
  }

  private async upsertMirror(tx: any, entity: OnecEntity, baseCode: string, connectionId: string, item: DeltaItem) {
    const { guid, version, data, deletionMark } = item;

    switch (entity) {
      case 'product':
        await this.upsertProduct(tx, baseCode, guid, version, data, deletionMark);
        break;
      case 'counterparty':
        await this.upsertCounterparty(tx, baseCode, guid, version, data, deletionMark);
        break;
      case 'store':
        await this.upsertStore(tx, baseCode, guid, version, data, deletionMark);
        break;
      case 'product_group':
        await this.upsertProductGroup(tx, baseCode, guid, version, data, deletionMark);
        break;
      case 'uom':
        await this.upsertUom(tx, baseCode, guid, data, deletionMark);
        break;
    }

    await tx.idMap.upsert({
      where: { entity_localId: { entity, localId: guid } },
      create: { entity, localId: guid, connectionId, onecGuid: guid, syncedAt: new Date() },
      update: { syncedAt: new Date() },
    });
  }

  private async upsertProduct(tx: any, base: string, guid: string, version: string, d: any, deleted: boolean) {
    const existing = await tx.product.findFirst({ where: { onecBase: base, onecGuid: guid } });

    if (existing) {
      if (existing.syncStatus === 'DIRTY' || existing.syncStatus === 'CONFLICT') {
        // Конфликт — нельзя просто затереть
        await tx.product.update({
          where: { id: existing.id },
          data: { syncStatus: 'CONFLICT', onecVersion: version },
        });
        return;
      }
      await tx.product.update({
        where: { id: existing.id },
        data: {
          name: d.name ?? existing.name,
          code: d.code ?? existing.code,
          article: d.article,
          barcode: d.barcode,
          vatRate: d.vat_rate,
          deleted,
          onecVersion: version,
          syncStatus: 'SYNCED',
          updatedAt: new Date(),
        },
      });
    } else {
      const defaultUom = await tx.uom.findFirst({ where: { isBase: true } });
      await tx.product.create({
        data: {
          name: d.name ?? 'Без имени',
          code: d.code,
          article: d.article,
          barcode: d.barcode,
          vatRate: d.vat_rate,
          uomId: d.uom_guid
            ? (await tx.uom.findFirst({ where: { onecGuid: d.uom_guid } }))?.id ?? defaultUom?.id ?? ''
            : defaultUom?.id ?? '',
          onecGuid: guid,
          onecBase: base,
          onecVersion: version,
          syncStatus: 'SYNCED',
          owner: 'C1',
          deleted,
        },
      });
    }
  }

  private async upsertCounterparty(tx: any, base: string, guid: string, version: string, d: any, deleted: boolean) {
    const existing = await tx.counterparty.findFirst({ where: { onecBase: base, onecGuid: guid } });
    const payload = {
      name: d.name ?? 'Без имени',
      inn: d.inn,
      kpp: d.kpp,
      phone: d.phone,
      email: d.email,
      deleted,
      onecVersion: version,
      syncStatus: 'SYNCED',
    };
    if (existing) {
      if (existing.syncStatus === 'DIRTY') {
        await tx.counterparty.update({ where: { id: existing.id }, data: { syncStatus: 'CONFLICT', onecVersion: version } });
        return;
      }
      await tx.counterparty.update({ where: { id: existing.id }, data: payload });
    } else {
      await tx.counterparty.create({ data: { ...payload, onecGuid: guid, onecBase: base, owner: 'C1' } });
    }
  }

  private async upsertStore(tx: any, base: string, guid: string, version: string, d: any, deleted: boolean) {
    const existing = await tx.store.findFirst({ where: { onecBase: base, onecGuid: guid } });
    const payload = { name: d.name ?? 'Без имени', code: d.code, deleted, syncStatus: 'SYNCED' };
    if (existing) {
      await tx.store.update({ where: { id: existing.id }, data: payload });
    } else {
      const org = await tx.organization.findFirst();
      await tx.store.create({ data: { ...payload, onecGuid: guid, onecBase: base, organizationId: org?.id ?? '', owner: 'C1' } });
    }
  }

  private async upsertProductGroup(tx: any, base: string, guid: string, version: string, d: any, deleted: boolean) {
    const existing = await tx.productGroup.findFirst({ where: { onecBase: base, onecGuid: guid } });
    const payload = { name: d.name ?? 'Без имени', code: d.code, deleted, syncStatus: 'SYNCED' };
    if (existing) {
      await tx.productGroup.update({ where: { id: existing.id }, data: payload });
    } else {
      await tx.productGroup.create({ data: { ...payload, onecGuid: guid, onecBase: base, owner: 'C1' } });
    }
  }

  private async upsertUom(tx: any, base: string, guid: string, d: any, deleted: boolean) {
    const existing = await tx.uom.findFirst({ where: { onecBase: base, onecGuid: guid } });
    if (existing) {
      await tx.uom.update({ where: { id: existing.id }, data: { name: d.name, shortName: d.short_name ?? d.name, deleted } });
    } else {
      await tx.uom.create({ data: { name: d.name, shortName: d.short_name ?? d.name, onecGuid: guid, onecBase: base, deleted } });
    }
  }
}
