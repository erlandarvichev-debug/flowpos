import { ENGINE_VERSION, PayloadDiscount, SnapshotPayload, evaluate, roundReceipt } from './engine';
import { Prisma } from '@prisma/client';
import { kzToday } from './pricing.service';

const list = (id: string, priority: number, validFrom: string, validTo: string | null, items: [string, string, string?][], storeIds: string[] = []) =>
  ({ id, name: id, priority, validFrom, validTo, storeIds, items: items.map(([productId, price, minQty]) => ({ productId, price, minQty: minQty ?? '1' })) });
const disc = (id: string, o: Partial<PayloadDiscount>): PayloadDiscount =>
  ({ id, name: id, kind: 'PERCENT', value: '10', priority: 0, validFrom: '2026-01-01', validTo: null, storeIds: [], productIds: [], groupIds: [], minQty: null, minReceiptAmount: null, ...o });
const payload = (o: Partial<SnapshotPayload> = {}): SnapshotPayload => ({
  engineVersion: ENGINE_VERSION, organizationId: 'org', currency: 'KZT', rounding: { receiptStep: '0.01', receiptMode: 'HALF_UP' },
  priceLists: [list('base', 0, '2026-01-01', null, [['milk', '100.00'], ['bread', '250.00'], ['cheese', '2000.00']])],
  discounts: [], productGroups: { milk: 'dairy', cheese: 'dairy', bread: 'bakery' }, ...o,
});
const one = (p: SnapshotPayload, productId: string, qty: string, date = '2026-11-03', storeId: string | null = null) => evaluate(p, { date, storeId, lines: [{ productId, qty }] }).lines[0];

describe('FP-027: прайс-листы — приоритет и интервал', () => {
  it('акция с большим приоритетом действует только в свой интервал (границы включительно)', () => {
    const p = payload({ priceLists: [...payload().priceLists, list('promo', 10, '2026-11-01', '2026-11-07', [['milk', '80.00']])] });
    expect(one(p, 'milk', '1', '2026-10-31')).toMatchObject({ basePrice: '100.00', priceListId: 'base' });
    expect(one(p, 'milk', '1', '2026-11-01')).toMatchObject({ basePrice: '80.00', priceListId: 'promo' });
    expect(one(p, 'milk', '1', '2026-11-07').basePrice).toBe('80.00');
    expect(one(p, 'milk', '1', '2026-11-08').basePrice).toBe('100.00');
    // В акции нет хлеба — цена из следующего по приоритету листа.
    expect(one(p, 'bread', '1')).toMatchObject({ basePrice: '250.00', priceListId: 'base' });
  });

  it('равный приоритет — более поздний старт; дальше — по id (детерминированно); магазин', () => {
    const p = payload({ priceLists: [list('a', 5, '2026-01-01', null, [['milk', '90.00']]), list('b', 5, '2026-06-01', null, [['milk', '95.00']]), list('c', 5, '2026-06-01', null, [['milk', '96.00']]), list('shop2', 50, '2026-01-01', null, [['milk', '70.00']], ['s2'])] });
    expect(one(p, 'milk', '1', '2026-05-31').basePrice).toBe('90.00');
    expect(one(p, 'milk', '1', '2026-07-01').basePrice).toBe('95.00'); // b < c по id
    expect(one(p, 'milk', '1', '2026-07-01', 's1').basePrice).toBe('95.00');
    expect(one(p, 'milk', '1', '2026-07-01', 's2').basePrice).toBe('70.00');
  });

  it('цена от количества: наибольший порог не выше количества; нет цены — в списке «без цены»', () => {
    const p = payload({ priceLists: [list('base', 0, '2026-01-01', null, [['milk', '100.00'], ['milk', '90.00', '10'], ['milk', '85.00', '50']])] });
    expect(one(p, 'milk', '9.999').basePrice).toBe('100.00');
    expect(one(p, 'milk', '10').basePrice).toBe('90.00');
    expect(one(p, 'milk', '120').basePrice).toBe('85.00');
    const r = evaluate(p, { date: '2026-11-03', lines: [{ productId: 'nothing', qty: '1' }] });
    expect(r.missing).toEqual(['nothing']);
    expect(r.lines[0]).toMatchObject({ basePrice: null, amount: '0.00' });
  });
});

describe('FP-027: скидки и округление', () => {
  it('вид скидки: процент, сумма на единицу, фиксированная цена (выше базовой — не скидка); не больше суммы строки', () => {
    expect(one(payload({ discounts: [disc('p', { value: '7' })] }), 'milk', '3')).toMatchObject({ gross: '300.00', discount: '21.00', amount: '279.00' });
    expect(one(payload({ discounts: [disc('a', { kind: 'AMOUNT', value: '15' })] }), 'milk', '3').discount).toBe('45.00');
    expect(one(payload({ discounts: [disc('f', { kind: 'FIXED_PRICE', value: '60' })] }), 'milk', '3').discount).toBe('120.00');
    expect(one(payload({ discounts: [disc('f', { kind: 'FIXED_PRICE', value: '120' })] }), 'milk', '3')).toMatchObject({ discount: '0.00', discountId: null });
    expect(one(payload({ discounts: [disc('a', { kind: 'AMOUNT', value: '150' })] }), 'milk', '3')).toMatchObject({ discount: '300.00', amount: '0.00' });
    expect(one(payload({ discounts: [disc('p', { value: '7' })] }), 'cheese', '1.234')).toMatchObject({ gross: '2468.00', discount: '172.76', amount: '2295.24' });
  });

  it('одна скидка на строку: приоритет важнее выгоды; при равном — выгоднее покупателю; товар/группа/количество', () => {
    const p = payload({ discounts: [
      disc('big', { value: '30', priority: 0 }),
      disc('vip', { value: '5', priority: 10, groupIds: ['dairy'] }),
      disc('bulk', { value: '20', priority: 10, productIds: ['milk'], minQty: '10' }),
    ] });
    expect(one(p, 'bread', '1')).toMatchObject({ discountId: 'big', discount: '75.00' }); // на хлеб приоритетных нет
    expect(one(p, 'milk', '1')).toMatchObject({ discountId: 'vip', discount: '5.00' }); // приоритет 10 бьёт 30% с приоритетом 0
    expect(one(p, 'milk', '10')).toMatchObject({ discountId: 'bulk', discount: '200.00' }); // равный приоритет — выгоднее
    expect(one(p, 'milk', '1').notes).toEqual(['«bulk»: от 10 шт.']);
  });

  it('скидка от суммы чека — по сумме до скидок; интервал и магазин скидки', () => {
    const p = payload({ discounts: [disc('r', { value: '10', minReceiptAmount: '1000' }), disc('w', { value: '50', validFrom: '2026-12-01', storeIds: ['s1'] })] });
    const small = evaluate(p, { date: '2026-11-03', lines: [{ productId: 'bread', qty: '3' }] });
    expect(small.discount).toBe('0.00');
    expect(small.lines[0].notes).toEqual(['«r»: при чеке от 1000.00']);
    const big = evaluate(p, { date: '2026-11-03', lines: [{ productId: 'bread', qty: '3' }, { productId: 'milk', qty: '3' }] });
    expect(big).toMatchObject({ gross: '1050.00', discount: '105.00', total: '945.00' });
    expect(one(p, 'bread', '4', '2026-12-01', 's2').discountId).toBe('r'); // «w» — только магазин s1
    expect(one(p, 'bread', '4', '2026-12-01', 's1').discountId).toBe('w');
  });

  it('округление итога чека: шаг и режим; разница — отдельной суммой, строки не меняются', () => {
    const p = payload({ rounding: { receiptStep: '5', receiptMode: 'HALF_UP' }, priceLists: [list('base', 0, '2026-01-01', null, [['x', '1232.50']])] });
    expect(evaluate(p, { date: '2026-11-03', lines: [{ productId: 'x', qty: '1' }] })).toMatchObject({ total: '1232.50', rounding: '2.50', payable: '1235.00' });
    const down = { ...p, rounding: { receiptStep: '1', receiptMode: 'DOWN' as const } };
    expect(evaluate(down, { date: '2026-11-03', lines: [{ productId: 'x', qty: '1' }] })).toMatchObject({ rounding: '-0.50', payable: '1232.00' });
    const D = Prisma.Decimal;
    expect(roundReceipt(new D('99.995'), '0.01', 'HALF_UP').toFixed(2)).toBe('100.00');
    expect(() => roundReceipt(new D('1'), '0', 'HALF_UP')).toThrow(/больше нуля/);
  });

  it('итоги чека — суммы округлённых строк: скидка 10% от 3,33 ₸ — 0,33 в каждой строке, а не 0,999 в итоге', () => {
    const p = payload({ priceLists: [list('base', 0, '2026-01-01', null, [['a', '3.33'], ['b', '3.33'], ['c', '3.33']])], discounts: [disc('d', { value: '10' })] });
    const r = evaluate(p, { date: '2026-11-03', lines: ['a', 'b', 'c'].map((productId) => ({ productId, qty: '1' })) });
    expect(r.lines.map((l) => [l.discount, l.amount])).toEqual([['0.33', '3.00'], ['0.33', '3.00'], ['0.33', '3.00']]);
    expect(r).toMatchObject({ gross: '9.99', discount: '0.99', total: '9.00' });
    // Инвариант строки: скидка + к оплате = сумма строки (скидка 0,335 ₸ округляется до 0,34 до вычитания).
    const half = evaluate(payload({ priceLists: [list('base', 0, '2026-01-01', null, [['x', '3.35']])], discounts: [disc('d', { value: '10' })] }), { date: '2026-11-03', lines: [{ productId: 'x', qty: '1' }] }).lines[0];
    expect(half).toMatchObject({ gross: '3.35', discount: '0.34', amount: '3.01' });
  });

  it('ошибки ввода и версия снимка; детерминированность', () => {
    expect(() => evaluate(payload(), { date: '03.11.2026', lines: [] })).toThrow(/ГГГГ-ММ-ДД/);
    expect(() => evaluate(payload(), { date: '2026-11-03', lines: [{ productId: 'milk', qty: '0' }] })).toThrow(/больше нуля/);
    expect(() => evaluate(payload(), { date: '2026-11-03', lines: [{ productId: 'milk', qty: 'abc' }] })).toThrow(/число/);
    expect(() => evaluate({ ...payload(), engineVersion: 99 }, { date: '2026-11-03', lines: [] })).toThrow(/версии расчёта/);
    const p = payload({ discounts: [disc('x', { value: '33.3333' })] });
    const input = { date: '2026-11-03', lines: [{ productId: 'milk', qty: '7' }, { productId: 'cheese', qty: '0.333' }] };
    expect(evaluate(p, input)).toEqual(evaluate(JSON.parse(JSON.stringify(p)), input));
  });
});

describe('FP-027: дата «сегодня» по Казахстану', () => {
  it('00:03 1 ноября по Алматы — это 31 октября в UTC, но день уже 1 ноября', () => {
    expect(kzToday(new Date('2026-10-31T19:03:00Z'))).toBe('2026-11-01');
    expect(kzToday(new Date('2026-10-31T18:59:59Z'))).toBe('2026-10-31');
  });
});
