// FP-030: остаток в тестах — только движениями журнала (прямая запись stock.qty отклоняется БД). Чистка данных клиента
// целиком — в режиме обслуживания (роль миграций + flowpos.stock_maintenance), как в рабочей БД.
import { PrismaClient } from '@prisma/client';

type Db = Pick<PrismaClient, 'store' | 'stockMovement'>;

/** Приход на склад (движение ENTER с источником TEST). */
export async function stockIn(db: Db, rows: { productId: string; storeId: string; qty: number | string }[]) {
  const stores = await db.store.findMany({ where: { id: { in: rows.map((r) => r.storeId) } }, select: { id: true, organizationId: true } });
  await db.stockMovement.createMany({
    data: rows.map((r, i) => ({
      organizationId: stores.find((s) => s.id === r.storeId)!.organizationId, productId: r.productId, storeId: r.storeId, qty: r.qty,
      kind: 'ENTER', sourceType: 'TEST', sourceId: `test-${Date.now()}`, sourceLine: i + 1, occurredAt: new Date(),
    })),
  });
}

/** Удалить движения и остатки (данные тестового клиента или товаров). */
export async function purgeStock(prisma: PrismaClient, where: { tenantId?: string; productIds?: string[] }) {
  const w: any = where.tenantId ? { tenantId: where.tenantId } : { productId: { in: where.productIds ?? [] } };
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('flowpos.stock_maintenance', 'on', true)`;
    await tx.stockMovement.deleteMany({ where: w });
    await tx.stock.deleteMany({ where: w });
  });
}
