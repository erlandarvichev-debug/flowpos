import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../prisma.service';
import { MoyskladHttpClient, MsProduct, MsCounterparty, MsStore, MsProductFolder, MsUom } from '@flowpos/moysklad-client';

/** Клиент и организация подключения: всё, что пришло из этого аккаунта МойСклад, пишется только сюда (FP-007). */
interface SyncScope {
  tenantId: string;
  organizationId: string;
}
const scopeOf = (conn: { organizationId: string; organization: { tenantId: string } }): SyncScope => ({ tenantId: conn.organization.tenantId, organizationId: conn.organizationId });

@Injectable()
export class MsPullService {
  private readonly logger = new Logger(MsPullService.name);

  constructor(private prisma: PrismaService) {}

  /** Товары, контрагенты, склады — каждые 5 минут */
  @Cron('*/5 * * * *')
  async pullOperational() {
    const connections = await this.prisma.moyskladConnection.findMany({ where: { isActive: true }, include: { organization: { select: { tenantId: true } } } });
    for (const conn of connections) {
      const client = new MoyskladHttpClient({ token: conn.tokenEnc });
      const sc = scopeOf(conn);
      await Promise.all([
        this.pullProducts(client, sc, conn.id, conn.accountId),
        this.pullCounterparties(client, sc, conn.id, conn.accountId),
        this.pullStores(client, sc, conn.id, conn.accountId),
      ]);
    }
  }

  /** Справочники — каждые 30 минут */
  @Cron('*/30 * * * *')
  async pullSlow() {
    const connections = await this.prisma.moyskladConnection.findMany({ where: { isActive: true }, include: { organization: { select: { tenantId: true } } } });
    for (const conn of connections) {
      const client = new MoyskladHttpClient({ token: conn.tokenEnc });
      const sc = scopeOf(conn);
      await Promise.all([
        this.pullProductFolders(client, sc, conn.id, conn.accountId),
        this.pullUoms(client, sc, conn.id, conn.accountId),
      ]);
    }
  }

  private async getLastUpdated(connectionId: string, entity: string): Promise<string | undefined> {
    const cursor = await this.prisma.moyskladSyncCursor.findUnique({
      where: { entity_connectionId: { entity, connectionId } },
    });
    return cursor?.lastUpdated?.toISOString();
  }

  private async saveCursor(connectionId: string, entity: string, lastUpdated: string) {
    await this.prisma.moyskladSyncCursor.upsert({
      where: { entity_connectionId: { entity, connectionId } },
      create: { entity, connectionId, lastUpdated: new Date(lastUpdated) },
      update: { lastUpdated: new Date(lastUpdated) },
    });
  }

  private async pullProducts(client: MoyskladHttpClient, sc: SyncScope, connectionId: string, accountId: string) {
    const startedAt = new Date();
    let count = 0;
    let error: string | undefined;
    let lastUpdated: string | undefined;

    try {
      const since = await this.getLastUpdated(connectionId, 'product');
      const gen = await client.getProducts(since);

      for await (const batch of gen) {
        await this.prisma.$transaction(async (tx) => {
          for (const item of batch) {
            await this.upsertProduct(tx, sc, item, connectionId, accountId);
            count++;
            lastUpdated = item.updated;
          }
        });
      }

      if (lastUpdated) await this.saveCursor(connectionId, 'product', lastUpdated);
    } catch (err: any) {
      error = err.message;
      this.logger.error(`Pull products failed: ${err.message}`);
    }

    await this.prisma.moyskladSyncLog.create({
      data: { direction: 'PULL', entity: 'product', connectionId, ok: !error, count, error: error ?? null, startedAt, finishedAt: new Date() },
    });
  }

  private async pullCounterparties(client: MoyskladHttpClient, sc: SyncScope, connectionId: string, accountId: string) {
    const startedAt = new Date();
    let count = 0;
    let error: string | undefined;
    let lastUpdated: string | undefined;

    try {
      const since = await this.getLastUpdated(connectionId, 'counterparty');
      const gen = await client.getCounterparties(since);

      for await (const batch of gen) {
        await this.prisma.$transaction(async (tx) => {
          for (const item of batch) {
            await this.upsertCounterparty(tx, sc, item, connectionId, accountId);
            count++;
            lastUpdated = item.updated;
          }
        });
      }

      if (lastUpdated) await this.saveCursor(connectionId, 'counterparty', lastUpdated);
    } catch (err: any) {
      error = err.message;
      this.logger.error(`Pull counterparties failed: ${err.message}`);
    }

    await this.prisma.moyskladSyncLog.create({
      data: { direction: 'PULL', entity: 'counterparty', connectionId, ok: !error, count, error: error ?? null, startedAt, finishedAt: new Date() },
    });
  }

  private async pullStores(client: MoyskladHttpClient, sc: SyncScope, connectionId: string, accountId: string) {
    const startedAt = new Date();
    let count = 0;
    let error: string | undefined;
    let lastUpdated: string | undefined;

    try {
      const since = await this.getLastUpdated(connectionId, 'store');
      const gen = await client.getStores(since);

      for await (const batch of gen) {
        await this.prisma.$transaction(async (tx) => {
          for (const item of batch) {
            await this.upsertStore(tx, sc, item, connectionId, accountId);
            count++;
            lastUpdated = item.updated;
          }
        });
      }

      if (lastUpdated) await this.saveCursor(connectionId, 'store', lastUpdated);
    } catch (err: any) {
      error = err.message;
      this.logger.error(`Pull stores failed: ${err.message}`);
    }

    await this.prisma.moyskladSyncLog.create({
      data: { direction: 'PULL', entity: 'store', connectionId, ok: !error, count, error: error ?? null, startedAt, finishedAt: new Date() },
    });
  }

  private async pullProductFolders(client: MoyskladHttpClient, sc: SyncScope, connectionId: string, accountId: string) {
    const startedAt = new Date();
    let count = 0;
    let error: string | undefined;
    let lastUpdated: string | undefined;

    try {
      const since = await this.getLastUpdated(connectionId, 'productfolder');
      const gen = await client.getProductFolders(since);

      for await (const batch of gen) {
        await this.prisma.$transaction(async (tx) => {
          for (const item of batch) {
            await this.upsertProductFolder(tx, sc, item, connectionId, accountId);
            count++;
            lastUpdated = item.updated;
          }
        });
      }

      if (lastUpdated) await this.saveCursor(connectionId, 'productfolder', lastUpdated);
    } catch (err: any) {
      error = err.message;
      this.logger.error(`Pull product folders failed: ${err.message}`);
    }

    await this.prisma.moyskladSyncLog.create({
      data: { direction: 'PULL', entity: 'productfolder', connectionId, ok: !error, count, error: error ?? null, startedAt, finishedAt: new Date() },
    });
  }

  private async pullUoms(client: MoyskladHttpClient, sc: SyncScope, connectionId: string, accountId: string) {
    const startedAt = new Date();
    let count = 0;
    let error: string | undefined;
    let lastUpdated: string | undefined;

    try {
      const since = await this.getLastUpdated(connectionId, 'uom');
      const gen = await client.getUoms(since);

      for await (const batch of gen) {
        await this.prisma.$transaction(async (tx) => {
          for (const item of batch) {
            await this.upsertUom(tx, sc, item, connectionId, accountId);
            count++;
            lastUpdated = item.updated;
          }
        });
      }

      if (lastUpdated) await this.saveCursor(connectionId, 'uom', lastUpdated);
    } catch (err: any) {
      error = err.message;
      this.logger.error(`Pull uoms failed: ${err.message}`);
    }

    await this.prisma.moyskladSyncLog.create({
      data: { direction: 'PULL', entity: 'uom', connectionId, ok: !error, count, error: error ?? null, startedAt, finishedAt: new Date() },
    });
  }

  private async upsertProduct(tx: any, sc: SyncScope, item: MsProduct, connectionId: string, accountId: string) {
    const deleted = item.deleted ?? item.archived ?? false;
    const existing = await tx.product.findFirst({ where: { tenantId: sc.tenantId, msId: item.id, msAccountId: accountId } });
    const defaultUom = await tx.uom.findFirst({ where: { tenantId: sc.tenantId, isBase: true } });

    const uomId = item.uom?.id
      ? (await tx.uom.findFirst({ where: { tenantId: sc.tenantId, msId: item.uom.id } }))?.id ?? defaultUom?.id ?? ''
      : defaultUom?.id ?? '';

    const groupId = item.productFolder?.id
      ? (await tx.productGroup.findFirst({ where: { tenantId: sc.tenantId, msId: item.productFolder.id } }))?.id ?? null
      : null;

    const barcode = item.barcodes?.[0]?.ean13 ?? item.barcodes?.[0]?.ean8 ?? item.barcodes?.[0]?.code128 ?? null;

    if (existing) {
      if (existing.syncStatus === 'DIRTY' || existing.syncStatus === 'CONFLICT') {
        await tx.product.update({ where: { id: existing.id }, data: { syncStatus: 'CONFLICT', msUpdated: new Date(item.updated) } });
        return;
      }
      await tx.product.update({
        where: { id: existing.id },
        data: { name: item.name, code: item.code, article: item.article, barcode, groupId, uomId, deleted, msUpdated: new Date(item.updated), syncStatus: 'SYNCED', updatedAt: new Date() },
      });
    } else {
      await tx.product.create({
        data: { tenantId: sc.tenantId, name: item.name, code: item.code, article: item.article, barcode, groupId, uomId: uomId || '', msId: item.id, msAccountId: accountId, msConnectionId: connectionId, msUpdated: new Date(item.updated), syncStatus: 'SYNCED', owner: 'C1', deleted },
      });
    }
  }

  private async upsertCounterparty(tx: any, sc: SyncScope, item: MsCounterparty, connectionId: string, accountId: string) {
    const deleted = item.deleted ?? item.archived ?? false;
    const existing = await tx.counterparty.findFirst({ where: { tenantId: sc.tenantId, msId: item.id, msAccountId: accountId } });
    const payload = { name: item.name, fullName: item.fullName ?? null, inn: item.inn ?? null, kpp: item.kpp ?? null, phone: item.phone ?? null, email: item.email ?? null, deleted, msUpdated: new Date(item.updated), syncStatus: 'SYNCED' };

    if (existing) {
      if (existing.syncStatus === 'DIRTY') {
        await tx.counterparty.update({ where: { id: existing.id }, data: { syncStatus: 'CONFLICT', msUpdated: new Date(item.updated) } });
        return;
      }
      await tx.counterparty.update({ where: { id: existing.id }, data: payload });
    } else {
      await tx.counterparty.create({ data: { ...payload, tenantId: sc.tenantId, msId: item.id, msAccountId: accountId, msConnectionId: connectionId, owner: 'C1' } });
    }
  }

  private async upsertStore(tx: any, sc: SyncScope, item: MsStore, connectionId: string, accountId: string) {
    const deleted = item.deleted ?? item.archived ?? false;
    const existing = await tx.store.findFirst({ where: { organizationId: sc.organizationId, msId: item.id, msAccountId: accountId } });
    const payload = { name: item.name, code: item.code ?? null, address: item.address ?? null, deleted, msUpdated: new Date(item.updated), syncStatus: 'SYNCED' };

    if (existing) {
      await tx.store.update({ where: { id: existing.id }, data: payload });
    } else {
      // Склад — в организации подключения (раньше — в первой попавшейся организации базы).
      await tx.store.create({ data: { ...payload, msId: item.id, msAccountId: accountId, msConnectionId: connectionId, tenantId: sc.tenantId, organizationId: sc.organizationId, owner: 'C1' } });
    }
  }

  private async upsertProductFolder(tx: any, sc: SyncScope, item: MsProductFolder, connectionId: string, accountId: string) {
    const deleted = item.deleted ?? item.archived ?? false;
    const existing = await tx.productGroup.findFirst({ where: { tenantId: sc.tenantId, msId: item.id, msAccountId: accountId } });
    const payload = { name: item.name, code: item.code ?? null, deleted, msUpdated: new Date(item.updated), syncStatus: 'SYNCED' };

    if (existing) {
      await tx.productGroup.update({ where: { id: existing.id }, data: payload });
    } else {
      await tx.productGroup.create({ data: { ...payload, tenantId: sc.tenantId, msId: item.id, msAccountId: accountId, msConnectionId: connectionId, owner: 'C1' } });
    }
  }

  private async upsertUom(tx: any, sc: SyncScope, item: MsUom, connectionId: string, accountId: string) {
    const existing = await tx.uom.findFirst({ where: { tenantId: sc.tenantId, msId: item.id, msAccountId: accountId } });
    const payload = { name: item.name, shortName: item.code ?? item.name, msUpdated: new Date(item.updated) };

    if (existing) {
      await tx.uom.update({ where: { id: existing.id }, data: payload });
    } else {
      await tx.uom.create({ data: { ...payload, tenantId: sc.tenantId, msId: item.id, msAccountId: accountId, msConnectionId: connectionId } });
    }
  }
}
