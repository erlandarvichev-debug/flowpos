import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AccError } from '../common/acc-error';
import { D } from '../common/money';
import { OrgContext } from '../access/org-context';
import { TradeDocumentsService } from '../autopilot/trade-documents.service';

type Mat = { productId: string; qty: string };
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const kzDate = (v: string) => new Date(`${v}T12:00:00+05:00`);

/**
 * Производство: техкарты (состав продукции) и выпуск. Выпуск проводит два обычных документа:
 * списание сырья «в производство» (Дт 8110 — Кт запасы, по себестоимости партий) и оприходование продукции
 * (Дт запасы — Кт 8110) на ту же сумму — себестоимость продукции = фактическая себестоимость сырья.
 */
@Injectable()
export class ProductionService {
  constructor(private prisma: PrismaService, private trade: TradeDocumentsService) {}

  // ── Техкарты ──

  private async cleanMaterials(ctx: OrgContext, list: any, productId?: string): Promise<Mat[]> {
    if (!Array.isArray(list) || !list.length) throw new AccError('MATERIALS_REQUIRED', 'Укажите сырьё и материалы');
    const out: Mat[] = [];
    for (const [i, m] of list.entries()) {
      const qty = new D(String(m?.qty ?? '0').replace(',', '.') || '0');
      if (!m?.productId || qty.lte(0)) throw new AccError('BAD_MATERIAL', `Строка ${i + 1}: выберите товар и количество больше нуля`);
      if (productId && m.productId === productId) throw new AccError('BAD_MATERIAL', 'Продукция не может быть сырьём самой себя');
      out.push({ productId: String(m.productId), qty: qty.toFixed(3) });
    }
    const ids = [...new Set([...out.map((m) => m.productId), ...(productId ? [productId] : [])])];
    const found = await this.prisma.product.count({ where: { id: { in: ids }, tenantId: ctx.tenantId, OR: [{ organizationId: null }, { organizationId: ctx.organizationId }] } });
    if (found !== ids.length) throw new AccError('REF_FOREIGN', 'Товар не найден в номенклатуре этой организации');
    return out;
  }

  async recipes(ctx: OrgContext, q: { search?: string; all?: string }) {
    const rows = await this.prisma.productionRecipe.findMany({
      where: { organizationId: ctx.organizationId, ...(q.all === '1' ? {} : { isActive: true }), ...(q.search ? { name: { contains: q.search, mode: 'insensitive' } } : {}) },
      orderBy: { name: 'asc' },
    });
    return this.withNames(rows);
  }

  async saveRecipe(ctx: OrgContext, id: string | null, b: any) {
    const name = String(b?.name ?? '').trim();
    if (name.length < 2) throw new AccError('NAME_REQUIRED', 'Укажите название техкарты');
    if (!b?.productId) throw new AccError('PRODUCT_REQUIRED', 'Выберите продукцию');
    const outputQty = new D(String(b?.outputQty ?? '1').replace(',', '.') || '1');
    if (outputQty.lte(0)) throw new AccError('BAD_QTY', 'Выход продукции — больше нуля');
    const materials = await this.cleanMaterials(ctx, b.materials, b.productId);
    const data = { name, productId: b.productId, outputQty: outputQty.toFixed(3), materials: materials as any, comment: b.comment?.trim() || null, isActive: b.isActive !== false };
    if (id) {
      const cur = await this.prisma.productionRecipe.findFirst({ where: { id, organizationId: ctx.organizationId } });
      if (!cur) throw new AccError('NOT_FOUND', 'Техкарта не найдена', { status: 404 });
      return (await this.withNames([await this.prisma.productionRecipe.update({ where: { id }, data })]))[0];
    }
    const r = await this.prisma.productionRecipe.create({ data: { ...data, tenantId: ctx.tenantId, organizationId: ctx.organizationId, createdBy: ctx.userId } });
    return (await this.withNames([r]))[0];
  }

  // ── Выпуск ──

  async orders(ctx: OrgContext, q: { status?: string; from?: string; to?: string }) {
    const rows = await this.prisma.productionOrder.findMany({
      where: {
        organizationId: ctx.organizationId, ...(q.status ? { status: q.status } : {}),
        ...(q.from || q.to ? { date: { ...(q.from && DAY.test(q.from) ? { gte: new Date(`${q.from}T00:00:00+05:00`) } : {}), ...(q.to && DAY.test(q.to) ? { lt: new Date(Date.parse(`${q.to}T00:00:00+05:00`) + 86400000) } : {}) } } : {}),
      },
      orderBy: [{ date: 'desc' }, { number: 'desc' }], take: 300,
    });
    return this.withNames(rows);
  }

  async order(ctx: OrgContext, id: string) {
    const o = await this.prisma.productionOrder.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!o) throw new AccError('NOT_FOUND', 'Выпуск не найден', { status: 404 });
    const [row] = await this.withNames([o]);
    const docs = await this.prisma.document.findMany({ where: { id: { in: [o.lossDocId, o.enterDocId].filter(Boolean) as string[] } }, select: { id: true, number: true, docType: true, status: true } });
    return { ...row, documents: docs };
  }

  /** План выпуска: продукция и количество; сырьё — по техкарте пропорционально (или своё). */
  async createOrder(ctx: OrgContext, b: any) {
    let productId = b?.productId as string | undefined;
    let materials: Mat[] | null = null;
    const qty = new D(String(b?.qty ?? '0').replace(',', '.') || '0');
    if (qty.lte(0)) throw new AccError('BAD_QTY', 'Количество продукции — больше нуля');
    if (b?.recipeId) {
      const r = await this.prisma.productionRecipe.findFirst({ where: { id: b.recipeId, organizationId: ctx.organizationId } });
      if (!r) throw new AccError('NOT_FOUND', 'Техкарта не найдена', { status: 404 });
      productId = r.productId;
      const k = qty.div(r.outputQty);
      materials = (r.materials as Mat[]).map((m) => ({ productId: m.productId, qty: new D(m.qty).times(k).toDecimalPlaces(3).toFixed(3) }));
    }
    if (b?.materials) materials = await this.cleanMaterials(ctx, b.materials, productId);
    if (!productId) throw new AccError('PRODUCT_REQUIRED', 'Выберите техкарту или продукцию');
    if (!materials?.length) throw new AccError('MATERIALS_REQUIRED', 'Укажите сырьё и материалы (или выберите техкарту)');
    const store = await this.prisma.store.findFirst({ where: { id: b?.storeId ?? '', organizationId: ctx.organizationId } });
    if (!store) throw new AccError('STORE_REQUIRED', 'Укажите склад производства (с него списывается сырьё, на него приходуется продукция)');
    const date = b?.date && DAY.test(b.date) ? b.date : new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10);
    const year = date.slice(0, 4);
    const count = await this.prisma.productionOrder.count({ where: { organizationId: ctx.organizationId, number: { startsWith: `ПР-${year}-` } } });
    const o = await this.prisma.productionOrder.create({
      data: {
        tenantId: ctx.tenantId, organizationId: ctx.organizationId, number: `ПР-${year}-${String(count + 1).padStart(6, '0')}`, date: kzDate(date),
        plannedDate: b?.plannedDate && DAY.test(b.plannedDate) ? kzDate(b.plannedDate) : null, recipeId: b?.recipeId ?? null, productId, qty: qty.toFixed(3),
        storeId: store.id, materials: materials as any, comment: b?.comment?.trim() || null, createdBy: ctx.userId,
      },
    });
    return this.order(ctx, o.id);
  }

  async updateOrder(ctx: OrgContext, id: string, b: any) {
    const o = await this.prisma.productionOrder.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!o) throw new AccError('NOT_FOUND', 'Выпуск не найден', { status: 404 });
    if (o.status !== 'PLANNED') throw new AccError('PRODUCTION_DONE', 'Выпуск уже проведён или отменён — менять нельзя', { fix: 'Отмените выпуск, затем создайте новый.' });
    const data: Prisma.ProductionOrderUpdateInput = {};
    if (b?.qty !== undefined) {
      const q = new D(String(b.qty).replace(',', '.') || '0');
      if (q.lte(0)) throw new AccError('BAD_QTY', 'Количество продукции — больше нуля');
      data.qty = q.toFixed(3);
    }
    if (b?.materials !== undefined) data.materials = (await this.cleanMaterials(ctx, b.materials, o.productId)) as any;
    if (b?.comment !== undefined) data.comment = b.comment?.trim() || null;
    if (b?.date !== undefined && DAY.test(b.date)) data.date = kzDate(b.date);
    if (b?.storeId) {
      const s = await this.prisma.store.findFirst({ where: { id: b.storeId, organizationId: ctx.organizationId } });
      if (!s) throw new AccError('REF_FOREIGN', 'Склад не найден');
      data.storeId = s.id;
    }
    await this.prisma.productionOrder.update({ where: { id }, data });
    return this.order(ctx, id);
  }

  /**
   * Выпустить: списание сырья «в производство» (8110), затем оприходование продукции по себестоимости списанного.
   * Не хватает сырья — понятная ошибка списания, ничего не проводится.
   */
  async complete(ctx: OrgContext, id: string) {
    const o = await this.prisma.productionOrder.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!o) throw new AccError('NOT_FOUND', 'Выпуск не найден', { status: 404 });
    if (o.status === 'DONE') return this.order(ctx, id);
    if (o.status !== 'PLANNED') throw new AccError('PRODUCTION_CANCELLED', 'Выпуск отменён');
    const date = new Date(o.date.getTime() + 5 * 3600e3).toISOString().slice(0, 10);
    const mats = o.materials as Mat[];
    const loss: any = await this.trade.create(ctx, {
      docType: 'LOSS', date, storeId: o.storeId, lossAccount: '8110', lossReason: 'PRODUCTION', status: 'POSTED',
      comment: `Сырьё на выпуск ${o.number}`, productionId: o.id, lines: mats.map((m) => ({ productId: m.productId, qty: m.qty })),
    } as any);
    let enter: any;
    try {
      // Себестоимость списанного сырья — из записей себестоимости документа списания (Дт 8110).
      const rows = await this.prisma.$queryRaw<{ s: string | null }[]>`
        SELECT SUM(CASE WHEN p.side = 'D' THEN p.amount ELSE -p.amount END)::text AS s
        FROM acc_postings p JOIN acc_entries e ON e.id = p.entry_id JOIN acc_accounts a ON a.id = p.account_id
        WHERE p.organization_id = ${ctx.organizationId} AND p.is_active AND p.ledger = 'BU' AND e.status = 'ACTIVE' AND a.code = '8110'
          AND e.source_type = 'COST' AND e.source_id LIKE ${`TRADE_DOCUMENT:${loss.id}:%`}`;
      const cost = new D(rows[0]?.s ?? 0);
      if (cost.lte(0)) throw new AccError('PRODUCTION_NO_COST', 'Себестоимость сырья равна нулю — проверьте приход сырья (цены поступлений)', { fix: 'Оприходуйте сырьё с ценой, затем выпустите продукцию.' });
      const qty = new D(o.qty);
      enter = await this.trade.create(ctx, {
        docType: 'ENTER', date, storeId: o.storeId, corrAccount: '8110', status: 'POSTED', comment: `Выпуск продукции ${o.number}`, productionId: o.id,
        lines: [{ productId: o.productId, qty: qty.toFixed(3), price: cost.div(qty).toDecimalPlaces(4).toString() }],
      } as any);
      // Округление цены за единицу: разницу (копейки) — в сумму строки не переносим, фиксируем фактическую сумму выпуска.
      await this.prisma.productionOrder.update({ where: { id }, data: { status: 'DONE', lossDocId: loss.id, enterDocId: enter.id, cost: cost.toFixed(2), doneAt: new Date(), doneBy: ctx.userId } });
    } catch (e) {
      // Продукцию оприходовать не вышло — списание сырья отменяем, чтобы не повисло на 8110.
      await this.trade.cancel(ctx, loss.id).catch(() => undefined);
      if (enter?.id) await this.trade.cancel(ctx, enter.id).catch(() => undefined);
      throw e;
    }
    await this.prisma.auditLog.create({ data: { userId: ctx.userId, organizationId: ctx.organizationId, action: 'PRODUCTION_DONE', entity: 'production_order', entityId: id, after: { number: o.number, qty: o.qty.toString() } } });
    return this.order(ctx, id);
  }

  /** Отменить: проведённый выпуск — отменяются оба документа (продукция, затем сырьё); план — просто отменяется. */
  async cancel(ctx: OrgContext, id: string) {
    const o = await this.prisma.productionOrder.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!o) throw new AccError('NOT_FOUND', 'Выпуск не найден', { status: 404 });
    if (o.status === 'CANCELLED') return this.order(ctx, id);
    if (o.enterDocId) await this.trade.cancel(ctx, o.enterDocId);
    if (o.lossDocId) await this.trade.cancel(ctx, o.lossDocId);
    await this.prisma.productionOrder.update({ where: { id }, data: { status: 'CANCELLED' } });
    await this.prisma.auditLog.create({ data: { userId: ctx.userId, organizationId: ctx.organizationId, action: 'PRODUCTION_CANCEL', entity: 'production_order', entityId: id } });
    return this.order(ctx, id);
  }

  /** Названия товаров и складов; для плана — хватает ли сырья на складе (по учёту). */
  private async withNames<T extends { productId: string; materials: any; storeId?: string; status?: string }>(rows: T[]) {
    const ids = [...new Set(rows.flatMap((r) => [r.productId, ...((r.materials as Mat[]) ?? []).map((m) => m.productId)]))];
    const products = ids.length ? await this.prisma.product.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, uom: { select: { shortName: true } } } }) : [];
    const storeIds = [...new Set(rows.map((r) => r.storeId).filter(Boolean))] as string[];
    const stores = storeIds.length ? await this.prisma.store.findMany({ where: { id: { in: storeIds } }, select: { id: true, name: true } }) : [];
    const nm = (id: string) => products.find((p) => p.id === id);
    return rows.map((r) => ({
      ...r,
      product: { id: r.productId, name: nm(r.productId)?.name ?? r.productId, unit: nm(r.productId)?.uom?.shortName ?? '' },
      store: r.storeId ? stores.find((s) => s.id === r.storeId) ?? null : undefined,
      materials: ((r.materials as Mat[]) ?? []).map((m) => ({ ...m, name: nm(m.productId)?.name ?? m.productId, unit: nm(m.productId)?.uom?.shortName ?? '' })),
    }));
  }
}
