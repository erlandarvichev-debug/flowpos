// FP-025: штрихкоды товара (уникальны у клиента, упаковки с коэффициентом), весовые штрихкоды и поиск товара по коду.
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { Scope, tenantCatalog } from '../../common/scope';
import { BarcodeError, WeightBarcodeSettings, normalizeBarcode, parseWeightBarcode, validateBarcode, validateWeightSettings } from './barcode';

type Db = Prisma.TransactionClient | PrismaService;

export const catalogError = (e: unknown): never => {
  if (e instanceof BarcodeError) throw new BadRequestException({ code: e.code, message: e.message });
  throw e;
};

export async function weightSettings(db: Db, tenantId: string): Promise<WeightBarcodeSettings> {
  const s = await db.catalogSettings.findUnique({ where: { tenantId } });
  return { prefixes: s?.weightPrefixes ?? [], pluLength: s?.weightPluLength ?? 5 };
}

export interface ResolvedBarcode {
  productId: string;
  name: string;
  source: 'BARCODE' | 'WEIGHT';
  barcode: string;
  /** Базовых единиц в одной отсканированной (упаковка) — для штучного 1. */
  factor: string;
  /** Весовой штрихкод: вес в кг из этикетки — он и есть количество. */
  weightKg?: string;
}

/**
 * Товар по отсканированному коду — только среди видимых организации (общий справочник клиента + свой) и не в архиве.
 * Сначала точный штрихкод (в т.ч. упаковки), затем весовой по настройкам клиента. Родитель с вариантами по коду
 * не продаётся — нужен конкретный вариант. null — такого кода у организации нет.
 */
export async function resolveBarcode(db: Db, s: Scope, raw: unknown): Promise<ResolvedBarcode | null> {
  const code = normalizeBarcode(raw);
  if (!code) return null;
  const visible = { ...tenantCatalog(s), deleted: false };
  const b = await db.productBarcode.findFirst({ where: { tenantId: s.tenantId, barcode: code, product: visible }, include: { product: { select: { id: true, name: true } } } });
  let hit: ResolvedBarcode | null = b ? { productId: b.productId, name: b.product.name, source: 'BARCODE', barcode: code, factor: b.factor.toString() } : null;
  if (!hit) {
    const w = parseWeightBarcode(code, await weightSettings(db, s.tenantId));
    if (w) {
      const p = await db.product.findFirst({ where: { ...visible, plu: w.plu }, select: { id: true, name: true } });
      if (p) hit = { productId: p.id, name: p.name, source: 'WEIGHT', barcode: code, factor: '1', weightKg: w.kg };
    }
  }
  if (hit && (await db.product.count({ where: { parentId: hit.productId, deleted: false } }))) {
    throw new BadRequestException({ code: 'VARIANT_REQUIRED', message: `«${hit.name}» продаётся вариантами — отсканируйте штрихкод конкретного варианта` });
  }
  return hit;
}

@Injectable()
export class BarcodesService {
  constructor(private prisma: PrismaService) {}

  private async product(s: Scope, id: string) {
    const p = await this.prisma.product.findFirst({ where: { id, ...tenantCatalog(s) }, select: { id: true, name: true, organizationId: true, deleted: true } });
    if (!p) throw new NotFoundException('Товар не найден');
    return p;
  }

  /** Кто уже владеет кодом: свой видимый товар — по имени; товар другой организации клиента — без подробностей. */
  private async conflict(s: Scope, barcode: string): Promise<never> {
    const other = await this.prisma.productBarcode.findFirst({ where: { tenantId: s.tenantId, barcode }, include: { product: { select: { id: true, name: true, organizationId: true } } } });
    const mine = other && (other.product.organizationId === null || other.product.organizationId === s.organizationId);
    throw new ConflictException({
      code: 'BARCODE_TAKEN',
      message: mine ? `Штрихкод ${barcode} уже у товара «${other!.product.name}»` : `Штрихкод ${barcode} уже занят товаром другой организации клиента — перенесите товар в общий справочник`,
      details: mine ? { productId: other!.product.id } : undefined,
    });
  }

  /** Добавить штрихкод (в т.ч. упаковки: factor — сколько базовых единиц в ней). */
  async add(s: Scope, productId: string, body: { barcode?: unknown; kind?: string | null; factor?: unknown; uomId?: string | null }) {
    const p = await this.product(s, productId);
    if (p.deleted) throw new BadRequestException({ code: 'PRODUCT_ARCHIVED', message: 'Товар в архиве' });
    const { barcode, kind } = (() => { try { return validateBarcode(body.barcode, body.kind); } catch (e) { return catalogError(e); } })();
    let factor: Prisma.Decimal;
    try { factor = new Prisma.Decimal(String(body.factor ?? 1)); } catch { throw new BadRequestException({ code: 'BARCODE_FACTOR', message: 'Коэффициент упаковки — число' }); }
    if (!factor.isFinite() || factor.lte(0) || factor.decimalPlaces() > 6) throw new BadRequestException({ code: 'BARCODE_FACTOR', message: 'Коэффициент упаковки — положительное число (до 6 знаков после запятой)' });
    if (body.uomId && !(await this.prisma.uom.findFirst({ where: { id: body.uomId, tenantId: s.tenantId } }))) throw new BadRequestException({ code: 'REF_FOREIGN', message: 'Единица упаковки не найдена' });
    if (await this.prisma.product.count({ where: { parentId: productId, deleted: false } })) {
      throw new BadRequestException({ code: 'VARIANT_REQUIRED', message: 'У товара есть варианты — штрихкод задаётся конкретному варианту' });
    }
    try {
      return await this.prisma.productBarcode.create({ data: { tenantId: s.tenantId, productId, barcode, kind, factor, uomId: body.uomId || null, source: 'MANUAL' } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return this.conflict(s, barcode);
      throw e;
    }
  }

  async remove(s: Scope, productId: string, barcodeId: string) {
    await this.product(s, productId);
    const r = await this.prisma.productBarcode.deleteMany({ where: { id: barcodeId, productId, tenantId: s.tenantId } });
    if (!r.count) throw new NotFoundException('Штрихкод не найден');
    return { ok: true };
  }

  async resolve(s: Scope, code: string) {
    const r = await resolveBarcode(this.prisma, s, code);
    if (!r) throw new NotFoundException({ code: 'BARCODE_NOT_FOUND', message: `Товар со штрихкодом ${normalizeBarcode(code)} не найден` });
    return r;
  }

  /**
   * Дубли штрихкодов клиента: код из старого поля товара (обмен с 1С/МойСклад, прежние версии), который уже занят
   * другим товаром, — поэтому у этого товара на кассе не находится. Решает человек: убрать код у одного из товаров.
   * Видны дубли товаров организации (общих и своих).
   */
  async duplicates(s: Scope) {
    const rows = await this.prisma.$queryRaw<{ product_id: string; product_name: string; barcode: string; owner_id: string; owner_name: string; owner_org: string | null }[]>`
      SELECT p.id AS product_id, p.name AS product_name, b.barcode, o.id AS owner_id, o.name AS owner_name, o.organization_id AS owner_org
        FROM products p
        JOIN product_barcodes b ON b.tenant_id = p.tenant_id AND b.barcode = regexp_replace(p.barcode, '\\s', '', 'g')
        JOIN products o ON o.id = b.product_id
       WHERE p.tenant_id = ${s.tenantId} AND b.product_id <> p.id AND NOT p.deleted
         AND (p.organization_id IS NULL OR p.organization_id = ${s.organizationId})
       ORDER BY b.barcode, p.name LIMIT 500`;
    // Код занят личным товаром другой организации клиента — дубль показываем (иначе непонятно, почему код не находится),
    // но без имени и id чужого товара.
    return rows.map((r) => {
      const visible = r.owner_org === null || r.owner_org === s.organizationId;
      return { barcode: r.barcode, productId: r.product_id, productName: r.product_name, ownerId: visible ? r.owner_id : null, ownerName: visible ? r.owner_name : 'товар другой организации клиента' };
    });
  }

  async settings(s: Scope) {
    return weightSettings(this.prisma, s.tenantId);
  }

  /** Весовые штрихкоды клиента. Длину PLU нельзя сменить, пока есть товары с PLU другой длины. */
  async updateSettings(s: Scope, body: { prefixes?: unknown; pluLength?: unknown }) {
    const v = (() => { try { return validateWeightSettings(body); } catch (e) { return catalogError(e); } })();
    const rows = await this.prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM products WHERE tenant_id = ${s.tenantId} AND plu IS NOT NULL AND NOT deleted AND length(plu) <> ${v.pluLength}`;
    const bad = Number(rows[0]?.n ?? 0);
    if (bad) throw new BadRequestException({ code: 'WEIGHT_PLU_LENGTH_IN_USE', message: `У ${bad} товаров PLU другой длины — сначала измените их коды` });
    await this.prisma.catalogSettings.upsert({
      where: { tenantId: s.tenantId },
      create: { tenantId: s.tenantId, weightPrefixes: v.prefixes, weightPluLength: v.pluLength, updatedBy: s.userId },
      update: { weightPrefixes: v.prefixes, weightPluLength: v.pluLength, updatedBy: s.userId },
    });
    return v;
  }
}
