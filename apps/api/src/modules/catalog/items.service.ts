import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { Scope, scopeError, tenantCatalog, writable } from '../../common/scope';
import { normalizeBarcode, validateBarcode, validatePlu } from './barcode';
import { catalogError, weightSettings } from './barcodes.service';

/** Поля товара, которые задаёт пользователь. Идентификаторы обмена (1С/МойСклад), статус обмена, архив — нет (FP-025). */
const EDITABLE = ['kind', 'code', 'article', 'name', 'groupId', 'uomId', 'vatRate', 'parentId', 'attributes', 'plu', 'lotTracking', 'expiryTracking'] as const;
const KINDS = ['PRODUCT', 'SERVICE', 'BUNDLE', 'VARIANT'];

/** Характеристики варианта в каноническом виде: ключи по алфавиту, пробелы и регистр ключа нормализованы. */
export function variantKey(attributes: unknown): string | null {
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) return null;
  const pairs = Object.entries(attributes as Record<string, unknown>)
    .map(([k, v]) => [k.trim().toLowerCase(), String(v ?? '').trim().replace(/\s+/g, ' ')] as const)
    .filter(([k, v]) => k && v)
    .sort(([a], [b]) => a.localeCompare(b));
  return pairs.length ? pairs.map(([k, v]) => `${k}=${v}`).join('|') : null;
}

/** Номенклатура: справочник клиента — общий для его организаций или личный для одной (FP-007). */
@Injectable()
export class ItemsService {
  constructor(private prisma: PrismaService) {}

  async findAll(s: Scope, query: { search?: string; groupId?: string; parentId?: string; kind?: string; archived?: string; sort?: string; page?: number; limit?: number }) {
    const page = Math.max(Number(query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 200); // без потолка можно было запросить всю номенклатуру разом
    const skip = (page - 1) * limit;

    // archived=1 — архив (помеченные), иначе — действующие.
    const where: any = { ...tenantCatalog(s), deleted: query.archived === '1' };
    if (query.kind && ['PRODUCT', 'SERVICE', 'BUNDLE'].includes(query.kind)) where.kind = query.kind;
    if (query.search) {
      const code = normalizeBarcode(query.search);
      where.AND = [{ OR: [
        { name: { contains: query.search, mode: 'insensitive' } },
        { code: { contains: query.search, mode: 'insensitive' } },
        { article: { contains: query.search, mode: 'insensitive' } },
        ...(code ? [{ barcodes: { some: { barcode: code } } }, { plu: code }] : []),
      ] }];
    }
    if (query.groupId) where.groupId = query.groupId;
    if (query.parentId) where.parentId = query.parentId;

    const [items, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        skip,
        take: limit,
        include: { uom: true, group: true, barcodes: true, prices: { include: { priceType: true } }, _count: { select: { variants: { where: { deleted: false } } } } },
        orderBy: this.itemsOrder(query.sort),
      }),
      this.prisma.product.count({ where }),
    ]);
    // Остаток по складам своей организации — для колонки «Остаток» списка.
    const stock = items.length ? await this.prisma.stock.groupBy({ by: ['productId'], where: { productId: { in: items.map((i) => i.id) }, store: { organizationId: s.organizationId, deleted: false } }, _sum: { qty: true, reserved: true } }) : [];
    const st = new Map(stock.map((r) => [r.productId, r._sum]));
    return { items: items.map((i) => ({ ...i, stockQty: st.get(i.id)?.qty?.toString() ?? null, stockReserved: st.get(i.id)?.reserved?.toString() ?? null })), total, page, limit, pages: Math.ceil(total / limit) };
  }

  async findOne(s: Scope, id: string) {
    const item = await this.prisma.product.findFirst({
      where: { id, ...tenantCatalog(s) },
      include: {
        uom: true,
        group: true,
        barcodes: { include: { uom: true }, orderBy: { createdAt: 'asc' } },
        prices: { include: { priceType: true } },
        parent: { select: { id: true, name: true } },
        variants: { where: { deleted: false, ...tenantCatalog(s) }, select: { id: true, name: true, attributes: true, variantKey: true, code: true }, orderBy: { name: 'asc' } },
      },
    });
    if (!item) throw new NotFoundException('Товар не найден');
    return item;
  }

  /** Только разрешённые поля; проверка вида, варианта и PLU. */
  private async clean(s: Scope, body: any, current?: { id: string; parentId: string | null; kind: string }) {
    const { data } = writable(body, s);
    const out: Record<string, any> = {};
    for (const k of EDITABLE) if (k in (data as any)) out[k] = (data as any)[k];
    if ('name' in out && !String(out.name ?? '').trim()) throw new BadRequestException({ code: 'NAME_REQUIRED', message: 'Укажите наименование' });
    if ('kind' in out && !KINDS.includes(out.kind)) throw new BadRequestException({ code: 'KIND', message: `Вид: ${KINDS.join(', ')}` });
    for (const k of ['code', 'article', 'groupId', 'parentId', 'plu'] as const) if (k in out && (out[k] === '' || out[k] === undefined)) out[k] = null;
    if ('vatRate' in out && out.vatRate !== null) {
      const v = Number(out.vatRate);
      if (!Number.isFinite(v) || v < 0 || v > 100) throw new BadRequestException({ code: 'VAT_RATE', message: 'Ставка НДС — от 0 до 100' });
    }

    // FP-033: партионный учёт; срок годности ведётся только по партиям.
    for (const k of ['lotTracking', 'expiryTracking'] as const) if (k in out) out[k] = out[k] === true || out[k] === 'true';
    if (out.expiryTracking) out.lotTracking = true;
    if (out.lotTracking === false && current) out.expiryTracking = false;

    if ('plu' in out && out.plu !== null) {
      const { pluLength } = await weightSettings(this.prisma, s.tenantId);
      try { out.plu = validatePlu(out.plu, pluLength); } catch (e) { catalogError(e); }
    }

    // Вариант: родитель — товар клиента, не архивный и сам не вариант (без вложенности); вид — VARIANT.
    const parentId = 'parentId' in out ? out.parentId : current?.parentId ?? null;
    if (parentId) {
      if (current && parentId === current.id) throw new BadRequestException({ code: 'VARIANT_PARENT', message: 'Товар не может быть вариантом самого себя' });
      const parent = await this.prisma.product.findFirst({ where: { id: parentId, ...tenantCatalog(s) }, select: { parentId: true, deleted: true, kind: true } });
      if (!parent || parent.deleted) throw new BadRequestException({ code: 'VARIANT_PARENT', message: 'Основной товар для варианта не найден' });
      if (parent.parentId || parent.kind === 'VARIANT') throw new BadRequestException({ code: 'VARIANT_NESTED', message: 'Вариант не может быть основным товаром для другого варианта' });
      if (current && (await this.prisma.product.count({ where: { parentId: current.id, deleted: false } }))) {
        throw new BadRequestException({ code: 'VARIANT_NESTED', message: 'У товара есть свои варианты — сделать его вариантом нельзя' });
      }
      if ('parentId' in out && (await this.prisma.productBarcode.count({ where: { productId: parentId } }))) {
        throw new BadRequestException({ code: 'VARIANT_PARENT_BARCODE', message: 'У основного товара есть штрихкоды — перенесите их на варианты: по коду родителя нельзя понять, какой вариант продан' });
      }
      out.kind = 'VARIANT';
      if ('attributes' in out || 'parentId' in out) {
        out.variantKey = variantKey('attributes' in out ? out.attributes : undefined);
        if (!out.variantKey) throw new BadRequestException({ code: 'VARIANT_ATTRIBUTES', message: 'У варианта должны быть характеристики (например, размер или цвет)' });
      }
    } else if ('parentId' in out) {
      out.variantKey = null;
      if (out.kind === 'VARIANT' || (!('kind' in out) && current?.kind === 'VARIANT')) out.kind = 'PRODUCT';
    } else if (out.kind === 'VARIANT') {
      throw new BadRequestException({ code: 'VARIANT_PARENT', message: 'Для варианта укажите основной товар' });
    }
    out.updatedBy = s.userId;
    return out;
  }

  private uniqueError(e: unknown): never {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      const t = String((e.meta as any)?.target ?? '');
      if (t.includes('plu')) throw new ConflictException({ code: 'PLU_TAKEN', message: 'Этот код весового товара (PLU) уже у другого товара' });
      if (t.includes('variant_key')) throw new ConflictException({ code: 'VARIANT_DUPLICATE', message: 'Вариант с такими характеристиками у этого товара уже есть' });
      if (t.includes('barcode')) throw new ConflictException({ code: 'BARCODE_TAKEN', message: 'Один из штрихкодов уже у другого товара клиента' });
    }
    return scopeError(e);
  }

  async create(s: Scope, body: any) {
    const { private: own } = writable(body, s, { privateAllowed: true });
    const data = await this.clean(s, body);
    if (!data.name || !data.uomId) throw new BadRequestException({ code: 'REQUIRED', message: 'Укажите наименование и единицу измерения' });
    const barcodes = Array.isArray(body?.barcodes) ? body.barcodes.map((b: any) => {
      try { return { ...validateBarcode(b?.barcode ?? b, b?.kind), source: 'MANUAL' }; } catch (e) { return catalogError(e); }
    }) : [];
    return this.prisma.product.create({
      data: {
        ...(data as any),
        tenantId: s.tenantId,
        organizationId: own ? s.organizationId : null,
        barcodes: barcodes.length ? { create: barcodes } : undefined,
      },
      include: { uom: true, group: true, barcodes: true },
    }).catch((e) => this.uniqueError(e));
  }

  async update(s: Scope, id: string, body: any) {
    const cur = await this.findOne(s, id);
    const data = await this.clean(s, body, { id, parentId: cur.parentId, kind: cur.kind });
    return this.prisma.product.update({
      where: { id },
      data,
      include: { uom: true, group: true, barcodes: true },
    }).catch((e) => this.uniqueError(e));
  }

  private itemsOrder(sort?: string): any {
    const [f, d0] = String(sort || 'name_asc').split('_');
    const d = d0 === 'desc' ? 'desc' : 'asc';
    if (f === 'code') return [{ code: { sort: d, nulls: 'last' } }, { name: 'asc' }];
    if (f === 'updated') return [{ updatedAt: d }];
    return [{ name: d }];
  }

  /** Вернуть из архива. */
  async restore(s: Scope, id: string) {
    await this.findOne(s, id);
    return this.prisma.product.update({ where: { id }, data: { deleted: false, updatedBy: s.userId } });
  }

  /**
   * Массовые действия над выбранными товарами: в архив, из архива, в группу, ставка НДС. Только товары своего клиента
   * (общие и своей организации); история изменений пишется триггером по каждой строке.
   */
  async bulk(s: Scope, body: { ids?: string[]; action?: string; groupId?: string | null; vatRate?: number | string | null }) {
    const ids = [...new Set((body?.ids ?? []).map(String))].slice(0, 1000);
    if (!ids.length) throw new BadRequestException('Выберите товары');
    const where = { id: { in: ids }, ...tenantCatalog(s) };
    let data: any;
    if (body.action === 'archive') data = { deleted: true };
    else if (body.action === 'restore') data = { deleted: false };
    else if (body.action === 'group') {
      if (body.groupId) {
        const g = await this.prisma.productGroup.findFirst({ where: { id: body.groupId, tenantId: s.tenantId } });
        if (!g) throw new BadRequestException('Группа не найдена');
      }
      data = { groupId: body.groupId || null };
    } else if (body.action === 'vat') {
      const v = body.vatRate === null || body.vatRate === '' || body.vatRate === undefined ? null : Number(body.vatRate);
      if (v !== null && (!Number.isFinite(v) || v < 0 || v > 100)) throw new BadRequestException('Ставка НДС — от 0 до 100');
      data = { vatRate: v };
    } else throw new BadRequestException('Неизвестное действие');
    const r = await this.prisma.product.updateMany({ where, data: { ...data, updatedBy: s.userId } });
    return { updated: r.count };
  }

  async archive(s: Scope, id: string) {
    await this.findOne(s, id);
    return this.prisma.product.update({ where: { id }, data: { deleted: true, updatedBy: s.userId } });
  }

  /** История значимых изменений товара (кто, когда, что) — FP-025. */
  async versions(s: Scope, id: string) {
    await this.findOne(s, id);
    return this.prisma.productVersion.findMany({ where: { productId: id, tenantId: s.tenantId }, orderBy: { version: 'desc' }, take: 200 });
  }

  /** Связи с внешними системами (активные и прежние) — FP-025. */
  async mappings(s: Scope, id: string) {
    await this.findOne(s, id);
    return this.prisma.externalMapping.findMany({ where: { tenantId: s.tenantId, entityType: 'product', entityId: id }, orderBy: [{ status: 'asc' }, { firstSeenAt: 'desc' }] });
  }

  /** Остатки товара — только по складам своей организации. */
  async getStock(s: Scope, id: string) {
    await this.findOne(s, id);
    return this.prisma.stock.findMany({
      where: { productId: id, store: { organizationId: s.organizationId } },
      include: { store: true },
    });
  }

  async findGroups(s: Scope) {
    return this.prisma.productGroup.findMany({ where: { tenantId: s.tenantId }, orderBy: { name: 'asc' } });
  }

  async findUnits(s: Scope) {
    return this.prisma.uom.findMany({ where: { tenantId: s.tenantId }, orderBy: { name: 'asc' } });
  }
}
