import { BadRequestException, CanActivate, ExecutionContext, ForbiddenException, Injectable, NotFoundException, UnauthorizedException, createParamDecorator } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { bindRequestTenant, runAsSystem } from '../../common/db-context';
import { assertSolution } from '../platform/platform.guards';
import { solutionState } from '../platform/subscriptions';
import { FieldPhotoStore } from './field-photos';
import {
  PHOTO_MAX_BYTES, dateOnly, decidePlacement, kzDayRange, kzToday, newDeviceToken, normalizeBindCode, parseClientUuid, parseDeviceTime, parseFix, photoKind, sha256,
} from './field-logic';

/** Телефон представителя, проверенный по токену. */
export interface FieldDeviceCtx {
  deviceId: string;
  repId: string;
  tenantId: string;
  organizationId: string;
}

export const DEVICE_HEADER = 'x-device-token';

export const FieldDevice = createParamDecorator((_: unknown, ctx: ExecutionContext): FieldDeviceCtx => {
  const d = ctx.switchToHttp().getRequest().fieldDevice;
  if (!d) throw new UnauthorizedException('Телефон не привязан');
  return d;
});

/**
 * Вход телефона: заголовок X-Device-Token (выдан при привязке кодом). Отозванный телефон, отключённый
 * представитель или приостановленная подписка — отказ. Дальше запрос работает от имени клиента телефона (RLS).
 */
@Injectable()
export class FieldDeviceGuard implements CanActivate {
  constructor(private prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const raw = req.headers[DEVICE_HEADER];
    const token = Array.isArray(raw) ? raw[0] : raw;
    if (!token || typeof token !== 'string' || !token.startsWith('fdt_')) throw new UnauthorizedException('Телефон не привязан — введите код от супервайзера');
    const device = await runAsSystem(() => this.prisma.fieldDevice.findUnique({
      where: { tokenHash: sha256(token) },
      select: { id: true, repId: true, tenantId: true, organizationId: true, revokedAt: true, lastSeenAt: true, rep: { select: { isActive: true } } },
    }));
    if (!device || device.revokedAt || !device.rep.isActive) throw new UnauthorizedException('Телефон отвязан — попросите у супервайзера новый код');
    bindRequestTenant(device.tenantId);
    await assertSolution(this.prisma, device.organizationId, 'supervisor');
    const appVersion = typeof req.headers['x-app-version'] === 'string' ? String(req.headers['x-app-version']).slice(0, 40) : undefined;
    if (!device.lastSeenAt || Date.now() - device.lastSeenAt.getTime() > 60_000 || appVersion) {
      await this.prisma.fieldDevice.update({ where: { id: device.id }, data: { lastSeenAt: new Date(), ...(appVersion ? { appVersion } : {}) } });
    }
    req.fieldDevice = { deviceId: device.id, repId: device.repId, tenantId: device.tenantId, organizationId: device.organizationId } as FieldDeviceCtx;
    return true;
  }
}

const bad = <T>(fn: () => T): T => {
  try { return fn(); } catch (e: any) { throw new BadRequestException(e.message); }
};
const str = (v: unknown, max = 200) => (v == null || String(v).trim() === '' ? null : String(v).trim().slice(0, max));

export interface UploadedPhoto { buffer: Buffer; size: number }

/** API агента на телефоне: привязка, маршрут на день, посещения, фото, заказы, отметки местоположения. */
@Injectable()
export class FieldAgentService {
  constructor(private prisma: PrismaService, private photos: FieldPhotoStore) {}

  private own(d: FieldDeviceCtx) {
    return { tenantId: d.tenantId, organizationId: d.organizationId };
  }

  /** Привязка телефона кодом из 6 цифр. Код одноразовый; телефон получает постоянный токен. */
  async bind(b: any) {
    const code = normalizeBindCode(b?.code);
    if (code.length !== 6) throw new BadRequestException('Код — 6 цифр');
    const now = new Date();
    const token = newDeviceToken();
    const result = await runAsSystem(() => this.prisma.$transaction(async (tx) => {
      const row = await tx.fieldBindCode.findUnique({ where: { codeHash: sha256(code) }, include: { rep: true } });
      if (!row || row.usedAt || row.expiresAt <= now || !row.rep.isActive) return null;
      const sub = await tx.orgSubscription.findUnique({ where: { organizationId_solution: { organizationId: row.organizationId, solution: 'supervisor' } } });
      const state = solutionState('supervisor', sub);
      if (!state.enabled) throw new ForbiddenException(`Решение «Супервайзер» недоступно: ${state.reason}`);
      const used = await tx.fieldBindCode.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: now } });
      if (!used.count) return null;
      const device = await tx.fieldDevice.create({
        data: { tenantId: row.tenantId, organizationId: row.organizationId, repId: row.repId, tokenHash: sha256(token), model: str(b?.model, 120), appVersion: str(b?.appVersion, 40), lastSeenAt: now },
      });
      const org = await tx.organization.findUnique({ where: { id: row.organizationId }, select: { name: true } });
      return { device, rep: row.rep, orgName: org?.name ?? '' };
    }));
    if (!result) throw new BadRequestException('Код неверный или устарел — попросите у супервайзера новый');
    return { token, rep: { id: result.rep.id, name: result.rep.name }, organization: { id: result.rep.organizationId, name: result.orgName } };
  }

  async me(d: FieldDeviceCtx) {
    const [rep, org] = await Promise.all([
      this.prisma.fieldRep.findUnique({ where: { id: d.repId }, select: { id: true, name: true, phone: true } }),
      this.prisma.organization.findUnique({ where: { id: d.organizationId }, select: { id: true, name: true } }),
    ]);
    return { rep, organization: org };
  }

  /** Отвязать свой телефон (выход в агенте). */
  async unbind(d: FieldDeviceCtx) {
    await this.prisma.fieldDevice.update({ where: { id: d.deviceId }, data: { revokedAt: new Date() } });
    return { ok: true };
  }

  /** Маршрут на день по порядку, задания и уже сделанные посещения. */
  async today(d: FieldDeviceCtx, date?: string) {
    const day = date || kzToday();
    const { from, to } = bad(() => kzDayRange(day));
    const route = await this.prisma.fieldRoute.findUnique({ where: { repId_date: { repId: d.repId, date: bad(() => dateOnly(day)) } }, include: { stops: { orderBy: { position: 'asc' } } } });
    const [tasks, visits] = await Promise.all([
      this.prisma.fieldTask.findMany({
        where: { organizationId: d.organizationId, repId: d.repId, status: 'open', OR: [{ dueDate: null }, { dueDate: { lte: dateOnly(day) } }] },
        orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }],
      }),
      this.prisma.fieldVisit.findMany({ where: { organizationId: d.organizationId, repId: d.repId, startedAt: { gte: from, lt: to } }, select: { id: true, clientUuid: true, pointId: true, startedAt: true, finishedAt: true, placement: true } }),
    ]);
    const pointIds = [...new Set([...(route?.stops.map((x) => x.pointId) ?? []), ...tasks.map((t) => t.pointId).filter(Boolean) as string[]])];
    const points = await this.prisma.fieldPoint.findMany({ where: { organizationId: d.organizationId, id: { in: pointIds } } });
    const pointView = (id: string) => {
      const p = points.find((x) => x.id === id);
      return p ? { id: p.id, name: p.name, address: p.address, phone: p.phone, moyskladId: p.moyskladId, lat: p.lat, lng: p.lng, radiusM: p.radiusM } : null;
    };
    return {
      date: day,
      note: route?.note ?? null,
      stops: (route?.stops ?? []).map((x) => ({ position: x.position, point: pointView(x.pointId), visited: visits.some((v) => v.pointId === x.pointId) })),
      tasks: tasks.map((t) => ({ id: t.id, title: t.title, text: t.text, dueDate: t.dueDate, point: t.pointId ? pointView(t.pointId) : null })),
      visits,
    };
  }

  /** Клиенты из МойСклад, с которыми работает представитель, — в точки организации (координаты не трогаются). */
  async syncPoints(d: FieldDeviceCtx, b: any) {
    const items = Array.isArray(b?.points) ? b.points : [];
    if (items.length > 5000) throw new BadRequestException('Не больше 5000 точек за раз');
    const out: Record<string, string> = {};
    for (const it of items) {
      const moyskladId = str(it?.moyskladId, 64);
      const name = str(it?.name, 200);
      if (!moyskladId || !name) continue;
      const data = { name, address: str(it?.address, 300), phone: str(it?.phone, 40) };
      const p = await this.prisma.fieldPoint.upsert({
        where: { organizationId_moyskladId: { organizationId: d.organizationId, moyskladId } },
        create: { ...this.own(d), moyskladId, ...data },
        update: data,
        select: { id: true },
      });
      out[moyskladId] = p.id;
    }
    return { points: out };
  }

  /** Точка по id или по контрагенту МойСклад (у посещения — moyskladId, у заказа — pointMoyskladId). */
  private async point(d: FieldDeviceCtx, b: any, moyskladKey: 'moyskladId' | 'pointMoyskladId' = 'moyskladId') {
    if (b?.pointId) {
      const p = await this.prisma.fieldPoint.findFirst({ where: { id: String(b.pointId), organizationId: d.organizationId } });
      if (!p) throw new NotFoundException('Точка не найдена');
      return p;
    }
    const moyskladId = str(b?.[moyskladKey], 64);
    if (!moyskladId) return null;
    const name = str(b?.pointName, 200);
    const existing = await this.prisma.fieldPoint.findUnique({ where: { organizationId_moyskladId: { organizationId: d.organizationId, moyskladId } } });
    if (existing) return existing;
    if (!name) throw new BadRequestException('Точка не найдена — обновите список клиентов');
    return this.prisma.fieldPoint.create({ data: { ...this.own(d), moyskladId, name, address: str(b?.pointAddress, 300) } });
  }

  /** «Запомнить место точки»: только если у точки ещё нет координат и точность не хуже 100 м. */
  async rememberLocation(d: FieldDeviceCtx, pointId: string, b: any) {
    const fix = bad(() => parseFix(b));
    if (fix.lat == null || fix.lng == null) throw new BadRequestException('Нет местоположения телефона');
    if (fix.accuracyM == null || fix.accuracyM > 100) throw new BadRequestException('Местоположение неточное (хуже 100 м) — выйдите на открытое место и повторите');
    const { count } = await this.prisma.fieldPoint.updateMany({
      where: { id: pointId, organizationId: d.organizationId, lat: null },
      data: { lat: fix.lat, lng: fix.lng, coordsSource: 'rep' },
    });
    if (!count) throw new BadRequestException('У точки уже есть место — изменить его может супервайзер');
    return { ok: true };
  }

  /**
   * Посещение. Повторная отправка с тем же clientUuid не создаёт дубль — дописывает окончание и комментарий.
   * «На точке / удалённо» решает сервер по местоположению в начале посещения.
   */
  async visit(d: FieldDeviceCtx, b: any) {
    const clientUuid = bad(() => parseClientUuid(b?.clientUuid));
    const finishedAt = b?.finishedAt ? bad(() => parseDeviceTime(b.finishedAt)) : null;
    const comment = str(b?.comment, 2000);
    const existing = await this.prisma.fieldVisit.findUnique({ where: { organizationId_clientUuid: { organizationId: d.organizationId, clientUuid } } });
    let visit = existing;
    if (existing) {
      if (existing.repId !== d.repId) throw new ForbiddenException('Чужое посещение');
      visit = await this.prisma.fieldVisit.update({
        where: { id: existing.id },
        data: { ...(finishedAt ? { finishedAt } : {}), ...(comment !== null ? { comment } : {}) },
      });
    } else {
      const point = await this.point(d, b);
      if (!point) throw new BadRequestException('Не указана точка посещения');
      const startedAt = bad(() => parseDeviceTime(b?.startedAt));
      const fix = bad(() => parseFix(b));
      const { placement, distanceM } = decidePlacement(fix, point);
      try {
        visit = await this.prisma.fieldVisit.create({
          data: { ...this.own(d), repId: d.repId, pointId: point.id, clientUuid, startedAt, finishedAt, lat: fix.lat, lng: fix.lng, accuracyM: fix.accuracyM, distanceM, placement, comment },
        });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return this.visit(d, b);
        throw e;
      }
      if (fix.lat != null && fix.lng != null) {
        await this.prisma.fieldTrack.create({ data: { ...this.own(d), repId: d.repId, at: startedAt, lat: fix.lat, lng: fix.lng, accuracyM: fix.accuracyM, event: 'visit_start' } });
      }
    }
    // Результаты заданий, выполненных в этом посещении.
    const tasks = Array.isArray(b?.tasks) ? b.tasks.slice(0, 50) : [];
    for (const t of tasks) {
      if (!t?.id) continue;
      await this.prisma.fieldTask.updateMany({
        where: { id: String(t.id), organizationId: d.organizationId, repId: d.repId, status: 'open' },
        data: { status: 'done', result: str(t.result, 2000), doneAt: finishedAt ?? new Date(), visitId: visit!.id },
      });
    }
    return { id: visit!.id, clientUuid, placement: visit!.placement, distanceM: visit!.distanceM };
  }

  /** Фото к посещению (JPEG/PNG/WebP до 2 МБ). Повтор с тем же clientUuid фото — без дубля. */
  async photo(d: FieldDeviceCtx, visitClientUuid: string, file: UploadedPhoto | undefined, b: any) {
    if (!file?.buffer?.length) throw new BadRequestException('Нет файла фото');
    if (file.size > PHOTO_MAX_BYTES) throw new BadRequestException('Фото больше 2 МБ — уменьшите размер');
    const kind = photoKind(file.buffer);
    if (!kind) throw new BadRequestException('Фото — только JPEG, PNG или WebP');
    const clientUuid = bad(() => parseClientUuid(b?.clientUuid));
    const visit = await this.prisma.fieldVisit.findUnique({ where: { organizationId_clientUuid: { organizationId: d.organizationId, clientUuid: visitClientUuid } } });
    if (!visit || visit.repId !== d.repId) throw new NotFoundException('Посещение не найдено — сначала отправьте посещение');
    const dup = await this.prisma.fieldPhoto.findUnique({ where: { organizationId_clientUuid: { organizationId: d.organizationId, clientUuid } }, select: { id: true } });
    if (dup) return { id: dup.id, duplicate: true };
    const takenAt = b?.takenAt ? bad(() => parseDeviceTime(b.takenAt)) : new Date();
    const fix = bad(() => parseFix({ lat: b?.lat == null ? null : Number(b.lat), lng: b?.lng == null ? null : Number(b.lng), accuracy: b?.accuracy }));
    const id = randomUUID();
    const rel = await this.photos.save(d.organizationId, id, kind.ext, file.buffer);
    try {
      await this.prisma.fieldPhoto.create({
        data: { id, ...this.own(d), visitId: visit.id, repId: d.repId, clientUuid, path: rel, size: file.size, mime: kind.mime, takenAt, lat: fix.lat, lng: fix.lng },
      });
    } catch (e) {
      await this.photos.remove(rel).catch(() => undefined);
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return { duplicate: true };
      throw e;
    }
    if (fix.lat != null && fix.lng != null) {
      await this.prisma.fieldTrack.create({ data: { ...this.own(d), repId: d.repId, at: takenAt, lat: fix.lat, lng: fix.lng, accuracyM: fix.accuracyM, event: 'photo' } });
    }
    return { id };
  }

  /** Заказ, оформленный в агенте (сам заказ уже в МойСклад): где оформлен — решает сервер. */
  async order(d: FieldDeviceCtx, b: any) {
    const clientUuid = bad(() => parseClientUuid(b?.clientUuid));
    const dup = await this.prisma.fieldOrder.findUnique({ where: { organizationId_clientUuid: { organizationId: d.organizationId, clientUuid } } });
    if (dup) return { id: dup.id, placement: dup.placement, distanceM: dup.distanceM, duplicate: true };
    const at = bad(() => parseDeviceTime(b?.at));
    const sum = Number(b?.sum);
    if (!Number.isFinite(sum) || sum < 0 || sum > 1e11) throw new BadRequestException('Неверная сумма заказа');
    const fix = bad(() => parseFix(b));
    // moyskladId у заказа — сам заказ в МойСклад, точка — pointMoyskladId.
    const point = await this.point(d, b, 'pointMoyskladId');
    const visit = b?.visitClientUuid
      ? await this.prisma.fieldVisit.findUnique({ where: { organizationId_clientUuid: { organizationId: d.organizationId, clientUuid: String(b.visitClientUuid) } }, select: { id: true, repId: true } })
      : null;
    const { placement, distanceM } = decidePlacement(fix, point);
    const row = await this.prisma.fieldOrder.create({
      data: {
        ...this.own(d), repId: d.repId, pointId: point?.id ?? null, visitId: visit && visit.repId === d.repId ? visit.id : null, clientUuid,
        moyskladId: str(b?.moyskladId, 64), number: str(b?.number, 64), sum: new Prisma.Decimal(sum.toFixed(2)), at,
        lat: fix.lat, lng: fix.lng, accuracyM: fix.accuracyM, distanceM, placement,
      },
    });
    if (fix.lat != null && fix.lng != null) {
      await this.prisma.fieldTrack.create({ data: { ...this.own(d), repId: d.repId, at, lat: fix.lat, lng: fix.lng, accuracyM: fix.accuracyM, event: 'order' } });
    }
    return { id: row.id, placement, distanceM };
  }

  /** Отметки местоположения пачкой (накопленные без связи). */
  async track(d: FieldDeviceCtx, b: any) {
    const items = Array.isArray(b?.items) ? b.items : [];
    if (items.length > 500) throw new BadRequestException('Не больше 500 отметок за раз');
    const events = new Set(['visit_start', 'visit_end', 'photo', 'order', 'app_open']);
    const data = [] as Prisma.FieldTrackCreateManyInput[];
    for (const it of items) {
      try {
        const fix = parseFix(it);
        if (fix.lat == null || fix.lng == null) continue;
        data.push({ ...this.own(d), repId: d.repId, at: parseDeviceTime(it?.at), lat: fix.lat, lng: fix.lng, accuracyM: fix.accuracyM, event: events.has(it?.event) ? it.event : 'app_open' });
      } catch { /* испорченная отметка пропускается — остальные принимаются */ }
    }
    if (data.length) await this.prisma.fieldTrack.createMany({ data });
    return { accepted: data.length };
  }
}
