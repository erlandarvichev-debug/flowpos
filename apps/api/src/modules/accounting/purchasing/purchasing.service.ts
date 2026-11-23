// FP-035: потребность → заказ поставщику → приёмка. Потребность — по правилам пополнения склада (точка заказа и
// уровень пополнения) с учётом свободного остатка (факт − резервы) и того, что уже заказано у поставщиков и не принято.
// Бюджет закупок на месяц: заказы сверх него проводятся только после согласования (встроенное правило в FP-029).
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AccError } from '../common/acc-error';
import { OrgContext } from '../access/org-context';
import { TradeDocumentsService } from '../autopilot/trade-documents.service';
import { budgetUsage, periodOf } from './budget';

type Tx = Prisma.TransactionClient | PrismaService;
type Dec = Prisma.Decimal;
const D = Prisma.Decimal;
const qty = (v: unknown, what: string) => {
  let d: Dec;
  try { d = new D(String(v)); } catch { throw new AccError('BAD_QTY', `${what}: число`); }
  if (!d.isFinite() || d.isNegative()) throw new AccError('BAD_QTY', `${what}: не меньше нуля`);
  return d.toDecimalPlaces(3);
};
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;

@Injectable()
export class PurchasingService {
  constructor(private prisma: PrismaService, private trade: TradeDocumentsService) {}

  // ── Правила пополнения ──

  rules(ctx: OrgContext, q: { storeId?: string }) {
    return this.prisma.replenishmentRule.findMany({
      where: { organizationId: ctx.organizationId, ...(q.storeId ? { storeId: q.storeId } : {}) },
      include: { product: { select: { id: true, name: true, code: true } }, store: { select: { id: true, name: true } } },
      orderBy: [{ storeId: 'asc' }, { product: { name: 'asc' } }],
    });
  }

  /** Создать или изменить правило (склад + товар): min ≤ max, поставщик — контрагент своей организации. */
  async setRule(ctx: OrgContext, b: { storeId?: string; productId?: string; minQty?: unknown; maxQty?: unknown; supplierId?: string | null }) {
    const store = b.storeId ? await this.prisma.store.findFirst({ where: { id: b.storeId, organizationId: ctx.organizationId, isTransit: false } }) : null;
    if (!store) throw new AccError('REF_FOREIGN', 'Склад не найден в этой организации');
    const product = b.productId ? await this.prisma.product.findFirst({ where: { id: b.productId, tenantId: ctx.tenantId, OR: [{ organizationId: null }, { organizationId: ctx.organizationId }] } }) : null;
    if (!product || product.kind === 'SERVICE') throw new AccError('REF_FOREIGN', 'Товар не найден (услуги не пополняются)');
    const min = qty(b.minQty, 'Точка заказа'), max = qty(b.maxQty, 'Уровень пополнения');
    if (max.lt(min) || max.isZero()) throw new AccError('RULE_RANGE', 'Уровень пополнения должен быть больше нуля и не меньше точки заказа');
    if (b.supplierId) {
      const c = await this.prisma.counterparty.findFirst({ where: { id: b.supplierId, tenantId: ctx.tenantId, OR: [{ organizationId: null }, { organizationId: ctx.organizationId }] } });
      if (!c) throw new AccError('REF_FOREIGN', 'Поставщик не найден в этой организации');
    }
    const data = { minQty: min, maxQty: max, supplierId: b.supplierId || null, updatedBy: ctx.userId };
    return this.prisma.replenishmentRule.upsert({
      where: { storeId_productId: { storeId: store.id, productId: product.id } },
      create: { ...data, organizationId: ctx.organizationId, storeId: store.id, productId: product.id },
      update: data,
    });
  }

  async deleteRule(ctx: OrgContext, id: string) {
    const r = await this.prisma.replenishmentRule.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!r) throw new AccError('NOT_FOUND', 'Правило не найдено', { status: 404 });
    await this.prisma.replenishmentRule.delete({ where: { id } });
    return { ok: true };
  }

  // ── Потребность ──

  /**
   * Потребность склада: по каждому правилу — свободно (факт − резервы), в заказах (проведённые незакрытые заказы
   * поставщикам: заказано − принято), к заказу = уровень пополнения − (свободно + в заказах), если сумма ниже точки
   * заказа. Последняя цена прихода — для оценки.
   */
  async needs(ctx: OrgContext, q: { storeId?: string; all?: string }) {
    const rules = await this.rules(ctx, q);
    if (!rules.length) return { items: [] };
    const onOrder = await this.onOrder(ctx, [...new Set(rules.map((r) => r.storeId))]);
    const items: any[] = [];
    for (const r of rules) {
      const [st] = await this.prisma.$queryRaw<{ q: string; r: string }[]>`
        SELECT coalesce(sum(qty), 0)::text AS q, coalesce(sum(reserved), 0)::text AS r FROM stock WHERE product_id = ${r.productId} AND store_id = ${r.storeId}`;
      const free = new D(st.q).minus(st.r);
      const ordered = onOrder.get(`${r.storeId}|${r.productId}`) ?? new D(0);
      const position = free.plus(ordered);
      const need = position.lt(r.minQty) ? D.max(new D(r.maxQty).minus(position), 0) : new D(0);
      if (need.isZero() && q.all !== '1') continue;
      const price = await this.lastPrice(r.productId, r.supplierId);
      items.push({
        ruleId: r.id, store: r.store, product: r.product, supplierId: r.supplierId,
        minQty: r.minQty.toString(), maxQty: r.maxQty.toString(), stock: new D(st.q).toString(), reserved: new D(st.r).toString(),
        free: free.toString(), onOrder: ordered.toString(), need: need.toString(), price: price?.toFixed(2) ?? null,
        amount: price ? price.times(need).toDecimalPlaces(2).toFixed(2) : null,
      });
    }
    return { items };
  }

  /**
   * Ожидается от поставщиков: проведённые незакрытые заказы поставщикам минус принятое по ним. Ключ — «склад|товар».
   * storeIds не указан — по всем складам организации.
   */
  async onOrder(ctx: OrgContext, storeIds?: string[]) {
    const orders = await this.prisma.document.findMany({
      where: { organizationId: ctx.organizationId, docType: 'PURCHASE_ORDER', status: 'POSTED', deleted: false, ...(storeIds ? { storeId: { in: storeIds } } : {}) },
      include: { lines: true },
    });
    const open = orders.filter((o) => !(o.attributes as any)?.closed);
    const supplies = open.length ? await this.prisma.document.findMany({
      where: { docType: 'SUPPLY', status: 'POSTED', deleted: false, OR: open.map((o) => ({ attributes: { path: ['baseId'], equals: o.id } })) },
      include: { lines: true },
    }) : [];
    const res = new Map<string, Dec>();
    for (const o of open) {
      const got = new Map<string, Dec>();
      for (const s of supplies.filter((x) => (x.attributes as any)?.baseId === o.id)) for (const l of s.lines) got.set(l.productId, (got.get(l.productId) ?? new D(0)).plus(l.qty));
      for (const l of o.lines) {
        const left = D.max(new D(l.qty).minus(got.get(l.productId) ?? 0), 0);
        got.set(l.productId, D.max((got.get(l.productId) ?? new D(0)).minus(l.qty), 0));
        const k = `${o.storeId}|${l.productId}`;
        res.set(k, (res.get(k) ?? new D(0)).plus(left));
      }
    }
    return res;
  }

  /**
   * Остатки: по товару и складу — факт, резерв, свободно, ожидается (заказы поставщикам), точка заказа и уровень
   * пополнения из правил. Поиск — название, код, артикул, штрихкод. Без стоимости (она в отчёте «Остатки и себестоимость»).
   */
  async balance(ctx: OrgContext, q: { storeId?: string; search?: string; filter?: string; sort?: string; page?: string | number; limit?: string | number }) {
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
    const page = Math.max(Number(q.page) || 1, 1);
    const search = String(q.search ?? '').trim();
    const like = `%${search.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
    const conds: Prisma.Sql[] = [];
    if (search) {
      conds.push(Prisma.sql`(p.name ILIKE ${like} OR p.code ILIKE ${like} OR p.article ILIKE ${like}
        OR EXISTS (SELECT 1 FROM product_barcodes pb WHERE pb.product_id = p.id AND pb.barcode = ${search}))`);
    }
    if (q.filter === 'below') conds.push(Prisma.sql`rr.min_qty IS NOT NULL AND (b.q - b.r) < rr.min_qty`);
    else if (q.filter === 'negative') conds.push(Prisma.sql`b.q < 0`);
    else if (q.filter === 'reserved') conds.push(Prisma.sql`b.r > 0`);
    else if (q.filter !== 'all') conds.push(Prisma.sql`(b.q <> 0 OR b.r <> 0)`);
    const where = conds.length ? Prisma.sql`WHERE ${Prisma.join(conds, ' AND ')}` : Prisma.empty;
    const order = q.sort === 'qty_desc' ? Prisma.sql`b.q DESC, p.name` : q.sort === 'qty_asc' ? Prisma.sql`b.q ASC, p.name`
      : q.sort === 'store' ? Prisma.sql`st.name, p.name` : Prisma.sql`p.name, st.name`;
    const store = q.storeId ? Prisma.sql`AND s.store_id = ${q.storeId}` : Prisma.empty;
    const rows = await this.prisma.$queryRaw<any[]>`
      WITH b AS (
        SELECT s.product_id, s.store_id, sum(s.qty) AS q, sum(s.reserved) AS r
        FROM stock s JOIN stores st ON st.id = s.store_id
        WHERE st.organization_id = ${ctx.organizationId} AND st.deleted = false ${store}
        GROUP BY s.product_id, s.store_id
      )
      SELECT b.product_id, b.store_id, b.q::text AS qty, b.r::text AS reserved, (b.q - b.r)::text AS free,
             p.code, p.article, p.name, u.short_name AS uom, st.name AS store_name, st.is_transit,
             rr.min_qty::text AS min_qty, rr.max_qty::text AS max_qty, count(*) OVER () AS total
      FROM b JOIN products p ON p.id = b.product_id JOIN stores st ON st.id = b.store_id
      LEFT JOIN uoms u ON u.id = p.uom_id
      LEFT JOIN replenishment_rules rr ON rr.store_id = b.store_id AND rr.product_id = b.product_id
      ${where}
      ORDER BY ${order}
      LIMIT ${limit} OFFSET ${(page - 1) * limit}`;
    const [below] = await this.prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM replenishment_rules rr
      JOIN stores st ON st.id = rr.store_id AND st.organization_id = ${ctx.organizationId} AND st.deleted = false
      WHERE (SELECT coalesce(sum(s.qty - s.reserved), 0) FROM stock s WHERE s.product_id = rr.product_id AND s.store_id = rr.store_id) < rr.min_qty`;
    const ord = rows.length ? await this.onOrder(ctx) : new Map<string, Dec>();
    return {
      items: rows.map((r) => ({
        productId: r.product_id, storeId: r.store_id, code: r.code, article: r.article, name: r.name, uom: r.uom,
        store: r.store_name, inTransit: r.is_transit, qty: r.qty, reserved: r.reserved, free: r.free,
        onOrder: (ord.get(`${r.store_id}|${r.product_id}`) ?? new D(0)).toString(), minQty: r.min_qty, maxQty: r.max_qty,
        below: r.min_qty !== null && new D(r.free).lt(r.min_qty),
      })),
      total: rows.length ? Number(rows[0].total) : 0, page, limit, belowMin: Number(below?.n ?? 0),
    };
  }

  /** Последняя цена поступления товара: от этого поставщика, иначе от любого. */
  private async lastPrice(productId: string, supplierId: string | null) {
    const find = (cp?: string) => this.prisma.documentLine.findFirst({
      where: { productId, price: { not: null }, document: { docType: 'SUPPLY', status: 'POSTED', deleted: false, ...(cp ? { counterpartyId: cp } : {}) } },
      orderBy: { document: { date: 'desc' } }, select: { price: true },
    });
    return ((supplierId ? await find(supplierId) : null) ?? (await find()))?.price ?? null;
  }

  /**
   * Заказы поставщикам по потребности: строки группируются по поставщику (из запроса или правила); на каждого — черновик
   * заказа поставщику по последним ценам. Без поставщика — нельзя.
   */
  async createOrders(ctx: OrgContext, b: { storeId?: string; date?: string; lines?: { productId: string; qty: unknown; supplierId?: string | null; price?: unknown }[] }) {
    if (!b.storeId) throw new AccError('STORE_REQUIRED', 'Укажите склад');
    const lines = (b.lines ?? []).filter((l) => new D(String(l.qty ?? 0)).gt(0));
    if (!lines.length) throw new AccError('NO_LINES', 'Выберите строки потребности');
    const rules = await this.rules(ctx, { storeId: b.storeId });
    const groups = new Map<string, any[]>();
    for (const [i, l] of lines.entries()) {
      const supplierId = l.supplierId || rules.find((r) => r.productId === l.productId)?.supplierId;
      if (!supplierId) throw new AccError('SUPPLIER_REQUIRED', `Строка ${i + 1}: укажите поставщика (в строке или в правиле пополнения)`);
      const price = l.price !== undefined && l.price !== null && l.price !== '' ? String(l.price) : (await this.lastPrice(l.productId, supplierId))?.toString();
      groups.set(supplierId, [...(groups.get(supplierId) ?? []), { productId: l.productId, qty: String(l.qty), ...(price ? { price } : {}) }]);
    }
    const date = b.date ?? new Date().toISOString().slice(0, 10);
    const created: any[] = [];
    for (const [supplierId, ls] of groups) {
      created.push(await this.trade.create(ctx, { docType: 'PURCHASE_ORDER', date, counterpartyId: supplierId, storeId: b.storeId, lines: ls, comment: 'По потребности (правила пополнения)' }));
    }
    return created.map((d) => ({ id: d.id, number: d.number, counterpartyId: d.counterpartyId, total: d.total }));
  }

  // ── Бюджет закупок ──

  budgets(ctx: OrgContext) {
    return this.prisma.purchaseBudget.findMany({ where: { organizationId: ctx.organizationId }, orderBy: { period: 'desc' } });
  }

  async setBudget(ctx: OrgContext, b: { period?: string; amount?: unknown; note?: string }) {
    const period = String(b.period ?? '');
    if (!PERIOD.test(period)) throw new AccError('BAD_PERIOD', 'Период — ГГГГ-ММ');
    let amount: Dec;
    try { amount = new D(String(b.amount)); } catch { throw new AccError('BAD_AMOUNT', 'Сумма бюджета — число'); }
    if (!amount.isFinite() || amount.isNegative()) throw new AccError('BAD_AMOUNT', 'Сумма бюджета — не меньше нуля');
    const row = await this.prisma.purchaseBudget.upsert({
      where: { organizationId_period: { organizationId: ctx.organizationId, period } },
      create: { organizationId: ctx.organizationId, period, amount: amount.toDecimalPlaces(2), note: b.note ?? null, updatedBy: ctx.userId },
      update: { amount: amount.toDecimalPlaces(2), note: b.note ?? null, updatedBy: ctx.userId },
    });
    await this.prisma.auditLog.create({ data: { userId: ctx.userId, organizationId: ctx.organizationId, action: 'PURCHASE_BUDGET_SET', entity: 'purchase_budget', entityId: row.id, after: { period, amount: amount.toFixed(2) } } });
    return row;
  }

  /** Бюджет для заказа поставщику: месяц заказа, бюджет, уже заказано (без этого заказа), этот заказ, остаток. */
  async budgetFor(ctx: OrgContext, docId: string) {
    const doc = await this.prisma.document.findFirst({ where: { id: docId, organizationId: ctx.organizationId, docType: 'PURCHASE_ORDER' } });
    if (!doc) throw new AccError('DOC_NOT_FOUND', 'Заказ поставщику не найден', { status: 404 });
    const u = await budgetUsage(this.prisma, ctx.organizationId, doc.date, doc.id);
    if (!u) return { period: periodOf(doc.date), budget: null };
    const amount = new D(doc.total ?? 0);
    return { period: u.period, budget: u.budget.toFixed(2), committed: u.committed.toFixed(2), amount: amount.toFixed(2), left: u.left.toFixed(2), overBudget: u.committed.plus(amount).gt(u.budget) };
  }
}
