import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { OutboxService } from '../../common/outbox/outbox.service';

@Injectable()
export class SalesService {
  constructor(
    private prisma: PrismaService,
    private outbox: OutboxService,
  ) {}

  async findOrders(query: { search?: string; status?: string; cursor?: string; limit?: number }) {
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
      where,
      take: limit + 1,
      include: { counterparty: true },
      orderBy: { date: 'desc' },
    });

    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? data[data.length - 1].date.toISOString() : null;

    return { data, meta: { nextCursor, hasMore } };
  }

  async findOrder(id: string) {
    const order = await this.prisma.document.findUnique({
      where: { id },
      include: { counterparty: true, lines: { include: { product: { include: { uom: true } } } } },
    });
    if (!order) throw new NotFoundException('Заказ покупателя не найден');
    return order;
  }

  async createOrder(data: any) {
    const { items, ...rest } = data;
    if (rest.date && typeof rest.date === 'string' && !rest.date.includes('T')) {
      rest.date = new Date(rest.date + 'T00:00:00.000Z');
    }
    const count = await this.prisma.document.count({ where: { docType: 'CUSTOMER_ORDER' } });
    const number = `ЗК-${String(count + 1).padStart(6, '0')}`;
    const total = items.reduce((s: number, i: any) => s + i.qty * i.price, 0);

    return this.prisma.$transaction(async (tx) => {
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
        },
        include: { counterparty: true, lines: { include: { product: true } } },
      });

      await this.outbox.enqueueInTx(tx, {
        idempotencyKey: `sales-order-${created.id}`,
        entity: 'document',
        localId: created.id,
        operation: 'CREATE',
        payload: { docType: 'CUSTOMER_ORDER', number, date: rest.date, counterpartyId: rest.counterpartyId, items },
      });

      return created;
    });
  }

  async findShipments(query: { status?: string; cursor?: string; limit?: number }) {
    const limit = Math.min(Number(query.limit) || 50, 200);
    const where: any = { docType: 'DEMAND' };
    if (query.status) where.status = query.status;
    if (query.cursor) where.date = { lt: new Date(query.cursor) };

    const rows = await this.prisma.document.findMany({
      where,
      take: limit + 1,
      include: { counterparty: true },
      orderBy: { date: 'desc' },
    });

    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? data[data.length - 1].date.toISOString() : null;

    return { data, meta: { nextCursor, hasMore } };
  }

  async createShipment(data: any) {
    const { items, ...rest } = data;
    if (rest.date && typeof rest.date === 'string' && !rest.date.includes('T')) {
      rest.date = new Date(rest.date + 'T00:00:00.000Z');
    }
    const count = await this.prisma.document.count({ where: { docType: 'DEMAND' } });
    const number = `РЛ-${String(count + 1).padStart(6, '0')}`;
    const total = items.reduce((s: number, i: any) => s + i.qty * i.price, 0);

    return this.prisma.$transaction(async (tx) => {
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
        },
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
        idempotencyKey: `shipment-${created.id}`,
        entity: 'document',
        localId: created.id,
        operation: 'CREATE',
        payload: { docType: 'DEMAND', number, date: rest.date, counterpartyId: rest.counterpartyId, items },
      });

      return created;
    });
  }

  async createPosSale(data: any, idempotencyKey: string) {
    const { items, shiftId, storeId, ...rest } = data;
    const count = await this.prisma.document.count({ where: { docType: 'RETAIL_DEMAND' } });
    const number = `ЧЕК-${String(count + 1).padStart(8, '0')}`;

    return this.prisma.$transaction(async (tx) => {
      const resolvedItems = await Promise.all(
        items.map(async (i: any) => {
          if (i.productId) return i;
          const barcode = await tx.productBarcode.findFirst({ where: { barcode: i.barcode } });
          return { ...i, productId: barcode?.productId };
        }),
      );

      const created = await tx.document.create({
        data: {
          docType: 'RETAIL_DEMAND',
          date: new Date(),
          storeId,
          ...rest,
          number,
          total: resolvedItems.reduce((s: number, i: any) => s + i.qty * i.price, 0),
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
