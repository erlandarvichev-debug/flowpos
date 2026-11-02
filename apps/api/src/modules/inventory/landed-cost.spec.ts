import { Prisma } from '@prisma/client';
import { allocate } from './landed-cost';

const D = Prisma.Decimal;
const run = (total: string, ws: [string, number][]) =>
  allocate(new D(total), ws.map(([w, order], i) => ({ key: i, weight: new D(w), order }))).map((p) => p.amount.toFixed(2));

describe('FP-031: распределение доп. расходов', () => {
  it('пропорционально весу, сумма долей равна сумме расходов', () => {
    expect(run('1000', [['10000', 1]])).toEqual(['1000.00']);
    expect(run('1000', [['900', 1], ['100', 2]])).toEqual(['900.00', '100.00']);
    expect(run('100', [['1', 1], ['9', 2]])).toEqual(['10.00', '90.00']);
  });

  it('остаток округления — строке с наибольшим весом, при равенстве — с меньшим номером; детерминированно', () => {
    expect(run('1000', [['100', 1], ['100', 2], ['100', 3]])).toEqual(['333.34', '333.33', '333.33']);
    expect(run('1000', [['100', 3], ['100', 2], ['100', 1]])).toEqual(['333.33', '333.33', '333.34']);
    expect(run('0.05', [['1', 1], ['1', 2], ['5', 3]])).toEqual(['0.01', '0.01', '0.03']);
    expect(run('10', [['1', 1], ['1', 2], ['1', 3], ['3', 4]])).toEqual(['1.67', '1.67', '1.67', '4.99']);
    for (let i = 0; i < 3; i++) expect(run('1000', [['100', 1], ['100', 2], ['100', 3]])).toEqual(['333.34', '333.33', '333.33']);
    const r = run('777.77', [['3', 1], ['7', 2], ['11', 3], ['13', 4]]);
    expect(r.reduce((a, x) => a.plus(x), new D(0)).toFixed(2)).toBe('777.77');
  });

  it('нулевая или отрицательная база — ошибка', () => {
    expect(() => run('10', [['0', 1]])).toThrow('ALLOCATION_BASE_EMPTY');
    expect(() => run('10', [])).toThrow('ALLOCATION_BASE_EMPTY');
    expect(() => run('10', [['5', 1], ['-1', 2]])).toThrow('ALLOCATION_BASE_NEGATIVE');
  });
});
