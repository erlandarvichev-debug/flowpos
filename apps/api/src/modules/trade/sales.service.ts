import { Prisma } from '@prisma/client';
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { OutboxService } from '../../common/outbox/outbox.service';
import { Scope } from '../../common/scope';
import { assertTradeRefs, docHeader, nextNumber, orgDocs } from './trade-scope';

@Injectable()
export class SalesService {
  constructor(
    private prisma: PrismaService,
    private outbox: OutboxService,
  ) {}

  async findOrders(s: Scope, query: { search?: string; status?: string; cursor?: string; limit?: number }) {
    const limit = Math.min(Number(query.limit) || 50, 200);
    const where: any = { docType: 'CUSTOMER_ORDER' };
    if (query.status) where.status = query.status;
    if (query.search) {
      where.OR = [
        { number: { contains: query.search } },
        { counterparty: { name: { contains: query.search, mode: 'insensitive' } } },
      ];
    }
    if (query.cursor) where.date = { lt: new Date(query.cursor) };

    const rows = await this.prisma.document.findMany({
      where: orgDocs(s, where),
      take: limit + 1,
      include: { counterparty: true },
      orderBy: { date: 'desc' },
    });

    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? data[data.length - 1].date.toISOString() : null;

    return { data, meta: { nextCursor, hasMore } };
  }

  async findOrder(s: Scope, id: string) {
    const order = await this.prisma.document.findFirst({
      where: orgDocs(s, { id, docType: 'CUSTOMER_ORDER' }),
      include: { counterparty: true, lines: { include: { product: { include: { uom: true } } } } },
    });
    if (!order) throw new NotFoundException('Заказ покупателя не найден');
    return order;
  }

  async createOrder(s: Scope, data: any) {
    const items: any[] = data?.items ?? [];
    const rest = docHeader(s, data);
    const total = items.reduce((sum: number, i: any) => sum + i.qty * i.price, 0);

    return this.prisma.$transaction(async (tx) => {
      await assertTradeRefs(tx, s, { counterpartyId: rest.counterpartyId, contractId: rest.contractId, storeIds: [rest.storeId], productIds: items.map((i) => i.productId) });
      const number = await nextNumber(tx, s, 'CUSTOMER_ORDER', 'ЗК', 6);
      const created = await tx.document.create({
        data: {
          docType: 'CUSTOMER_ORDER',
          ...rest,
          number,
          total,
          lines: {
            create: items.map((i: any, idx: number) => ({
              lineNo: idx + 1,
              productId: i.productId,
              qty: i.qty,
              price: i.price,
              amount: i.qty * i.price,
            })),
          },
        } as Prisma.DocumentUncheckedCreateInput,
        include: { counterparty: true, lines: { include: { product: true } } },
      });

      await this.outbox.enqueueInTx(tx, {
        tenantId: s.tenantId,
        idempotencyKey: `sales-order-${created.id}`,
        entity: 'document',
        localId: created.id,
        operation: 'CREATE',
        payload: { docType: 'CUSTOMER_ORDER', number, date: rest.date, counterpartyId: rest.counterpartyId, items },
      });

      return created;
    });
  }

  async findShipments(s: Scope, query: { status?: string; cursor?: string; limit?: number }) {
    const limit = Math.min(Number(query.limit) || 50, 200);
    const where: any = { docType: 'DEMAND' };
    if (query.status) where.status = query.status;
    if (query.cursor) where.date = { lt: new Date(query.cursor) };

    const rows = await this.prisma.document.findMany({
      where: orgDocs(s, where),
      take: limit + 1,
      include: { counterparty: true },
      orderBy: { date: 'desc' },
    });

    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? data[data.length - 1].date.toISOString() : null;

    return { data, meta: { nextCursor, hasMore } };
  }

  async createShipment(s: Scope, data: any) {
    const items: any[] = data?.items ?? [];
    const rest = docHeader(s, data);
    const total = items.reduce((sum: number, i: any) => sum + i.qty * i.price, 0);

    return this.prisma.$transaction(async (tx) => {
      await assertTradeRefs(tx, s, { counterpartyId: rest.counterpartyId, contractId: rest.contractId, storeIds: [rest.storeId], productIds: items.map((i) => i.productId) });
      const number = await nextNumber(tx, s, 'DEMAND', 'РЛ', 6);
      const created = await tx.document.create({
        data: {
          docType: 'DEMAND',
          ...rest,
          number,
          total,
          lines: {
            create: items.map((i: any, idx: number) => ({
              lineNo: idx + 1,
              productId: i.productId,
              qty: i.qty,
              price: i.price,
              amount: i.qty * i.price,
            })),
          },
        } as Prisma.DocumentUncheckedCreateInput,
        include: { lines: { include: { product: true } } },
      });

      if (rest.status === 'POSTED' && rest.storeId) {
        for (const item of items) {
          await tx.stock.updateMany({
            where: { productId: item.productId, storeId: rest.storeId },
            data: { qty: { decrement: item.qty } },
          });
        }
      }

      await this.outbox.enqueueInTx(tx, {
        tenantId: s.tenantId,
        idempotencyKey: `shipment-${created.id}`,
        entity: 'document',
        localId: created.id,
        operation: 'CREATE',
        payload: { docType: 'DEMAND', number, date: rest.date, counterpartyId: rest.counterpartyId, items },
      });

      return created;
    });
  }

  async createPosSale(s: Scope, data: any, idempotencyKey: string) {
    const items: any[] = data?.items ?? [];
    const { shiftId, storeId } = data ?? {};
    const rest = docHeader(s, { ...data, storeId: undefined, date: undefined });

    return this.prisma.$transaction(async (tx) => {
      // Штрихкод ищется только в справочнике своего клиента: одинаковый код у другого клиента — не наш товар.
      const resolvedItems = await Promise.all(
        items.map(async (i: any) => {
          if (i.productId) return i;
          const barcode = await tx.productBarcode.findFirst({ where: { barcode: i.barcode, tenantId: s.tenantId, product: { OR: [{ organizationId: null }, { organizationId: s.organizationId }] } } });
          return { ...i, productId: barcode?.productId };
        }),
      );
      await assertTradeRefs(tx, s, { counterpartyId: rest.counterpartyId, storeIds: [storeId], productIds: resolvedItems.map((i) => i.productId) });
      const number = await nextNumber(tx, s, 'RETAIL_DEMAND', 'ЧЕК', 8);

      const created = await tx.document.create({
        data: {
          docType: 'RETAIL_DEMAND',
          date: new Date(),
          storeId,
          ...rest,
          number,
          total: resolvedItems.reduce((sum: number, i: any) => sum + i.qty * i.price, 0),
          lines: {
            create: resolvedItems.map((i: any, idx: number) => ({
              lineNo: idx + 1,
              productId: i.productId,
              qty: i.qty,
              price: i.price,
              amount: i.qty * i.price,
            })),
          },
        },
      });

      await this.outbox.enqueueInTx(tx, {
        idempotencyKey,
        entity: 'document',
        localId: created.id,
        operation: 'CREATE',
        payload: { docType: 'RETAIL_DEMAND', number, shiftId, storeId, items: resolvedItems },
      });

      return created;
    });
  }
}
