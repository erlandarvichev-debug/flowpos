import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { Scope } from '../../common/scope';
import { assertTradeRefs, docHeader, nextNumber, orgDocs } from './trade-scope';

/** Складские операции — только склады своей организации и товары своего клиента (FP-007). */
@Injectable()
export class StockOpsService {
  constructor(private prisma: PrismaService) {}

  async getStockReport(s: Scope, storeId?: string) {
    const where: any = { qty: { gt: 0 }, store: { organizationId: s.organizationId } };
    if (storeId) where.storeId = storeId;
    return this.prisma.stock.findMany({
      where,
      include: { product: { include: { uom: true } }, store: true },
      orderBy: { product: { name: 'asc' } },
    });
  }

  private lines(items: any[]) {
    return {
      create: items.map((i: any, idx: number) => ({
        lineNo: idx + 1,
        productId: i.productId,
        qty: i.qty,
        price: i.price,
        amount: i.qty * (i.price || 0),
      })),
    };
  }

  private header(s: Scope, data: any) {
    const h = docHeader(s, data);
    return { ...h, date: h.date ?? new Date(), status: h.status || 'DRAFT' };
  }

  async createTransfer(s: Scope, data: any) {
    const items: any[] = data?.items ?? [];
    const rest = this.header(s, data);
    return this.prisma.$transaction(async (tx) => {
      await assertTradeRefs(tx, s, { storeIds: [rest.storeId, rest.storeToId], productIds: items.map((i) => i.productId) });
      const transfer = await tx.document.create({
        data: { docType: 'MOVE', ...rest, number: await nextNumber(tx, s, 'MOVE', 'ПМ', 6), lines: this.lines(items) } as Prisma.DocumentUncheckedCreateInput,
        include: { store: true, storeTo: true, lines: { include: { product: true } } },
      });

      if (rest.status === 'POSTED' && rest.storeId && rest.storeToId) {
        for (const item of items) {
          await tx.stock.updateMany({
            where: { productId: item.productId, storeId: rest.storeId },
            data: { qty: { decrement: item.qty } },
          });
          await tx.$executeRaw`
            INSERT INTO stock (id, product_id, store_id, bin_id, qty, reserved, updated_at)
            VALUES (gen_random_uuid()::text, ${item.productId}, ${rest.storeToId}, NULL, ${item.qty}, 0, NOW())
            ON CONFLICT (product_id, store_id, bin_id) DO UPDATE SET qty = stock.qty + ${item.qty}, updated_at = NOW()
          `;
        }
      }
      return transfer;
    });
  }

  async createWriteOff(s: Scope, data: any) {
    const items: any[] = data?.items ?? [];
    const rest = this.header(s, data);
    return this.prisma.$transaction(async (tx) => {
      await assertTradeRefs(tx, s, { storeIds: [rest.storeId], productIds: items.map((i) => i.productId) });
      return tx.document.create({
        data: { docType: 'LOSS', ...rest, number: await nextNumber(tx, s, 'LOSS', 'СП', 6), lines: this.lines(items) } as Prisma.DocumentUncheckedCreateInput,
        include: { lines: { include: { product: true } } },
      });
    });
  }

  async createInventory(s: Scope, data: any) {
    const items: any[] = data?.items ?? [];
    const rest = this.header(s, data);
    return this.prisma.$transaction(async (tx) => {
      await assertTradeRefs(tx, s, { storeIds: [rest.storeId], productIds: items.map((i) => i.productId) });
      return tx.document.create({
        data: { docType: 'INVENTORY', ...rest, number: await nextNumber(tx, s, 'INVENTORY', 'ИН', 6), lines: this.lines(items) } as Prisma.DocumentUncheckedCreateInput,
        include: { lines: { include: { product: true } } },
      });
    });
  }

  async findTransfers(s: Scope, query: any) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 50;
    const where = orgDocs(s, { docType: 'MOVE' });
    const [items, total] = await Promise.all([
      this.prisma.document.findMany({
        where,
        skip: (page - 1) * limit, take: limit,
        include: { store: true, storeTo: true },
        orderBy: { date: 'desc' },
      }),
      this.prisma.document.count({ where }),
    ]);
    return { items, total, page, limit };
  }

  async findInventories(s: Scope, query: any) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 50;
    const where = orgDocs(s, { docType: 'INVENTORY' });
    const [items, total] = await Promise.all([
      this.prisma.document.findMany({
        where,
        skip: (page - 1) * limit, take: limit,
        orderBy: { date: 'desc' },
      }),
      this.prisma.document.count({ where }),
    ]);
    return { items, total, page, limit };
  }
}
