// FP-027: прайс-листы, скидки, округление; компиляция правил в снимок, предпросмотр и публикация снимков для касс.
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { Scope, tenantCatalog } from '../../common/scope';
import { ENGINE_VERSION, PricingError, SnapshotPayload, evaluate } from './engine';

type Db = Prisma.TransactionClient | PrismaService;
const STATUSES = ['DRAFT', 'ACTIVE', 'ARCHIVED'];
const KINDS = ['PERCENT', 'AMOUNT', 'FIXED_PRICE'];
const HORIZON_MAX = 31;

const bad = (code: string, message: string) => new BadRequestException({ code, message });
const iso = (d: Date) => d.toISOString().slice(0, 10);
/** «Сегодня» по времени Казахстана (UTC+5): после полуночи по Алматы — уже новый день, хотя в UTC ещё вчера. */
export const kzToday = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Almaty', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
function day(v: unknown, what: string): Date {
  const s = String(v ?? '');
  const d = new Date(`${s}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || isNaN(d.getTime()) || iso(d) !== s) throw bad('DATE', `${what}: дата ГГГГ-ММ-ДД`);
  return d;
}
function dec(v: unknown, what: string, opts: { scale: number; min?: string; max?: string; positive?: boolean }): Prisma.Decimal {
  let x: Prisma.Decimal;
  try { x = new Prisma.Decimal(String(v ?? '')); } catch { throw bad('NUMBER', `${what}: нужно число`); }
  if (!x.isFinite() || x.decimalPlaces() > opts.scale) throw bad('NUMBER', `${what}: число, не больше ${opts.scale} знаков после запятой`);
  if (opts.positive && x.lte(0)) throw bad('NUMBER', `${what}: больше нуля`);
  if (opts.min !== undefined && x.lt(opts.min)) throw bad('NUMBER', `${what}: не меньше ${opts.min}`);
  if (opts.max !== undefined && x.gt(opts.max)) throw bad('NUMBER', `${what}: не больше ${opts.max}`);
  return x;
}
const engineError = (e: unknown): never => {
  if (e instanceof PricingError) throw bad(e.code, e.message);
  throw e;
};

@Injectable()
export class PricingService {
  constructor(private prisma: PrismaService) {}

  // ── Проверки ссылок: только своя организация и справочник своего клиента ──

  private async stores(s: Scope, ids: unknown): Promise<string[]> {
    const list = Array.isArray(ids) ? [...new Set(ids.map(String))] : [];
    if (list.length && (await this.prisma.store.count({ where: { id: { in: list }, organizationId: s.organizationId } })) !== list.length) {
      throw bad('REF_FOREIGN', 'Указан магазин, которого нет в этой организации');
    }
    return list.sort();
  }

  private async products(s: Scope, ids: unknown): Promise<string[]> {
    const list = Array.isArray(ids) ? [...new Set(ids.map(String))] : [];
    if (list.length && (await this.prisma.product.count({ where: { id: { in: list }, ...tenantCatalog(s), deleted: false } })) !== list.length) {
      throw bad('REF_FOREIGN', 'Указан товар, которого нет в справочнике организации');
    }
    return list.sort();
  }

  private async groups(s: Scope, ids: unknown): Promise<string[]> {
    const list = Array.isArray(ids) ? [...new Set(ids.map(String))] : [];
    if (list.length && (await this.prisma.productGroup.count({ where: { id: { in: list }, tenantId: s.tenantId } })) !== list.length) {
      throw bad('REF_FOREIGN', 'Указана группа товаров другого клиента');
    }
    return list.sort();
  }

  private interval(b: any, cur?: { validFrom: Date; validTo: Date | null }) {
    const validFrom = 'validFrom' in b ? day(b.validFrom, 'Начало действия') : cur?.validFrom;
    if (!validFrom) throw bad('DATE', 'Укажите начало действия');
    const validTo = 'validTo' in b ? (b.validTo ? day(b.validTo, 'Окончание действия') : null) : cur?.validTo ?? null;
    if (validTo && validTo < validFrom) throw bad('INTERVAL', 'Окончание действия раньше начала');
    return { validFrom, validTo };
  }

  private priority(v: unknown) {
    const p = Number(v ?? 0);
    if (!Number.isInteger(p) || p < -1000 || p > 1000) throw bad('PRIORITY', 'Приоритет — целое число от −1000 до 1000 (больше — важнее)');
    return p;
  }

  private audit(s: Scope, action: string, entity: string, entityId: string, after: Record<string, unknown>, db: Db = this.prisma) {
    return db.auditLog.create({ data: { userId: s.userId, organizationId: s.organizationId, action, entity, entityId, after: after as any } });
  }

  // ── Прайс-листы ──

  listPriceLists(s: Scope) {
    return this.prisma.priceList.findMany({
      where: { organizationId: s.organizationId },
      orderBy: [{ status: 'asc' }, { priority: 'desc' }, { validFrom: 'desc' }],
      include: { _count: { select: { items: true } } },
    });
  }

  private async ownList(s: Scope, id: string) {
    const l = await this.prisma.priceList.findFirst({ where: { id, organizationId: s.organizationId } });
    if (!l) throw new NotFoundException('Прайс-лист не найден');
    return l;
  }

  async getPriceList(s: Scope, id: string) {
    await this.ownList(s, id);
    return this.prisma.priceList.findUniqueOrThrow({ where: { id }, include: { items: { orderBy: [{ productId: 'asc' }, { minQty: 'asc' }] } } });
  }

  async createPriceList(s: Scope, b: any) {
    const name = String(b?.name ?? '').trim();
    if (!name) throw bad('NAME_REQUIRED', 'Укажите название прайс-листа');
    if (b?.currency && b.currency !== 'KZT') throw bad('CURRENCY', 'Пока поддерживаются цены в тенге (KZT)');
    const l = await this.prisma.priceList.create({ data: {
      tenantId: s.tenantId, organizationId: s.organizationId, name, priority: this.priority(b?.priority), ...this.interval(b ?? {}),
      storeIds: await this.stores(s, b?.storeIds), createdBy: s.userId,
    } });
    await this.audit(s, 'PRICE_LIST_CREATED', 'price_list', l.id, { name, priority: l.priority });
    return l;
  }

  async updatePriceList(s: Scope, id: string, b: any) {
    const cur = await this.ownList(s, id);
    if (cur.status === 'ARCHIVED') throw bad('ARCHIVED', 'Прайс-лист в архиве');
    const data: Prisma.PriceListUpdateInput = {};
    if ('name' in b) {
      const name = String(b.name ?? '').trim();
      if (!name) throw bad('NAME_REQUIRED', 'Укажите название прайс-листа');
      data.name = name;
    }
    if ('priority' in b) data.priority = this.priority(b.priority);
    if ('validFrom' in b || 'validTo' in b) Object.assign(data, this.interval(b, cur));
    if ('storeIds' in b) data.storeIds = await this.stores(s, b.storeIds);
    if ('status' in b) {
      if (!STATUSES.includes(b.status)) throw bad('STATUS', `Статус: ${STATUSES.join(', ')}`);
      if (b.status === 'ACTIVE' && !(await this.prisma.priceListItem.count({ where: { priceListId: id } }))) throw bad('EMPTY_LIST', 'В прайс-листе нет ни одной цены');
      data.status = b.status;
    }
    const l = await this.prisma.priceList.update({ where: { id }, data });
    await this.audit(s, 'PRICE_LIST_UPDATED', 'price_list', id, { changes: Object.keys(data), status: l.status });
    return l;
  }

  /** Цены прайс-листа: добавить/заменить (по товару и порогу количества) и удалить; всё или ничего. */
  async setItems(s: Scope, id: string, b: { upsert?: { productId: string; price: unknown; minQty?: unknown }[]; remove?: { productId: string; minQty?: unknown }[] }) {
    const l = await this.ownList(s, id);
    if (l.status === 'ARCHIVED') throw bad('ARCHIVED', 'Прайс-лист в архиве');
    const upsert = (b?.upsert ?? []).map((r, i) => ({
      productId: String(r.productId),
      price: dec(r.price, `Строка ${i + 1}: цена`, { scale: 2, min: '0' }),
      minQty: dec(r.minQty ?? 1, `Строка ${i + 1}: порог количества`, { scale: 3, positive: true }),
    }));
    const remove = (b?.remove ?? []).map((r, i) => ({ productId: String(r.productId), minQty: dec(r.minQty ?? 1, `Удаление ${i + 1}: порог`, { scale: 3, positive: true }) }));
    await this.products(s, upsert.map((r) => r.productId));
    await this.prisma.$transaction(async (tx) => {
      for (const r of remove) await tx.priceListItem.deleteMany({ where: { priceListId: id, productId: r.productId, minQty: r.minQty } });
      for (const r of upsert) {
        await tx.priceListItem.upsert({
          where: { priceListId_productId_minQty: { priceListId: id, productId: r.productId, minQty: r.minQty } },
          create: { tenantId: s.tenantId, priceListId: id, productId: r.productId, price: r.price, minQty: r.minQty },
          update: { price: r.price },
        });
      }
      await tx.priceList.update({ where: { id }, data: { updatedAt: new Date() } });
      await this.audit(s, 'PRICE_LIST_ITEMS_CHANGED', 'price_list', id, { upserted: upsert.length, removed: remove.length }, tx);
    });
    return this.getPriceList(s, id);
  }

  // ── Скидки ──

  listDiscounts(s: Scope) {
    return this.prisma.discountRule.findMany({ where: { organizationId: s.organizationId }, orderBy: [{ status: 'asc' }, { priority: 'desc' }, { validFrom: 'desc' }] });
  }

  private async discountData(s: Scope, b: any, cur?: { kind: string; validFrom: Date; validTo: Date | null }) {
    const out: Record<string, any> = {};
    if ('name' in b || !cur) {
      out.name = String(b.name ?? '').trim();
      if (!out.name) throw bad('NAME_REQUIRED', 'Укажите название скидки');
    }
    const kind = b.kind ?? cur?.kind;
    if (!KINDS.includes(kind)) throw bad('KIND', `Вид скидки: ${KINDS.join(', ')}`);
    if ('kind' in b) out.kind = kind;
    if ('value' in b || !cur) {
      out.value = kind === 'PERCENT' ? dec(b.value, 'Процент скидки', { scale: 4, positive: true, max: '100' })
        : kind === 'AMOUNT' ? dec(b.value, 'Сумма скидки на единицу', { scale: 2, positive: true })
          : dec(b.value, 'Фиксированная цена', { scale: 2, min: '0' });
    }
    if ('priority' in b) out.priority = this.priority(b.priority);
    if ('validFrom' in b || 'validTo' in b || !cur) Object.assign(out, this.interval(b, cur));
    if ('storeIds' in b) out.storeIds = await this.stores(s, b.storeIds);
    if ('productIds' in b) out.productIds = await this.products(s, b.productIds);
    if ('groupIds' in b) out.groupIds = await this.groups(s, b.groupIds);
    if ('minQty' in b) out.minQty = b.minQty == null || b.minQty === '' ? null : dec(b.minQty, 'Количество от', { scale: 3, positive: true });
    if ('minReceiptAmount' in b) out.minReceiptAmount = b.minReceiptAmount == null || b.minReceiptAmount === '' ? null : dec(b.minReceiptAmount, 'Сумма чека от', { scale: 2, positive: true });
    if ('status' in b) {
      if (!STATUSES.includes(b.status)) throw bad('STATUS', `Статус: ${STATUSES.join(', ')}`);
      out.status = b.status;
    }
    return out;
  }

  async createDiscount(s: Scope, b: any) {
    const data = await this.discountData(s, b ?? {});
    const r = await this.prisma.discountRule.create({ data: { ...(data as any), tenantId: s.tenantId, organizationId: s.organizationId, createdBy: s.userId } });
    await this.audit(s, 'DISCOUNT_CREATED', 'discount_rule', r.id, { name: r.name, kind: r.kind, value: r.value.toString() });
    return r;
  }

  async updateDiscount(s: Scope, id: string, b: any) {
    const cur = await this.prisma.discountRule.findFirst({ where: { id, organizationId: s.organizationId } });
    if (!cur) throw new NotFoundException('Скидка не найдена');
    if (cur.status === 'ARCHIVED') throw bad('ARCHIVED', 'Скидка в архиве');
    const data = await this.discountData(s, b ?? {}, cur);
    const r = await this.prisma.discountRule.update({ where: { id }, data });
    await this.audit(s, 'DISCOUNT_UPDATED', 'discount_rule', id, { changes: Object.keys(data), status: r.status });
    return r;
  }

  // ── Округление ──

  async settings(s: Scope) {
    const r = await this.prisma.pricingSettings.findUnique({ where: { organizationId: s.organizationId } });
    return { receiptStep: (r?.receiptStep ?? new Prisma.Decimal('0.01')).toFixed(2), receiptMode: r?.receiptMode ?? 'HALF_UP' };
  }

  async updateSettings(s: Scope, b: any) {
    const step = dec(b?.receiptStep ?? '0.01', 'Шаг округления', { scale: 2, positive: true, max: '100' });
    const mode = b?.receiptMode ?? 'HALF_UP';
    if (!['HALF_UP', 'DOWN'].includes(mode)) throw bad('ROUNDING_MODE', 'Режим: HALF_UP (математическое) или DOWN (в пользу покупателя)');
    await this.prisma.pricingSettings.upsert({ where: { organizationId: s.organizationId }, create: { organizationId: s.organizationId, receiptStep: step, receiptMode: mode, updatedBy: s.userId }, update: { receiptStep: step, receiptMode: mode, updatedBy: s.userId } });
    await this.audit(s, 'PRICING_SETTINGS_CHANGED', 'organization', s.organizationId, { receiptStep: step.toFixed(2), receiptMode: mode });
    return this.settings(s);
  }

  // ── Компиляция, предпросмотр, снимки ──

  /**
   * Набор правил организации, действующих хотя бы один день в [from, to] (магазин — его и общие; '*' — все).
   * Порядок полей и элементов фиксирован: одинаковые правила дают одинаковый JSON и hash.
   */
  async compile(s: Scope, storeId: string | null, from: Date, to: Date, db: Db = this.prisma): Promise<SnapshotPayload> {
    const active = { organizationId: s.organizationId, status: 'ACTIVE', validFrom: { lte: to }, OR: [{ validTo: null }, { validTo: { gte: from } }] };
    const storeOk = (ids: string[]) => storeId === null || ids.length === 0 || ids.includes(storeId);
    const lists = (await db.priceList.findMany({ where: active, include: { items: true }, orderBy: { id: 'asc' } })).filter((l) => storeOk(l.storeIds));
    const discounts = (await db.discountRule.findMany({ where: active, orderBy: { id: 'asc' } })).filter((d) => storeOk(d.storeIds));
    const productIds = [...new Set(lists.flatMap((l) => l.items.map((i) => i.productId)))].sort();
    const groups = productIds.length ? await db.product.findMany({ where: { id: { in: productIds } }, select: { id: true, groupId: true } }) : [];
    const groupOf = new Map(groups.map((g) => [g.id, g.groupId]));
    const st = await db.pricingSettings.findUnique({ where: { organizationId: s.organizationId } });
    const dateOrNull = (d: Date | null) => (d ? iso(d) : null);
    return {
      engineVersion: ENGINE_VERSION,
      organizationId: s.organizationId,
      currency: 'KZT',
      rounding: { receiptStep: (st?.receiptStep ?? new Prisma.Decimal('0.01')).toFixed(2), receiptMode: (st?.receiptMode ?? 'HALF_UP') as 'HALF_UP' | 'DOWN' },
      priceLists: lists.map((l) => ({
        id: l.id, name: l.name, priority: l.priority, validFrom: iso(l.validFrom), validTo: dateOrNull(l.validTo), storeIds: [...l.storeIds].sort(),
        items: l.items
          .map((i) => ({ productId: i.productId, price: i.price.toFixed(2), minQty: i.minQty.toString() }))
          .sort((a, b) => a.productId.localeCompare(b.productId) || Number(a.minQty) - Number(b.minQty)),
      })),
      discounts: discounts.map((d) => ({
        id: d.id, name: d.name, kind: d.kind as any, value: d.value.toString(), priority: d.priority, validFrom: iso(d.validFrom), validTo: dateOrNull(d.validTo),
        storeIds: [...d.storeIds].sort(), productIds: [...d.productIds].sort(), groupIds: [...d.groupIds].sort(),
        minQty: d.minQty?.toString() ?? null, minReceiptAmount: d.minReceiptAmount?.toFixed(2) ?? null,
      })),
      productGroups: Object.fromEntries(productIds.map((id) => [id, groupOf.get(id) ?? null])),
    };
  }

  /** Предпросмотр чека: цены, скидки, округление — тем же расчётом, что у кассы; либо по опубликованному снимку. */
  async preview(s: Scope, b: { date?: string; storeId?: string | null; snapshotId?: string; lines?: { productId: string; qty: unknown }[] }) {
    const date = b?.date ?? kzToday();
    const at = day(date, 'Дата');
    const storeId = b?.storeId ?? null;
    if (storeId) await this.stores(s, [storeId]);
    const lines = (b?.lines ?? []).map((l) => ({ productId: String(l.productId), qty: String(l.qty ?? '') }));
    if (!lines.length) throw bad('LINES', 'Добавьте хотя бы одну строку');
    await this.products(s, lines.map((l) => l.productId));
    let payload: SnapshotPayload;
    let source: Record<string, unknown>;
    if (b?.snapshotId) {
      const snap = await this.prisma.pricingSnapshot.findFirst({ where: { id: b.snapshotId, organizationId: s.organizationId } });
      if (!snap) throw new NotFoundException('Снимок не найден');
      if (date < iso(snap.validFrom) || date > iso(snap.horizonTo)) throw bad('SNAPSHOT_RANGE', `Снимок версии ${snap.version} покрывает ${iso(snap.validFrom)} — ${iso(snap.horizonTo)}`);
      payload = snap.payload as any;
      source = { snapshotId: snap.id, version: snap.version, hash: snap.hash };
    } else {
      payload = await this.compile(s, storeId, at, at);
      source = { live: true };
    }
    try {
      return { ...evaluate(payload, { date, storeId, lines }), source };
    } catch (e) { return engineError(e); }
  }

  /**
   * Публикация снимка для кассы (офлайн): правила на [сегодня, сегодня + horizonDays]. Снимок неизменяем; если правила
   * не изменились и горизонт не длиннее — возвращается прежняя версия (касса не перекачивает одно и то же).
   */
  async publishSnapshot(s: Scope, b: { storeId?: string | null; horizonDays?: number; from?: string }) {
    const storeId = b?.storeId ?? null;
    if (storeId) await this.stores(s, [storeId]);
    const horizon = Number(b?.horizonDays ?? 7);
    if (!Number.isInteger(horizon) || horizon < 0 || horizon > HORIZON_MAX) throw bad('HORIZON', `Горизонт — от 0 до ${HORIZON_MAX} дней`);
    const from = day(b?.from ?? kzToday(), 'Начало');
    const to = new Date(from.getTime() + horizon * 86400000);
    const storeKey = storeId ?? '*';
    for (let attempt = 0; attempt < 3; attempt++) {
      const payload = await this.compile(s, storeId, from, to);
      const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
      const last = await this.prisma.pricingSnapshot.findFirst({ where: { organizationId: s.organizationId, storeKey }, orderBy: { version: 'desc' } });
      if (last && last.hash === hash && iso(last.validFrom) <= iso(from) && iso(last.horizonTo) >= iso(to)) return { ...this.brief(last), unchanged: true };
      try {
        const snap = await this.prisma.pricingSnapshot.create({ data: {
          tenantId: s.tenantId, organizationId: s.organizationId, storeKey, version: (last?.version ?? 0) + 1, validFrom: from, horizonTo: to,
          engineVersion: ENGINE_VERSION, payload: payload as any, hash, createdBy: s.userId,
        } });
        await this.audit(s, 'PRICING_SNAPSHOT_PUBLISHED', 'pricing_snapshot', snap.id, { storeKey, version: snap.version, hash, lists: payload.priceLists.length, discounts: payload.discounts.length });
        return { ...this.brief(snap), unchanged: false };
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') continue; // параллельная публикация — пересчитать
        throw e;
      }
    }
    throw new ConflictException({ code: 'SNAPSHOT_RACE', message: 'Снимок публикуется параллельно — повторите' });
  }

  private brief(x: { id: string; storeKey: string; version: number; validFrom: Date; horizonTo: Date; hash: string; engineVersion: number; createdAt: Date }) {
    return { id: x.id, storeKey: x.storeKey, version: x.version, validFrom: iso(x.validFrom), horizonTo: iso(x.horizonTo), hash: x.hash, engineVersion: x.engineVersion, createdAt: x.createdAt };
  }

  async listSnapshots(s: Scope) {
    const rows = await this.prisma.pricingSnapshot.findMany({ where: { organizationId: s.organizationId }, orderBy: [{ storeKey: 'asc' }, { version: 'desc' }], take: 100, select: { id: true, storeKey: true, version: true, validFrom: true, horizonTo: true, hash: true, engineVersion: true, createdAt: true } });
    return rows.map((r) => this.brief(r));
  }

  /**
   * Снимок для кассы: последняя версия магазина (или общая). sinceVersion — версия у кассы: если новее нет, тело не
   * отдаётся (только заголовок), чтобы касса не перекачивала то же самое.
   */
  async latestSnapshot(s: Scope, storeId?: string, sinceVersion?: string) {
    if (storeId) await this.stores(s, [storeId]);
    const keys = storeId ? [storeId, '*'] : ['*'];
    for (const storeKey of keys) {
      const snap = await this.prisma.pricingSnapshot.findFirst({ where: { organizationId: s.organizationId, storeKey }, orderBy: { version: 'desc' } });
      if (!snap) continue;
      const since = sinceVersion ? Number(sinceVersion) : NaN;
      if (Number.isInteger(since) && since >= snap.version) return { ...this.brief(snap), notModified: true };
      return { ...this.brief(snap), payload: snap.payload };
    }
    throw new NotFoundException({ code: 'SNAPSHOT_NONE', message: 'Снимок цен ещё не опубликован' });
  }
}
