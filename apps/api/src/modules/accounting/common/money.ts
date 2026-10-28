import { Prisma } from '@prisma/client';

export const D = Prisma.Decimal;
export type Dec = Prisma.Decimal;

/** Парсит сумму без потерь (строка/число/Decimal) и проверяет масштаб. */
export function money(v: unknown, scale = 2, field = 'сумма'): Prisma.Decimal {
  if (v === null || v === undefined || v === '') throw new Error(`Не указана ${field}`);
  const d = new D(typeof v === 'number' ? v.toString() : (v as any));
  if (!d.isFinite()) throw new Error(`Некорректная ${field}: ${v}`);
  if (d.decimalPlaces() > scale) throw new Error(`${field}: не более ${scale} знаков после запятой (${v})`);
  return d;
}

/** Округление половина вверх (от нуля) до scale знаков — правило округления учёта. */
export function round(v: Prisma.Decimal, scale = 2): Prisma.Decimal {
  return v.toDecimalPlaces(scale, D.ROUND_HALF_UP);
}

export function sum(values: Prisma.Decimal[]): Prisma.Decimal {
  return values.reduce((a, b) => a.plus(b), new D(0));
}
