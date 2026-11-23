import { dateList, previousPeriod, salesReport, totals, type SaleRow } from './field-reports-logic';

const at = (iso: string) => new Date(iso);

describe('отчёт по продажам торговых', () => {
  it('даты периода и предыдущий период той же длины', () => {
    expect(dateList('2026-11-01', '2026-11-03')).toEqual(['2026-11-01', '2026-11-02', '2026-11-03']);
    expect(previousPeriod('2026-11-01', '2026-11-30')).toEqual({ from: '2026-10-02', to: '2026-10-31' });
    expect(previousPeriod('2026-11-23', '2026-11-23')).toEqual({ from: '2026-11-22', to: '2026-11-22' });
  });

  it('итоги: сумма, средний заказ, точки, место оформления', () => {
    const rows: SaleRow[] = [
      { repId: 'r1', pointId: 'p1', sum: 1000, at: at('2026-11-02T05:00:00Z'), placement: 'on_site' },
      { repId: 'r1', pointId: 'p1', sum: 500.5, at: at('2026-11-02T06:00:00Z'), placement: 'remote' },
      { repId: 'r2', pointId: null, sum: 99.5, at: at('2026-11-03T06:00:00Z'), placement: 'unknown' },
    ];
    expect(totals(rows)).toEqual({ sum: 1600, count: 3, avg: 533.33, points: 1, onSite: 1, remote: 1, unknown: 1 });
    expect(totals([])).toEqual({ sum: 0, count: 0, avg: 0, points: 0, onSite: 0, remote: 0, unknown: 0 });
  });

  it('раскладка по дням и часам — по времени Казахстана', () => {
    const r = salesReport({
      from: '2026-11-01', to: '2026-11-02',
      // 19:30 UTC 1-го — это 00:30 2-го по Казахстану.
      rows: [{ repId: 'r1', pointId: 'p1', sum: 100, at: at('2026-11-01T19:30:00Z'), placement: 'on_site' }],
      prevRows: [], reps: [{ id: 'r1', name: 'Асхат', isActive: true }], points: [], lastOrderAt: new Map(),
    });
    expect(r.byDay).toEqual([{ date: '2026-11-01', sum: 0, count: 0 }, { date: '2026-11-02', sum: 100, count: 1 }]);
    expect(r.byHour[0]).toEqual({ hour: 0, sum: 100, count: 1 });
    expect(r.byWeekday[0]).toEqual({ weekday: 1, sum: 100, count: 1 }); // 02.11.2026 — понедельник
  });

  it('торговые с нулём тоже в таблице, клиенты без заказов — сначала давно заказывавшие', () => {
    const r = salesReport({
      from: '2026-11-01', to: '2026-11-30',
      rows: [{ repId: 'r1', pointId: 'p1', sum: 300, at: at('2026-11-05T06:00:00Z'), placement: 'on_site' }],
      prevRows: [
        { repId: 'r1', pointId: 'p1', sum: 200, at: at('2026-10-05T06:00:00Z'), placement: 'on_site' },
        { repId: 'r2', pointId: 'p2', sum: 50, at: at('2026-10-06T06:00:00Z'), placement: 'on_site' },
      ],
      reps: [{ id: 'r1', name: 'Асхат', isActive: true }, { id: 'r2', name: 'Бекзат', isActive: true }, { id: 'r3', name: 'Старый', isActive: false }],
      points: [
        { id: 'p1', name: 'Береке', address: null, isActive: true },
        { id: 'p2', name: 'Арай', address: null, isActive: true },
        { id: 'p3', name: 'Алма', address: null, isActive: true },
        { id: 'p4', name: 'Закрыта', address: null, isActive: false },
      ],
      lastOrderAt: new Map([['p1', at('2026-11-05T06:00:00Z')], ['p2', at('2026-10-06T06:00:00Z')]]),
    });
    expect(r.byRep.map((x) => [x.name, x.sum, x.prevSum, x.share])).toEqual([['Асхат', 300, 200, 100], ['Бекзат', 0, 50, 0]]);
    expect(r.byPoint).toHaveLength(1);
    expect(r.byPoint[0]).toMatchObject({ name: 'Береке', sum: 300, prevSum: 200, reps: ['Асхат'] });
    expect(r.silent.map((x) => x.name)).toEqual(['Арай', 'Алма']);
    expect(r.prevTotals.sum).toBe(250);
  });
});
