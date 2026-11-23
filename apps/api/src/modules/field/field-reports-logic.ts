// «Супервайзер»: расчёты для отчёта по продажам торговых и для живой карты (без базы — чтобы проверять тестами).

const KZ_MS = 5 * 3600 * 1000;

/** Дата ГГГГ-ММ-ДД по Казахстану. */
export const kzDate = (d: Date) => new Date(d.getTime() + KZ_MS).toISOString().slice(0, 10);

/** Все даты от from до to включительно (ГГГГ-ММ-ДД). */
export function dateList(from: string, to: string): string[] {
  const out: string[] = [];
  const end = new Date(`${to}T00:00:00Z`).getTime();
  for (let t = new Date(`${from}T00:00:00Z`).getTime(); t <= end; t += 86400000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

/** Предыдущий период той же длины, вплотную перед [from; to]. */
export function previousPeriod(from: string, to: string): { from: string; to: string } {
  const days = dateList(from, to).length;
  const f = new Date(`${from}T00:00:00Z`).getTime();
  return {
    from: new Date(f - days * 86400000).toISOString().slice(0, 10),
    to: new Date(f - 86400000).toISOString().slice(0, 10),
  };
}

export interface SaleRow {
  repId: string;
  pointId: string | null;
  sum: number;
  at: Date;
  placement: string;
}

export interface Totals {
  sum: number;
  count: number;
  avg: number;
  points: number;
  onSite: number;
  remote: number;
  unknown: number;
}

export function totals(rows: SaleRow[]): Totals {
  const sum = round2(rows.reduce((s, r) => s + r.sum, 0));
  return {
    sum,
    count: rows.length,
    avg: rows.length ? round2(sum / rows.length) : 0,
    points: new Set(rows.filter((r) => r.pointId).map((r) => r.pointId)).size,
    onSite: rows.filter((r) => r.placement === 'on_site').length,
    remote: rows.filter((r) => r.placement === 'remote').length,
    unknown: rows.filter((r) => r.placement !== 'on_site' && r.placement !== 'remote').length,
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface SalesInput {
  from: string;
  to: string;
  rows: SaleRow[];
  prevRows: SaleRow[];
  reps: Array<{ id: string; name: string; isActive: boolean }>;
  points: Array<{ id: string; name: string; address: string | null; isActive: boolean }>;
  /** Последний заказ по точке за всё время (до конца периода) — для «давно не заказывали». */
  lastOrderAt: Map<string, Date>;
}

/** Отчёт по продажам торговых за период: итоги и сравнение, по дням, по торговым, по клиентам, без заказов. */
export function salesReport(i: SalesInput) {
  const repName = new Map(i.reps.map((r) => [r.id, r.name]));
  const point = new Map(i.points.map((p) => [p.id, p]));
  const cur = totals(i.rows);
  const prev = totals(i.prevRows);

  const byDayMap = new Map(dateList(i.from, i.to).map((d) => [d, { date: d, sum: 0, count: 0 }]));
  const byHour = Array.from({ length: 24 }, (_, h) => ({ hour: h, sum: 0, count: 0 }));
  const byWeekday = Array.from({ length: 7 }, (_, d) => ({ weekday: d + 1, sum: 0, count: 0 }));
  for (const r of i.rows) {
    const local = new Date(r.at.getTime() + KZ_MS);
    const day = byDayMap.get(local.toISOString().slice(0, 10));
    if (day) { day.sum += r.sum; day.count++; }
    const h = byHour[local.getUTCHours()];
    h.sum += r.sum; h.count++;
    const w = byWeekday[(local.getUTCDay() + 6) % 7]; // 1 — понедельник
    w.sum += r.sum; w.count++;
  }

  const group = <K extends string>(rows: SaleRow[], key: (r: SaleRow) => K) => {
    const m = new Map<K, SaleRow[]>();
    for (const r of rows) {
      const k = key(r);
      const list = m.get(k);
      if (list) list.push(r); else m.set(k, [r]);
    }
    return m;
  };

  const prevByRep = group(i.prevRows, (r) => r.repId);
  const byRep = [...group(i.rows, (r) => r.repId)].map(([repId, rows]) => ({
    repId,
    name: repName.get(repId) ?? 'Удалённый представитель',
    ...totals(rows),
    share: cur.sum ? round2((totals(rows).sum / cur.sum) * 100) : 0,
    prevSum: totals(prevByRep.get(repId) ?? []).sum,
  }));
  // Торговые без заказов за период — тоже в таблице: супервайзеру важно видеть нули.
  for (const r of i.reps) {
    if (r.isActive && !byRep.some((x) => x.repId === r.id)) {
      byRep.push({ repId: r.id, name: r.name, ...totals([]), share: 0, prevSum: totals(prevByRep.get(r.id) ?? []).sum });
    }
  }
  byRep.sort((a, b) => b.sum - a.sum || a.name.localeCompare(b.name, 'ru'));

  const NO_POINT = '';
  const prevByPoint = group(i.prevRows, (r) => r.pointId ?? NO_POINT);
  const byPoint = [...group(i.rows, (r) => r.pointId ?? NO_POINT)]
    .map(([pointId, rows]) => {
      const p = pointId ? point.get(pointId) : undefined;
      const t = totals(rows);
      return {
        pointId: pointId || null,
        name: p?.name ?? (pointId ? 'Точка удалена' : 'Без точки'),
        address: p?.address ?? null,
        sum: t.sum,
        count: t.count,
        avg: t.avg,
        lastAt: rows.reduce((m, r) => (r.at > m ? r.at : m), rows[0].at),
        reps: [...new Set(rows.map((r) => repName.get(r.repId) ?? '—'))],
        prevSum: totals(prevByPoint.get(pointId) ?? []).sum,
      };
    })
    .sort((a, b) => b.sum - a.sum);

  const ordered = new Set(i.rows.map((r) => r.pointId).filter(Boolean));
  const silent = i.points
    .filter((p) => p.isActive && !ordered.has(p.id))
    .map((p) => ({ pointId: p.id, name: p.name, address: p.address, lastAt: i.lastOrderAt.get(p.id) ?? null, prevSum: totals(prevByPoint.get(p.id) ?? []).sum }))
    // Сначала те, кто заказывал раньше (потерянные), — по давности; кто не заказывал никогда — в конце.
    .sort((a, b) => (a.lastAt && b.lastAt ? b.lastAt.getTime() - a.lastAt.getTime() : a.lastAt ? -1 : b.lastAt ? 1 : a.name.localeCompare(b.name, 'ru')));

  return {
    period: { from: i.from, to: i.to },
    previous: previousPeriod(i.from, i.to),
    totals: cur,
    prevTotals: prev,
    byDay: [...byDayMap.values()].map((d) => ({ ...d, sum: round2(d.sum) })),
    byHour: byHour.map((h) => ({ ...h, sum: round2(h.sum) })),
    byWeekday: byWeekday.map((w) => ({ ...w, sum: round2(w.sum) })),
    byRep,
    byPoint,
    silent,
  };
}
