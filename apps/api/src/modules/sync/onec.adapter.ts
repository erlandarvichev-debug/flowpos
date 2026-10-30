import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class OnecAdapter {
  private readonly logger = new Logger(OnecAdapter.name);

  constructor(private prisma: PrismaService) {}

  private createClient(connection: any): AxiosInstance {
    return axios.create({
      baseURL: connection.baseUrl,
      auth: { username: connection.username, password: connection.passwordEnc },
      timeout: 30000,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  async syncItemsFromOnec(connectionId: string) {
    const connection = await this.prisma.onecConnection.findUnique({ where: { id: connectionId }, include: { organization: { select: { tenantId: true } } } });
    if (!connection || !connection.isActive) return;

    const cursorRow = await this.prisma.syncCursor.findUnique({
      where: { entity_connectionId: { entity: 'product', connectionId } },
    });
    let cursorTs = cursorRow?.lastTs?.toISOString() || '0001-01-01T00:00:00';
    const pageSize = 200;

    const client = this.createClient(connection);

    while (true) {
      try {
        const res = await client.get(`/odata/standard.odata/Catalog_Номенклатура`, {
          params: {
            $format: 'json',
            $top: pageSize,
            $filter: `Timestamp gt datetime'${cursorTs}'`,
            $orderby: 'Timestamp asc',
          },
        });

        const records = res.data.value || [];
        if (records.length === 0) break;

        for (const rec of records) {
          await this.upsertProduct(connectionId, connection.organization.tenantId, rec);
          cursorTs = rec.Timestamp;
        }

        if (records.length < pageSize) break;
      } catch (err) {
        this.logger.error(`Error syncing products from 1C: ${err.message}`);
        break;
      }
    }

    await this.prisma.syncCursor.upsert({
      where: { entity_connectionId: { entity: 'product', connectionId } },
      create: { entity: 'product', connectionId, lastTs: new Date(cursorTs) },
      update: { lastTs: new Date(cursorTs) },
    });
  }

  /** Товар ищется и создаётся только у клиента подключения (FP-007): GUID 1С не уникален между базами. */
  private async upsertProduct(connectionId: string, tenantId: string, rec: any) {
    const existing = await this.prisma.product.findFirst({
      where: { tenantId, onecGuid: rec.Ref_Key },
    });

    const productData = {
      name: rec.Description || rec.Наименование,
      code: rec.Code || rec.Код || rec.Ref_Key.substring(0, 8),
      onecGuid: rec.Ref_Key,
      deleted: rec.DeletionMark || false,
    };

    if (existing) {
      await this.prisma.product.update({ where: { id: existing.id }, data: productData });
    } else {
      const defaultUom = await this.prisma.uom.findFirst({ where: { tenantId, isBase: true } });
      if (defaultUom) {
        await this.prisma.product.create({ data: { ...productData, tenantId, uomId: defaultUom.id } });
      }
    }

    await this.prisma.idMap.upsert({
      where: { entity_connectionId_onecGuid: { entity: 'product', connectionId, onecGuid: rec.Ref_Key } },
      create: { entity: 'product', connectionId, localId: rec.Ref_Key, onecGuid: rec.Ref_Key },
      update: { syncedAt: new Date() },
    });
  }

  async sendToOnec(connectionId: string, operation: string, entity: string, payload: any) {
    const connection = await this.prisma.onecConnection.findUnique({ where: { id: connectionId } });
    if (!connection) throw new Error('1C connection not found');

    const client = this.createClient(connection);

    const endpointMap: Record<string, string> = {
      'create:receipt': '/hs/flowpos/receipts',
      'create:shipment': '/hs/flowpos/shipments',
      'create:goods-receipt': '/hs/flowpos/goods-receipts',
    };

    const endpoint = endpointMap[`${operation}:${entity}`];
    if (!endpoint) {
      this.logger.warn(`No endpoint for ${operation}:${entity}`);
      return;
    }

    const res = await client.post(endpoint, payload);
    return res.data;
  }
}
