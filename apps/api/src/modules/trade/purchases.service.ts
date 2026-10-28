import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { OutboxService } from '../../common/outbox/outbox.service';

@Injectable()
export class PurchasesService {
  constructor(
    private prisma: PrismaService,
    private outbox: OutboxService,
  ) {}

  async findOrders(query: { search?: string; status?: string; cursor?: string; limit?: number }) {
    const limit = Math.min(Number(query.limit) || 50, 200);
    const where: any = { docType: 'PURCHASE_ORDER' };
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
    if (!order) throw new NotFoundException('Заказ поставщику не найден');
    return order;
  }

  async createOrder(data: any) {
    const { items, ...rest } = data;
    const count = await this.prisma.document.count({ where: { docType: 'PURCHASE_ORDER' } });
    const number = `ЗП-${String(count + 1).padStart(6, '0')}`;
    const total = items.reduce((s: number, i: any) => s + i.qty * i.price, 0);

    return this.prisma.$transaction(async (tx) => {
      if (rest.date && typeof rest.date === 'string' && !rest.date.includes('T')) {
        rest.date = new Date(rest.date + 'T00:00:00.000Z');
      }
      const created = await tx.document.create({
        data: {
          docType: 'PURCHASE_ORDER',
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
        idempotencyKey: `purchase-order-${created.id}`,
        entity: 'document',
        localId: created.id,
        operation: 'CREATE',
        payload: { docType: 'PURCHASE_ORDER', number, date: rest.date, counterpartyId: rest.counterpartyId, items },
      });

      return created;
    });
  }

  async updateOrder(id: string, data: any) {
    await this.findOrder(id);
    const { items, ...rest } = data;
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.document.update({ where: { id }, data: rest });

      await this.outbox.enqueueInTx(tx, {
        idempotencyKey: `purchase-order-update-${id}-${Date.now()}`,
        entity: 'document',
        localId: id,
        operation: 'UPDATE',
        payload: { docType: 'PURCHASE_ORDER', ...rest },
      });

      return updated;
    });
  }

  async findReceipts(query: { status?: string; cursor?: string; limit?: number }) {
    const limit = Math.min(Number(query.limit) || 50, 200);
    const where: any = { docType: 'SUPPLY' };
    if (query.status) where.status = query.status;
    if (query.cursor) where.date = { lt: new Date(query.cursor) };

    const rows = await this.prisma.document.findMany({
      where,
      take: limit + 1,
      orderBy: { date: 'desc' },
    });

    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? data[data.length - 1].date.toISOString() : null;

    return { data, meta: { nextCursor, hasMore } };
  }

  async createReceipt(data: any) {
    const { items, ...rest } = data;
    if (rest.date && typeof rest.date === 'string' && !rest.date.includes('T')) {
      rest.date = new Date(rest.date + 'T00:00:00.000Z');
    }
    const count = await this.prisma.document.count({ where: { docType: 'SUPPLY' } });
    const number = `ПТ-${String(count + 1).padStart(6, '0')}`;
    const total = items.reduce((s: number, i: any) => s + i.qty * i.price, 0);

    return this.prisma.$transaction(async (tx) => {
      const receipt = await tx.document.create({
        data: {
          docType: 'SUPPLY',
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
          await tx.$executeRaw`
            INSERT INTO stock (id, product_id, store_id, bin_id, qty, reserved, updated_at)
            VALUES (gen_random_uuid()::text, ${item.productId}, ${rest.storeId}, NULL, ${item.qty}, 0, NOW())
            ON CONFLICT (product_id, store_id, bin_id) DO UPDATE SET qty = stock.qty + ${item.qty}, updated_at = NOW()
          `;
        }
      }

      await this.outbox.enqueueInTx(tx, {
        idempotencyKey: `receipt-${receipt.id}`,
        entity: 'document',
        localId: receipt.id,
        operation: 'CREATE',
        payload: { docType: 'SUPPLY', number, date: rest.date, counterpartyId: rest.counterpartyId, items },
      });

      return receipt;
    });
  }
}
