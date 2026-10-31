import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { Scope, scopeError, tenantCatalog, writable } from '../../common/scope';
import { normalizeBarcode, validateBarcode, validatePlu } from './barcode';
import { catalogError, weightSettings } from './barcodes.service';

/** Поля товара, которые задаёт пользователь. Идентификаторы обмена (1С/МойСклад), статус обмена, архив — нет (FP-025). */
const EDITABLE = ['kind', 'code', 'article', 'name', 'groupId', 'uomId', 'vatRate', 'parentId', 'attributes', 'plu'] as const;
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

  async findAll(s: Scope, query: { search?: string; groupId?: string; parentId?: string; page?: number; limit?: number }) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 50;
    const skip = (page - 1) * limit;

    const where: any = { ...tenantCatalog(s), deleted: false };
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
        orderBy: { name: 'asc' },
      }),
      this.prisma.product.count({ where }),
    ]);

    return { items, total, page, limit, pages: Math.ceil(total / limit) };
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
