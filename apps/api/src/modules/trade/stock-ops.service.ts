import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class StockOpsService {
  constructor(private prisma: PrismaService) {}

  async getStockReport(storeId?: string) {
    const where: any = { qty: { gt: 0 } };
    if (storeId) where.storeId = storeId;
    return this.prisma.stock.findMany({
      where,
      include: { product: { include: { uom: true } }, store: true },
      orderBy: { product: { name: 'asc' } },
    });
  }

  async createTransfer(data: any) {
    const { items, ...rest } = data;
    const count = await this.prisma.document.count({ where: { docType: 'MOVE' } });
    const number = `ПМ-${String(count + 1).padStart(6, '0')}`;

    const transfer = await this.prisma.document.create({
      data: {
        docType: 'MOVE',
        date: rest.date ? new Date(rest.date) : new Date(),
        storeId: rest.storeId,
        storeToId: rest.storeToId,
        status: rest.status || 'DRAFT',
        organizationId: rest.organizationId,
        comment: rest.comment,
        number,
        lines: {
          create: items.map((i: any, idx: number) => ({
            lineNo: idx + 1,
            productId: i.productId,
            qty: i.qty,
            price: i.price,
            amount: i.qty * (i.price || 0),
          })),
        },
      },
      include: { store: true, storeTo: true, lines: { include: { product: true } } },
    });

    if (rest.status === 'POSTED' && rest.storeId && rest.storeToId) {
      for (const item of items) {
        await this.prisma.stock.updateMany({
          where: { productId: item.productId, storeId: rest.storeId },
          data: { qty: { decrement: item.qty } },
        });
        await this.prisma.$executeRaw`
          INSERT INTO stock (id, product_id, store_id, bin_id, qty, reserved, updated_at)
          VALUES (gen_random_uuid()::text, ${item.productId}, ${rest.storeToId}, NULL, ${item.qty}, 0, NOW())
          ON CONFLICT (product_id, store_id, bin_id) DO UPDATE SET qty = stock.qty + ${item.qty}, updated_at = NOW()
        `;
      }
    }

    return transfer;
  }

  async createWriteOff(data: any) {
    const { items, ...rest } = data;
    const count = await this.prisma.document.count({ where: { docType: 'LOSS' } });
    const number = `СП-${String(count + 1).padStart(6, '0')}`;
    return this.prisma.document.create({
      data: {
        docType: 'LOSS',
        date: rest.date ? new Date(rest.date) : new Date(),
        storeId: rest.storeId,
        status: rest.status || 'DRAFT',
        organizationId: rest.organizationId,
        comment: rest.comment,
        number,
        lines: {
          create: items.map((i: any, idx: number) => ({
            lineNo: idx + 1,
            productId: i.productId,
            qty: i.qty,
            price: i.price,
            amount: i.qty * (i.price || 0),
          })),
        },
      },
      include: { lines: { include: { product: true } } },
    });
  }

  async createInventory(data: any) {
    const { items, ...rest } = data;
    const count = await this.prisma.document.count({ where: { docType: 'INVENTORY' } });
    const number = `ИН-${String(count + 1).padStart(6, '0')}`;
    return this.prisma.document.create({
      data: {
        docType: 'INVENTORY',
        date: rest.date ? new Date(rest.date) : new Date(),
        storeId: rest.storeId,
        status: rest.status || 'DRAFT',
        organizationId: rest.organizationId,
        comment: rest.comment,
        number,
        lines: {
          create: items.map((i: any, idx: number) => ({
            lineNo: idx + 1,
            productId: i.productId,
            qty: i.qty,
            price: i.price,
            amount: i.qty * (i.price || 0),
          })),
        },
      },
      include: { lines: { include: { product: true } } },
    });
  }

  async findTransfers(query: any) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 50;
    const [items, total] = await Promise.all([
      this.prisma.document.findMany({
        where: { docType: 'MOVE' },
        skip: (page - 1) * limit, take: limit,
        include: { store: true, storeTo: true },
        orderBy: { date: 'desc' },
      }),
      this.prisma.document.count({ where: { docType: 'MOVE' } }),
    ]);
    return { items, total, page, limit };
  }

  async findInventories(query: any) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 50;
    const [items, total] = await Promise.all([
      this.prisma.document.findMany({
        where: { docType: 'INVENTORY' },
        skip: (page - 1) * limit, take: limit,
        orderBy: { date: 'desc' },
      }),
      this.prisma.document.count({ where: { docType: 'INVENTORY' } }),
    ]);
    return { items, total, page, limit };
  }
}
