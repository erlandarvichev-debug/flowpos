import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { Scope } from '../../common/scope';
import { assertSolution } from '../platform/platform.guards';
import {
  BIND_CODE_TTL_MS, DEFAULT_RADIUS_M, Placement, dateOnly, kzDayRange, newBindCode, parseRoutePoints, sha256, validLat, validLng,
} from './field-logic';

const bad = (fn: () => any) => {
  try { return fn(); } catch (e: any) { throw new BadRequestException(e.message); }
};
const str = (v: unknown, max = 200) => (v == null || String(v).trim() === '' ? null : String(v).trim().slice(0, max));

/** Рабочее место супервайзера на сайте: представители, точки, маршруты, задания, посещения. */
@Injectable()
export class FieldService {
  constructor(private prisma: PrismaService) {}

  private own(s: Scope) {
    return { tenantId: s.tenantId, organizationId: s.organizationId };
  }

  // ── Представители ──

  async reps(s: Scope) {
    const reps = await this.prisma.fieldRep.findMany({
      where: { organizationId: s.organizationId },
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
      include: { devices: { where: { revokedAt: null }, select: { id: true, model: true, appVersion: true, lastSeenAt: true, createdAt: true } } },
    });
    const sub = await this.prisma.orgSubscription.findUnique({ where: { organizationId_solution: { organizationId: s.organizationId, solution: 'supervisor' } } });
    return { seats: sub?.seats ?? null, active: reps.filter((r) => r.isActive).length, reps };
  }

  /** Активных представителей не больше, чем мест в подписке. */
  private async assertSeat(s: Scope, exceptRepId?: string) {
    const state = await assertSolution(this.prisma, s.organizationId, 'supervisor');
    if (state.seats == null) return;
    const active = await this.prisma.fieldRep.count({ where: { organizationId: s.organizationId, isActive: true, ...(exceptRepId ? { id: { not: exceptRepId } } : {}) } });
    if (active >= state.seats) throw new ForbiddenException(`По подписке можно ${state.seats} активных представителей — все места заняты`);
  }

  async createRep(s: Scope, b: any) {
    const name = str(b?.name, 120);
    if (!name) throw new BadRequestException('Укажите имя представителя');
    await this.assertSeat(s);
    return this.prisma.fieldRep.create({
      data: { ...this.own(s), name, phone: str(b?.phone, 40), moyskladLogin: str(b?.moyskladLogin, 120), supervisorId: s.userId },
    });
  }

  private async rep(s: Scope, id: string) {
    const rep = await this.prisma.fieldRep.findFirst({ where: { id, organizationId: s.organizationId } });
    if (!rep) throw new NotFoundException('Представитель не найден');
    return rep;
  }

  async updateRep(s: Scope, id: string, b: any) {
    const rep = await this.rep(s, id);
    const data: Prisma.FieldRepUpdateInput = {};
    if (b?.name !== undefined) {
      const name = str(b.name, 120);
      if (!name) throw new BadRequestException('Укажите имя представителя');
      data.name = name;
    }
    if (b?.phone !== undefined) data.phone = str(b.phone, 40);
    if (b?.moyskladLogin !== undefined) data.moyskladLogin = str(b.moyskladLogin, 120);
    if (b?.isActive !== undefined) {
      const active = !!b.isActive;
      if (active && !rep.isActive) await this.assertSeat(s, id);
      data.isActive = active;
    }
    const updated = await this.prisma.fieldRep.update({ where: { id }, data });
    // Отключённый представитель теряет доступ с телефона сразу.
    if (data.isActive === false) await this.prisma.fieldDevice.updateMany({ where: { repId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    return updated;
  }

  /** Код из 6 цифр для привязки телефона: 15 минут, один раз. Прежние неиспользованные коды гасятся. */
  async bindCode(s: Scope, repId: string) {
    const rep = await this.rep(s, repId);
    if (!rep.isActive) throw new BadRequestException('Представитель отключён');
    await assertSolution(this.prisma, s.organizationId, 'supervisor');
    const now = new Date();
    await this.prisma.fieldBindCode.updateMany({ where: { repId, usedAt: null, expiresAt: { gt: now } }, data: { expiresAt: now } });
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = newBindCode();
      try {
        const row = await this.prisma.fieldBindCode.create({
          data: { ...this.own(s), repId, codeHash: sha256(code), expiresAt: new Date(now.getTime() + BIND_CODE_TTL_MS), createdBy: s.userId },
        });
        return { code, expiresAt: row.expiresAt };
      } catch (e) {
        // Такой код уже выдан (в любой организации) — берём другой.
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') continue;
        throw e;
      }
    }
    throw new BadRequestException('Не удалось выдать код — повторите');
  }

  async revokeDevice(s: Scope, deviceId: string) {
    const { count } = await this.prisma.fieldDevice.updateMany({ where: { id: deviceId, organizationId: s.organizationId, revokedAt: null }, data: { revokedAt: new Date() } });
    if (!count) throw new NotFoundException('Телефон не найден');
    return { ok: true };
  }

  // ── Точки ──

  async points(s: Scope, q: any) {
    const search = str(q?.q, 100);
    return this.prisma.fieldPoint.findMany({
      where: {
        organizationId: s.organizationId,
        ...(q?.all ? {} : { isActive: true }),
        ...(search ? { OR: [{ name: { contains: search, mode: 'insensitive' } }, { address: { contains: search, mode: 'insensitive' } }, { phone: { contains: search } }] } : {}),
      },
      orderBy: { name: 'asc' },
      take: 2000,
    });
  }

  private pointData(b: any, partial: boolean): Prisma.FieldPointUncheckedUpdateInput {
    const data: Prisma.FieldPointUncheckedUpdateInput = {};
    if (!partial || b?.name !== undefined) {
      const name = str(b?.name, 200);
      if (!name) throw new BadRequestException('Укажите название точки');
      data.name = name;
    }
    if (b?.address !== undefined) data.address = str(b.address, 300);
    if (b?.phone !== undefined) data.phone = str(b.phone, 40);
    if (b?.lat !== undefined || b?.lng !== undefined) {
      if (b.lat == null && b.lng == null) {
        data.lat = null; data.lng = null; data.coordsSource = null;
      } else {
        const lat = Number(b.lat); const lng = Number(b.lng);
        if (!validLat(lat) || !validLng(lng)) throw new BadRequestException('Неверные координаты');
        data.lat = lat; data.lng = lng; data.coordsSource = 'supervisor';
      }
    }
    if (b?.radiusM !== undefined) {
      if (b.radiusM == null || b.radiusM === '') data.radiusM = null;
      else {
        const r = Number(b.radiusM);
        if (!Number.isInteger(r) || r < 10 || r > 5000) throw new BadRequestException('Радиус — от 10 до 5000 метров');
        data.radiusM = r;
      }
    }
    if (b?.isActive !== undefined) data.isActive = !!b.isActive;
    return data;
  }

  async createPoint(s: Scope, b: any) {
    const data = this.pointData(b, false) as any;
    return this.prisma.fieldPoint.create({ data: { ...this.own(s), ...data } });
  }

  async updatePoint(s: Scope, id: string, b: any) {
    const point = await this.prisma.fieldPoint.findFirst({ where: { id, organizationId: s.organizationId }, select: { id: true } });
    if (!point) throw new NotFoundException('Точка не найдена');
    return this.prisma.fieldPoint.update({ where: { id }, data: this.pointData(b, true) });
  }

  // ── Маршруты ──

  async route(s: Scope, repId: string, date: string) {
    await this.rep(s, repId);
    const route = await this.prisma.fieldRoute.findUnique({
      where: { repId_date: { repId, date: bad(() => dateOnly(date)) } },
      include: { stops: { orderBy: { position: 'asc' } } },
    });
    if (!route || route.organizationId !== s.organizationId) return { repId, date, note: null, stops: [] };
    const points = await this.prisma.fieldPoint.findMany({ where: { organizationId: s.organizationId, id: { in: route.stops.map((x) => x.pointId) } } });
    return { id: route.id, repId, date, note: route.note, stops: route.stops.map((st) => ({ position: st.position, point: points.find((p) => p.id === st.pointId) ?? null })) };
  }

  /** Маршрут на день целиком: точки по порядку (пустой список — маршрут удаляется). */
  async saveRoute(s: Scope, b: any) {
    const repId = String(b?.repId ?? '');
    await this.rep(s, repId);
    const date = String(b?.date ?? '');
    const day = bad(() => dateOnly(date));
    const pointIds = bad(() => parseRoutePoints(b?.pointIds));
    if (pointIds.length) {
      const found = await this.prisma.fieldPoint.count({ where: { organizationId: s.organizationId, id: { in: pointIds } } });
      if (found !== pointIds.length) throw new BadRequestException('В маршруте есть точка другой организации или удалённая');
    }
    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.fieldRoute.findUnique({ where: { repId_date: { repId, date: day } } });
      if (existing && existing.organizationId !== s.organizationId) throw new ForbiddenException('Чужой маршрут');
      if (!pointIds.length) {
        if (existing) await tx.fieldRoute.delete({ where: { id: existing.id } });
        return;
      }
      const route = existing
        ? await tx.fieldRoute.update({ where: { id: existing.id }, data: { note: str(b?.note, 500) } })
        : await tx.fieldRoute.create({ data: { ...this.own(s), repId, date: day, note: str(b?.note, 500), createdBy: s.userId } });
      await tx.fieldRouteStop.deleteMany({ where: { routeId: route.id } });
      await tx.fieldRouteStop.createMany({ data: pointIds.map((pointId, i) => ({ ...this.own(s), routeId: route.id, pointId, position: i + 1 })) });
    });
    return this.route(s, repId, date);
  }

  /** Скопировать маршрут представителя с одной даты на другую (на другой день — заменяет). */
  async copyRoute(s: Scope, b: any) {
    const src = await this.route(s, String(b?.repId ?? ''), String(b?.from ?? ''));
    if (!src.stops.length) throw new BadRequestException('На исходную дату маршрута нет');
    const toRepId = b?.toRepId ? String(b.toRepId) : src.repId;
    return this.saveRoute(s, { repId: toRepId, date: b?.to, note: src.note, pointIds: (src.stops as Array<{ point: { id: string } | null }>).filter((x) => x.point).map((x) => x.point!.id) });
  }

  // ── Задания ──

  async tasks(s: Scope, q: any) {
    return this.prisma.fieldTask.findMany({
      where: {
        organizationId: s.organizationId,
        ...(q?.repId ? { repId: String(q.repId) } : {}),
        ...(q?.status ? { status: String(q.status) } : {}),
      },
      orderBy: [{ status: 'asc' }, { dueDate: 'asc' }, { createdAt: 'desc' }],
      take: 1000,
    });
  }

  async createTask(s: Scope, b: any) {
    const repId = String(b?.repId ?? '');
    await this.rep(s, repId);
    const title = str(b?.title, 200);
    if (!title) throw new BadRequestException('Укажите, что сделать');
    const pointId = b?.pointId ? String(b.pointId) : null;
    if (pointId && !(await this.prisma.fieldPoint.count({ where: { id: pointId, organizationId: s.organizationId } }))) throw new BadRequestException('Точка не найдена');
    return this.prisma.fieldTask.create({
      data: {
        ...this.own(s), repId, pointId, title, text: str(b?.text, 2000),
        dueDate: b?.dueDate ? bad(() => dateOnly(String(b.dueDate))) : null, createdBy: s.userId,
      },
    });
  }

  async updateTask(s: Scope, id: string, b: any) {
    const task = await this.prisma.fieldTask.findFirst({ where: { id, organizationId: s.organizationId } });
    if (!task) throw new NotFoundException('Задание не найдено');
    const data: Prisma.FieldTaskUpdateInput = {};
    if (b?.title !== undefined) {
      const title = str(b.title, 200);
      if (!title) throw new BadRequestException('Укажите, что сделать');
      data.title = title;
    }
    if (b?.text !== undefined) data.text = str(b.text, 2000);
    if (b?.dueDate !== undefined) data.dueDate = b.dueDate ? bad(() => dateOnly(String(b.dueDate))) : null;
    if (b?.status !== undefined) {
      if (!['open', 'cancelled'].includes(b.status)) throw new BadRequestException('Супервайзер может открыть или отменить задание; выполняет — представитель');
      data.status = b.status;
      if (b.status === 'open') { data.doneAt = null; data.result = null; data.visitId = null; }
    }
    return this.prisma.fieldTask.update({ where: { id }, data });
  }

  // ── Посещения, день на карте, план/факт ──

  async visits(s: Scope, q: any) {
    const { from, to } = bad(() => kzDayRange(String(q?.date ?? '')));
    const where = { organizationId: s.organizationId, startedAt: { gte: from, lt: to }, ...(q?.repId ? { repId: String(q.repId) } : {}) };
    const visits = await this.prisma.fieldVisit.findMany({
      where, orderBy: { startedAt: 'asc' },
      include: { photos: { select: { id: true, takenAt: true, lat: true, lng: true }, orderBy: { takenAt: 'asc' } } },
    });
    const [points, reps, orders, tasks] = await Promise.all([
      this.prisma.fieldPoint.findMany({ where: { organizationId: s.organizationId, id: { in: [...new Set(visits.map((v) => v.pointId))] } }, select: { id: true, name: true, address: true } }),
      this.prisma.fieldRep.findMany({ where: { organizationId: s.organizationId }, select: { id: true, name: true } }),
      this.prisma.fieldOrder.findMany({ where: { organizationId: s.organizationId, visitId: { in: visits.map((v) => v.id) } } }),
      this.prisma.fieldTask.findMany({ where: { organizationId: s.organizationId, visitId: { in: visits.map((v) => v.id) } }, select: { id: true, title: true, result: true, visitId: true } }),
    ]);
    return visits.map((v) => ({
      ...v,
      point: points.find((p) => p.id === v.pointId) ?? null,
      rep: reps.find((r) => r.id === v.repId) ?? null,
      orders: orders.filter((o) => o.visitId === v.id),
      tasks: tasks.filter((t) => t.visitId === v.id),
    }));
  }

  /** День представителя: план (маршрут), посещения, заказы и отметки местоположения — для карты. */
  async day(s: Scope, q: any) {
    const repId = String(q?.repId ?? '');
    const date = String(q?.date ?? '');
    await this.rep(s, repId);
    const { from, to } = bad(() => kzDayRange(date));
    const [route, visits, orders, track] = await Promise.all([
      this.route(s, repId, date),
      this.prisma.fieldVisit.findMany({ where: { organizationId: s.organizationId, repId, startedAt: { gte: from, lt: to } }, orderBy: { startedAt: 'asc' } }),
      this.prisma.fieldOrder.findMany({ where: { organizationId: s.organizationId, repId, at: { gte: from, lt: to } }, orderBy: { at: 'asc' } }),
      this.prisma.fieldTrack.findMany({ where: { organizationId: s.organizationId, repId, at: { gte: from, lt: to } }, orderBy: { at: 'asc' }, take: 5000 }),
    ]);
    const visitPoints = await this.prisma.fieldPoint.findMany({ where: { organizationId: s.organizationId, id: { in: visits.map((v) => v.pointId) } } });
    return { route, visits: visits.map((v) => ({ ...v, point: visitPoints.find((p) => p.id === v.pointId) ?? null })), orders, track };
  }

  /** План/факт по представителям за период: точки в маршрутах, посещённые из них, вне маршрута, заказы. */
  async planFact(s: Scope, q: any) {
    const fromDate = String(q?.from ?? '');
    const toDate = String(q?.to ?? fromDate);
    const from = bad(() => kzDayRange(fromDate)).from;
    const to = bad(() => kzDayRange(toDate)).to;
    if (to.getTime() - from.getTime() > 93 * 24 * 3600 * 1000) throw new BadRequestException('Период — не больше трёх месяцев');
    const [reps, routes, visits, orders] = await Promise.all([
      this.prisma.fieldRep.findMany({ where: { organizationId: s.organizationId }, select: { id: true, name: true, isActive: true } }),
      this.prisma.fieldRoute.findMany({ where: { organizationId: s.organizationId, date: { gte: dateOnly(fromDate), lte: dateOnly(toDate) } }, include: { stops: true } }),
      this.prisma.fieldVisit.findMany({ where: { organizationId: s.organizationId, startedAt: { gte: from, lt: to } }, select: { repId: true, pointId: true, startedAt: true, placement: true } }),
      this.prisma.fieldOrder.findMany({ where: { organizationId: s.organizationId, at: { gte: from, lt: to } }, select: { repId: true, sum: true, placement: true } }),
    ]);
    const kzDate = (d: Date) => new Date(d.getTime() + 5 * 3600 * 1000).toISOString().slice(0, 10);
    return reps
      .map((r) => {
        const myRoutes = routes.filter((x) => x.repId === r.id);
        const myVisits = visits.filter((v) => v.repId === r.id);
        const visitedKeys = new Set(myVisits.map((v) => `${kzDate(v.startedAt)}|${v.pointId}`));
        const planned = myRoutes.reduce((n, x) => n + x.stops.length, 0);
        const plannedKeys = new Set(myRoutes.flatMap((x) => x.stops.map((st) => `${x.date.toISOString().slice(0, 10)}|${st.pointId}`)));
        const visitedPlanned = [...plannedKeys].filter((k) => visitedKeys.has(k)).length;
        const myOrders = orders.filter((o) => o.repId === r.id);
        const count = (p: Placement) => myVisits.filter((v) => v.placement === p).length;
        return {
          rep: r,
          planned,
          visitedPlanned,
          missed: planned - visitedPlanned,
          extraVisits: [...visitedKeys].filter((k) => !plannedKeys.has(k)).length,
          visits: myVisits.length,
          onSite: count('on_site'),
          remote: count('remote'),
          unknown: count('unknown'),
          orders: myOrders.length,
          ordersSum: myOrders.reduce((sum, o) => sum + Number(o.sum), 0),
          ordersRemote: myOrders.filter((o) => o.placement === 'remote').length,
        };
      })
      .filter((x) => x.rep.isActive || x.visits || x.planned);
  }

  defaults() {
    return { radiusM: DEFAULT_RADIUS_M };
  }
}
