// FP-031: распределение дополнительных расходов (доставка, таможня, погрузка) на товары поступления.
// Округление детерминировано: доли считаются с округлением до тиына, остаток округления целиком — строке с
// наибольшим весом (при равенстве — с меньшим номером), поэтому сумма долей всегда равна сумме расходов, а повторный
// расчёт даёт тот же результат.
import { Prisma } from '@prisma/client';

type Dec = Prisma.Decimal;
const D = Prisma.Decimal;

export const ALLOCATION_BASES = ['AMOUNT', 'QTY'] as const;
export type AllocationBase = (typeof ALLOCATION_BASES)[number];

export function allocate<K>(total: Dec, items: { key: K; weight: Dec; order: number }[]): { key: K; amount: Dec }[] {
  const sum = items.reduce((a, x) => a.plus(x.weight), new D(0));
  if (!items.length || sum.lte(0)) throw new Error('ALLOCATION_BASE_EMPTY');
  if (items.some((x) => x.weight.isNegative())) throw new Error('ALLOCATION_BASE_NEGATIVE');
  const parts = items.map((x) => ({ key: x.key, amount: total.times(x.weight).div(sum).toDecimalPlaces(2, D.ROUND_HALF_UP) }));
  const rest = total.minus(parts.reduce((a, p) => a.plus(p.amount), new D(0)));
  if (!rest.isZero()) {
    let best = 0;
    items.forEach((x, i) => {
      const b = items[best];
      if (x.weight.gt(b.weight) || (x.weight.eq(b.weight) && x.order < b.order)) best = i;
    });
    parts[best].amount = parts[best].amount.plus(rest);
  }
  return parts;
}
