import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Scope } from '../../common/scope';
import { DEFAULT_RADIUS_M, dateOnly, kzDayRange, kzToday } from './field-logic';
import { SaleRow, previousPeriod, salesReport } from './field-reports-logic';

const bad = <T>(fn: () => T): T => {
  try { return fn(); } catch (e: any) { throw new BadRequestException(e.message); }
};

/** Сколько минут без отметок — представитель считается «пропал со связи». */
const STALE_MIN = 90;

/** «Супервайзер»: живая карта всех торговых за день и отчёт по продажам. */
@Injectable()
export class FieldReportsService {
  constructor(private prisma: PrismaService) {}

  /**
   * Все торговые за день: где были в последний раз, что сделали, сколько из маршрута,
   * а также все точки организации с отметкой «в плане / посещена / с заказом».
   */
  async live(s: Scope, q: any) {
    const date = String(q?.date || kzToday());
    const { from, to } = bad(() => kzDayRange(date));
    const org = s.organizationId;
    const [reps, routes, visits, orders, track, points] = await Promise.all([
      this.prisma.fieldRep.findMany({
        where: { organizationId: org },
        orderBy: [{ isActive: 'desc' }, { name: 'asc' }], // как в списке представителей: по этому порядку — цвет торгового на карте и в отчётах
        select: { id: true, name: true, phone: true, isActive: true, devices: { where: { revokedAt: null }, select: { lastSeenAt: true, appVersion: true } } },
      }),
      this.prisma.fieldRoute.findMany({ where: { organizationId: org, date: bad(() => dateOnly(date)) }, include: { stops: { orderBy: { position: 'asc' } } } }),
      this.prisma.fieldVisit.findMany({
        where: { organizationId: org, startedAt: { gte: from, lt: to } },
        orderBy: { startedAt: 'asc' },
        select: { id: true, repId: true, pointId: true, startedAt: true, finishedAt: true, placement: true, distanceM: true, lat: true, lng: true, comment: true, _count: { select: { photos: true } } },
      }),
      this.prisma.fieldOrder.findMany({
        where: { organizationId: org, at: { gte: from, lt: to } },
        orderBy: { at: 'asc' },
        select: { id: true, repId: true, pointId: true, visitId: true, number: true, sum: true, at: true, placement: true },
      }),
      this.prisma.fieldTrack.findMany({
        where: { organizationId: org, at: { gte: from, lt: to } },
        orderBy: { at: 'asc' },
        take: 20000,
        select: { repId: true, at: true, lat: true, lng: true, event: true },
      }),
      this.prisma.fieldPoint.findMany({ where: { organizationId: org, isActive: true }, select: { id: true, name: true, address: true, lat: true, lng: true, radiusM: true } }),
    ]);

    const now = Date.now();
    const repRows = reps
      .map((r, idx) => {
        const route = routes.find((x) => x.repId === r.id);
        const plan = route?.stops.map((st) => st.pointId) ?? [];
        const myVisits = visits.filter((v) => v.repId === r.id);
        const myOrders = orders.filter((o) => o.repId === r.id);
        const myTrack = track.filter((t) => t.repId === r.id);
        const visited = new Set(myVisits.map((v) => v.pointId));
        const last = myTrack[myTrack.length - 1] ?? null;
        const open = [...myVisits].reverse().find((v) => !v.finishedAt) ?? null;
        const lastAt = [last?.at, myVisits[myVisits.length - 1]?.startedAt, myOrders[myOrders.length - 1]?.at]
          .filter((d): d is Date => !!d)
          .reduce<Date | null>((m, d) => (!m || d > m ? d : m), null);
        const status = open && now - open.startedAt.getTime() < 4 * 3600 * 1000
          ? 'visit'
          : !lastAt
            ? 'idle'
            : date === kzToday() && now - lastAt.getTime() > STALE_MIN * 60 * 1000
              ? 'stale'
              : 'active';
        return {
          id: r.id,
          idx,
          name: r.name,
          phone: r.phone,
          isActive: r.isActive,
          bound: r.devices.length > 0,
          lastSeenAt: r.devices.reduce<Date | null>((m, d) => (d.lastSeenAt && (!m || d.lastSeenAt > m) ? d.lastSeenAt : m), null),
          appVersion: r.devices[0]?.appVersion ?? null,
          status,
          openVisit: open ? { pointId: open.pointId, startedAt: open.startedAt } : null,
          last: last ? { lat: last.lat, lng: last.lng, at: last.at, event: last.event } : null,
          lastAt,
          plan,
          planVisited: plan.filter((p) => visited.has(p)).length,
          visits: myVisits.length,
          onSite: myVisits.filter((v) => v.placement === 'on_site').length,
          remote: myVisits.filter((v) => v.placement === 'remote').length,
          photos: myVisits.reduce((n, v) => n + v._count.photos, 0),
          orders: myOrders.length,
          ordersSum: myOrders.reduce((sum, o) => sum + Number(o.sum), 0),
          track: myTrack.map((t) => [t.lat, t.lng] as [number, number]),
        };
      })
      .filter((r) => r.isActive || r.visits || r.orders);

    const inPlan = new Set(routes.flatMap((x) => x.stops.map((st) => st.pointId)));
    const visitedAll = new Set(visits.map((v) => v.pointId));
    const orderedAll = new Map<string, number>();
    for (const o of orders) if (o.pointId) orderedAll.set(o.pointId, (orderedAll.get(o.pointId) ?? 0) + Number(o.sum));

    return {
      date,
      reps: repRows,
      visits: visits.map(({ _count, ...v }) => ({ ...v, photos: _count.photos })),
      orders: orders.map((o) => ({ ...o, sum: Number(o.sum) })),
      points: points.map((p) => ({
        ...p,
        radiusM: p.radiusM ?? DEFAULT_RADIUS_M,
        inPlan: inPlan.has(p.id),
        visited: visitedAll.has(p.id),
        orderSum: orderedAll.get(p.id) ?? 0,
      })),
    };
  }

  /** Продажи торговых (заказы из агента) за период со сравнением с предыдущим периодом той же длины. */
  async sales(s: Scope, q: any) {
    const fromDate = String(q?.from ?? '');
    const toDate = String(q?.to ?? fromDate);
    const from = bad(() => kzDayRange(fromDate)).from;
    const to = bad(() => kzDayRange(toDate)).to;
    if (to <= from) throw new BadRequestException('Начало периода позже конца');
    if (to.getTime() - from.getTime() > 367 * 24 * 3600 * 1000) throw new BadRequestException('Период — не больше года');
    const prev = previousPeriod(fromDate, toDate);
    const prevFrom = kzDayRange(prev.from).from;
    const repFilter = q?.repId ? { repId: String(q.repId) } : {};
    const org = s.organizationId;
    const select = { repId: true, pointId: true, sum: true, at: true, placement: true } as const;
    const [orders, prevOrders, reps, points, last] = await Promise.all([
      this.prisma.fieldOrder.findMany({ where: { organizationId: org, at: { gte: from, lt: to }, ...repFilter }, select }),
      this.prisma.fieldOrder.findMany({ where: { organizationId: org, at: { gte: prevFrom, lt: from }, ...repFilter }, select }),
      this.prisma.fieldRep.findMany({ where: { organizationId: org, ...(q?.repId ? { id: String(q.repId) } : {}) }, select: { id: true, name: true, isActive: true } }),
      this.prisma.fieldPoint.findMany({ where: { organizationId: org }, select: { id: true, name: true, address: true, isActive: true } }),
      this.prisma.fieldOrder.groupBy({ by: ['pointId'], where: { organizationId: org, at: { lt: to }, pointId: { not: null }, ...repFilter }, _max: { at: true } }),
    ]);
    const row = (o: (typeof orders)[number]): SaleRow => ({ repId: o.repId, pointId: o.pointId, sum: Number(o.sum), at: o.at, placement: o.placement });
    const lastOrderAt = new Map<string, Date>();
    for (const g of last) if (g.pointId && g._max.at) lastOrderAt.set(g.pointId, g._max.at);
    return salesReport({
      from: fromDate,
      to: toDate,
      rows: orders.map(row),
      prevRows: prevOrders.map(row),
      reps,
      // С выбранным торговым «без заказов» — только его точки (где он бывал или заказывал), иначе список бессмысленно длинный.
      points: q?.repId ? points.filter((p) => lastOrderAt.has(p.id)) : points,
      lastOrderAt,
    });
  }
}
