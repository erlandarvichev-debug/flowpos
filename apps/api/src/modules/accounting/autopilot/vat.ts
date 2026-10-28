import { Prisma } from '@prisma/client';
import { D, round } from '../common/money';

type Tx = Prisma.TransactionClient;
type Dec = Prisma.Decimal;

/** Стандартная ставка НДС на дату (справочник vat_rates с периодами). */
export async function standardVatRate(tx: Tx, date: Date): Promise<Dec> {
  const r = await tx.vatRate.findFirst({
    where: { code: 'STANDARD', validFrom: { lte: date }, OR: [{ validTo: null }, { validTo: { gte: date } }] },
    orderBy: { validFrom: 'desc' },
  });
  return new D(r?.rate ?? 0);
}

/**
 * Разложение суммы строки на без НДС и НДС. Округление НДС — половина вверх до тиына по строке.
 * includes = true: цена с НДС (НДС = сумма × r / (100 + r)); иначе НДС начисляется сверху.
 */
export function splitVat(amount: Dec, rate: Dec, includes: boolean): { net: Dec; vat: Dec; gross: Dec } {
  if (rate.isZero()) return { net: amount, vat: new D(0), gross: amount };
  if (includes) {
    const vat = round(amount.times(rate).div(rate.plus(100)));
    return { net: amount.minus(vat), vat, gross: amount };
  }
  const vat = round(amount.times(rate).div(100));
  return { net: amount, vat, gross: amount.plus(vat) };
}
