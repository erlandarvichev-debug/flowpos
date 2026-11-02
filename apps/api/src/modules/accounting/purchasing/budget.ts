// FP-035: расход бюджета закупок месяца (без зависимостей от сервисов — используется и согласованиями FP-029).
import { Prisma } from '@prisma/client';

type Db = Prisma.TransactionClient | { purchaseBudget: any; document: any };
const D = Prisma.Decimal;
export const periodOf = (d: Date) => d.toISOString().slice(0, 7);

/** Бюджет закупок месяца и сколько уже заказано (проведённые заказы поставщикам месяца, кроме указанного). */
export async function budgetUsage(db: Db, organizationId: string, date: Date, excludeDocId?: string) {
  const period = periodOf(date);
  const budget = await db.purchaseBudget.findUnique({ where: { organizationId_period: { organizationId, period } } });
  if (!budget) return null;
  const from = new Date(period + '-01T00:00:00.000Z');
  const to = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
  const agg = await db.document.aggregate({
    where: { organizationId, docType: 'PURCHASE_ORDER', status: 'POSTED', deleted: false, date: { gte: from, lt: to }, ...(excludeDocId ? { id: { not: excludeDocId } } : {}) },
    _sum: { total: true },
  });
  const committed = new D(agg._sum.total ?? 0);
  return { period, budget: new D(budget.amount), committed, left: new D(budget.amount).minus(committed) };
}

