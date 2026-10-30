import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AccError } from '../common/acc-error';
import { D, money, round } from '../common/money';
import { OrgContext } from '../access/org-context';
import { OverrideRequest } from '../periods/periods.service';
import { AutopilotService } from './autopilot.service';
import { TRADE_SOURCE } from './trade-rules';

type Tx = Prisma.TransactionClient;

const PREFIX: Record<string, string> = {
  PURCHASE_ORDER: 'ЗП', SUPPLY: 'ПТ', PURCHASE_RETURN: 'ВП', CUSTOMER_ORDER: 'ЗК', DEMAND: 'РТ', SALES_RETURN: 'ВК',
  ENTER: 'ОПР', LOSS: 'СП', MOVE: 'ПМ', PAYMENT_IN: 'ПВ', PAYMENT_OUT: 'ИП', RETAIL_DEMAND: 'ЧЕК', RETAIL_RETURN: 'ВЧ',
};
const EDITABLE = Object.keys(PREFIX);
/** Влияние на оперативный остаток (таблица stock FlowPOS): +1 приход, −1 расход. */
const STOCK_SIGN: Record<string, number> = { SUPPLY: 1, SALES_RETURN: 1, ENTER: 1, RETAIL_RETURN: 1, DEMAND: -1, PURCHASE_RETURN: -1, LOSS: -1, RETAIL_DEMAND: -1 };
const BASE_TARGETS: Record<string, string[]> = { CUSTOMER_ORDER: ['DEMAND'], PURCHASE_ORDER: ['SUPPLY'], DEMAND: ['SALES_RETURN'], SUPPLY: ['PURCHASE_RETURN'] };

export interface TradeLineInput { productId: string; qty: string | number; price?: string | number; discount?: string | number; vatRate?: string | number | null }
export interface TradeDocInput {
  docType: string;
  date: string;
  counterpartyId?: string;
  contractId?: string;
  storeId?: string;
  storeToId?: string;
  comment?: string;
  vatIncluded?: boolean;
  paymentType?: 'CASH' | 'CARD';
  bankAccountId?: string;
  departmentId?: string;
  lossAccount?: string;
  amount?: string | number; // для платежей
  baseId?: string;
  lines?: TradeLineInput[];
  status?: 'DRAFT' | 'POSTED';
}

/**
 * Торговые документы, вводимые из бухгалтерии. Хранятся в общей таблице documents FlowPOS
 * (owner = PLATFORM), проводятся атомарно вместе с отражением в учёте и оперативным остатком.
 */
@Injectable()
export class TradeDocumentsService {
  constructor(private prisma: PrismaService, private autopilot: AutopilotService) {}

  private async number(tx: Tx, ctx: OrgContext, docType: string, date: Date) {
    const year = date.getUTCFullYear();
    const rows = await tx.$queryRaw<{ last: number }[]>`
      INSERT INTO acc_number_sequences (organization_id, doc_type, year, last) VALUES (${ctx.organizationId}, ${'T:' + docType}, ${year}, 1)
      ON CONFLICT (organization_id, doc_type, year) DO UPDATE SET last = acc_number_sequences.last + 1 RETURNING last`;
    return `${PREFIX[docType]}-${year}-${String(rows[0].last).padStart(6, '0')}`;
  }

  private async scoped(tx: Tx, ctx: OrgContext, id: string) {
    await tx.$queryRaw`SELECT id FROM documents WHERE id = ${id} FOR UPDATE`;
    const doc = await tx.document.findUnique({ where: { id }, include: { lines: { orderBy: { lineNo: 'asc' } } } });
    if (!doc) throw new AccError('DOC_NOT_FOUND', 'Документ не найден', { status: 404 });
    let org = doc.organizationId;
    if (!org && doc.storeId) org = (await tx.store.findUnique({ where: { id: doc.storeId } }))?.organizationId ?? null;
    if (org !== ctx.organizationId) throw new AccError('DOC_NOT_FOUND', 'Документ не найден', { status: 404 });
    return doc;
  }

  private async validateRefs(tx: Tx, ctx: OrgContext, input: TradeDocInput) {
    for (const [field, label] of [['storeId', 'склад'], ['storeToId', 'склад-получатель']] as const) {
      const id = input[field];
      if (id && !(await tx.store.findFirst({ where: { id, organizationId: ctx.organizationId } }))) {
        throw new AccError('REF_FOREIGN', `Указан ${label}, которого нет в этой организации`, { fix: `Выберите ${label} текущей организации.` });
      }
    }
    if (input.counterpartyId) {
      const c = await tx.counterparty.findUnique({ where: { id: input.counterpartyId } });
      if (!c || c.tenantId !== ctx.tenantId || (c.organizationId && c.organizationId !== ctx.organizationId)) throw new AccError('REF_FOREIGN', 'Контрагент не найден в этой организации');
    }
    const ids = [...new Set((input.lines || []).map((l) => l.productId))];
    if (ids.length) {
      const ps = await tx.product.findMany({ where: { id: { in: ids } } });
      const bad = ids.filter((id) => { const p = ps.find((x) => x.id === id); return !p || p.tenantId !== ctx.tenantId || (p.organizationId && p.organizationId !== ctx.organizationId); });
      if (bad.length) throw new AccError('REF_FOREIGN', 'В строках указана номенклатура, которой нет в этой организации', { details: { productIds: bad } });
    }
  }

  private buildLines(input: TradeDocInput) {
    return (input.lines || []).map((l, i) => {
      const qty = money(l.qty, 3, `количество (строка ${i + 1})`);
      if (qty.lte(0)) throw new AccError('BAD_QTY', `Строка ${i + 1}: количество должно быть больше нуля`);
      const price = l.price !== undefined && l.price !== '' ? money(l.price, 2, `цена (строка ${i + 1})`) : null;
      const discount = l.discount !== undefined && l.discount !== '' ? money(l.discount, 2, 'скидка %') : null;
      const gross = price ? price.times(qty) : new D(0);
      const amount = round(discount ? gross.minus(gross.times(discount).div(100)) : gross);
      return {
        lineNo: i + 1, productId: l.productId, qty, price, discount, amount,
        vatRate: l.vatRate !== undefined && l.vatRate !== null && l.vatRate !== '' ? new D(String(l.vatRate)) : null,
      };
    });
  }

  private attrs(input: TradeDocInput, prev: any = {}) {
    const a: any = { ...prev };
    for (const k of ['vatIncluded', 'paymentType', 'bankAccountId', 'departmentId', 'lossAccount', 'baseId', 'comment'] as const) if ((input as any)[k] !== undefined) a[k] = (input as any)[k];
    return a;
  }

  private async applyStock(tx: Tx, doc: { docType: string; storeId: string | null; storeToId: string | null; lines: { productId: string; qty: any }[] }, sign: 1 | -1) {
    const apply = async (storeId: string, productId: string, delta: Prisma.Decimal) => {
      const row = await tx.stock.findFirst({ where: { productId, storeId, binId: null } });
      if (row) await tx.stock.update({ where: { id: row.id }, data: { qty: { increment: delta } } });
      else await tx.stock.create({ data: { productId, storeId, qty: delta } });
    };
    if (doc.docType === 'MOVE') {
      for (const l of doc.lines) {
        await apply(doc.storeId!, l.productId, new D(l.qty).times(-sign));
        await apply(doc.storeToId!, l.productId, new D(l.qty).times(sign));
      }
      return;
    }
    const s = STOCK_SIGN[doc.docType];
    if (!s || !doc.storeId) return;
    for (const l of doc.lines) await apply(doc.storeId, l.productId, new D(l.qty).times(s * sign));
  }

  async create(ctx: OrgContext, input: TradeDocInput, override?: OverrideRequest) {
    if (!EDITABLE.includes(input.docType)) throw new AccError('UNKNOWN_DOC_TYPE', `Тип документа ${input.docType} не поддерживается`);
    const date = new Date(input.date);
    if (!input.date || isNaN(date.getTime())) throw new AccError('BAD_DATE', 'Укажите дату документа');
    const isPayment = input.docType.startsWith('PAYMENT_');
    if (!isPayment && !(input.lines || []).length) throw new AccError('NO_LINES', 'Добавьте хотя бы одну строку');
    return this.prisma.$transaction(async (tx) => {
      await this.validateRefs(tx, ctx, input);
      const lines = this.buildLines(input);
      const total = isPayment ? money(input.amount, 2, 'сумма платежа') : lines.reduce((a, l) => a.plus(l.amount), new D(0));
      const number = await this.number(tx, ctx, input.docType, date);
      const doc = await tx.document.create({
        data: {
          docType: input.docType as any, number, date, status: 'DRAFT', organizationId: ctx.organizationId,
          counterpartyId: input.counterpartyId, contractId: input.contractId, storeId: input.storeId, storeToId: input.storeToId,
          total, comment: input.comment, attributes: this.attrs(input), owner: 'PLATFORM', syncStatus: 'SYNCED', updatedBy: ctx.userId,
          lines: { create: lines.map((l) => ({ lineNo: l.lineNo, productId: l.productId, qty: l.qty, price: l.price, discount: l.discount, amount: l.amount, vatRate: l.vatRate })) },
        },
      });
      await tx.auditLog.create({ data: { userId: ctx.userId, organizationId: ctx.organizationId, action: 'TRADE_DOC_CREATE', entity: 'document', entityId: doc.id, after: { docType: doc.docType, number, total: total.toFixed(2) } } });
      if (input.status === 'POSTED') return this.postIn(tx, ctx, doc.id, override);
      return this.view(tx, doc.id);
    }, { timeout: 60000 });
  }

  async update(ctx: OrgContext, id: string, input: Partial<TradeDocInput> & { expectedUpdatedAt?: string; reason?: string }, override?: OverrideRequest) {
    return this.prisma.$transaction(async (tx) => {
      const doc = await this.scoped(tx, ctx, id);
      if (input.expectedUpdatedAt && new Date(input.expectedUpdatedAt).getTime() !== doc.updatedAt.getTime()) {
        throw new AccError('VERSION_CONFLICT', 'Документ уже изменён другим пользователем или обменом', { status: 409, fix: 'Обновите документ и внесите изменения повторно.' });
      }
      if (doc.status === 'POSTED' && !input.reason) throw new AccError('REASON_REQUIRED', 'Изменение проведённого документа требует указать причину');
      const merged: TradeDocInput = {
        docType: doc.docType, date: input.date ?? doc.date.toISOString(), counterpartyId: input.counterpartyId ?? doc.counterpartyId ?? undefined,
        contractId: input.contractId ?? doc.contractId ?? undefined, storeId: input.storeId ?? doc.storeId ?? undefined, storeToId: input.storeToId ?? doc.storeToId ?? undefined,
        lines: input.lines ?? doc.lines.map((l) => ({ productId: l.productId, qty: l.qty.toString(), price: l.price?.toString(), discount: l.discount?.toString(), vatRate: l.vatRate?.toString() ?? null })),
        amount: input.amount ?? doc.total?.toString(),
      } as TradeDocInput;
      for (const k of ['comment', 'vatIncluded', 'paymentType', 'bankAccountId', 'departmentId', 'lossAccount'] as const) if ((input as any)[k] !== undefined) (merged as any)[k] = (input as any)[k];
      await this.validateRefs(tx, ctx, merged);
      const wasPosted = doc.status === 'POSTED';
      if (wasPosted) await this.applyStock(tx, doc, -1);
      const lines = this.buildLines(merged);
      const isPayment = doc.docType.startsWith('PAYMENT_');
      const total = isPayment ? money(merged.amount, 2, 'сумма платежа') : lines.reduce((a, l) => a.plus(l.amount), new D(0));
      await tx.documentLine.deleteMany({ where: { documentId: id } });
      await tx.document.update({
        where: { id },
        data: {
          date: new Date(merged.date), counterpartyId: merged.counterpartyId, contractId: merged.contractId, storeId: merged.storeId, storeToId: merged.storeToId,
          total, comment: merged.comment ?? doc.comment, attributes: this.attrs(input as TradeDocInput, doc.attributes ?? {}), updatedBy: ctx.userId,
          lines: { create: lines.map((l) => ({ lineNo: l.lineNo, productId: l.productId, qty: l.qty, price: l.price, discount: l.discount, amount: l.amount, vatRate: l.vatRate })) },
        },
      });
      await tx.auditLog.create({ data: { userId: ctx.userId, organizationId: ctx.organizationId, action: 'TRADE_DOC_UPDATE', entity: 'document', entityId: id, reason: input.reason, before: { total: doc.total, date: doc.date } as any, after: { total: total.toFixed(2), date: merged.date } } });
      if (wasPosted) {
        const fresh = await tx.document.findUnique({ where: { id }, include: { lines: true } });
        await this.applyStock(tx, fresh!, 1);
        await this.autopilot.syncTradeDocument(tx, id, { userId: ctx.userId, override, organizationId: ctx.organizationId });
      }
      return this.view(tx, id);
    }, { timeout: 60000 });
  }

  private async postIn(tx: Tx, ctx: OrgContext, id: string, override?: OverrideRequest) {
    const doc = await this.scoped(tx, ctx, id);
    if (doc.deleted) throw new AccError('DOC_CANCELLED', 'Документ помечен на удаление');
    if (doc.status !== 'POSTED') {
      await tx.document.update({ where: { id }, data: { status: 'POSTED', updatedBy: ctx.userId } });
      await this.applyStock(tx, doc, 1);
    }
    await this.autopilot.syncTradeDocument(tx, id, { userId: ctx.userId, override, organizationId: ctx.organizationId });
    return this.view(tx, id);
  }

  post(ctx: OrgContext, id: string, override?: OverrideRequest) {
    return this.prisma.$transaction((tx) => this.postIn(tx, ctx, id, override), { timeout: 60000 });
  }

  unpost(ctx: OrgContext, id: string, override?: OverrideRequest) {
    return this.prisma.$transaction(async (tx) => {
      const doc = await this.scoped(tx, ctx, id);
      if (doc.status !== 'POSTED') return this.view(tx, id);
      await tx.document.update({ where: { id }, data: { status: 'DRAFT', updatedBy: ctx.userId } });
      await this.applyStock(tx, doc, -1);
      await this.autopilot.syncTradeDocument(tx, id, { userId: ctx.userId, override, organizationId: ctx.organizationId });
      return this.view(tx, id);
    }, { timeout: 60000 });
  }

  cancel(ctx: OrgContext, id: string, override?: OverrideRequest) {
    return this.prisma.$transaction(async (tx) => {
      const doc = await this.scoped(tx, ctx, id);
      if (doc.status === 'POSTED') await this.applyStock(tx, doc, -1);
      await tx.document.update({ where: { id }, data: { status: 'CANCELLED', deleted: true, updatedBy: ctx.userId } });
      await this.autopilot.syncTradeDocument(tx, id, { userId: ctx.userId, override, organizationId: ctx.organizationId });
      return this.view(tx, id);
    }, { timeout: 60000 });
  }

  /** Восстановить помеченный на удаление документ (в черновик). */
  restore(ctx: OrgContext, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const doc = await this.scoped(tx, ctx, id);
      if (!doc.deleted && doc.status !== 'CANCELLED') return this.view(tx, id);
      await tx.document.update({ where: { id }, data: { status: 'DRAFT', deleted: false, updatedBy: ctx.userId } });
      await tx.auditLog.create({ data: { userId: ctx.userId, organizationId: ctx.organizationId, action: 'TRADE_DOC_RESTORE', entity: 'document', entityId: id } });
      return this.view(tx, id);
    });
  }

  /** Создать на основании: остаток по заказу (заказано − уже отгружено/получено по проведённым документам). */
  async fromBase(ctx: OrgContext, baseId: string, targetType: string, date?: string) {
    const base = await this.prisma.$transaction((tx) => this.scoped(tx, ctx, baseId));
    if (!BASE_TARGETS[base.docType]?.includes(targetType)) throw new AccError('BAD_BASE', `Нельзя создать ${targetType} на основании ${base.docType}`);
    if (base.deleted || base.status === 'CANCELLED') throw new AccError('BASE_CANCELLED', `Документ ${base.number} помечен на удаление`);
    if (!base.docType.endsWith('_ORDER') && base.status !== 'POSTED') throw new AccError('BASE_NOT_POSTED', `Возврат оформляется только на основании проведённого документа (${base.number} — черновик)`, { fix: 'Сначала проведите документ-основание.' });
    const children = await this.prisma.document.findMany({
      where: { docType: targetType as any, status: 'POSTED', deleted: false, attributes: { path: ['baseId'], equals: baseId } },
      include: { lines: true },
    });
    const done = new Map<string, Prisma.Decimal>();
    for (const c of children) for (const l of c.lines) done.set(l.productId, (done.get(l.productId) ?? new D(0)).plus(l.qty));
    const lines: TradeLineInput[] = [];
    for (const l of base.lines) {
      const left = new D(l.qty).minus(done.get(l.productId) ?? 0);
      if (left.gt(0)) {
        lines.push({ productId: l.productId, qty: left.toFixed(3), price: l.price?.toString(), discount: l.discount?.toString(), vatRate: l.vatRate?.toString() ?? null });
        done.set(l.productId, new D(0));
      }
    }
    if (!lines.length) throw new AccError('BASE_FULFILLED', `По документу ${base.number} всё уже исполнено`);
    return this.create(ctx, {
      docType: targetType, date: date ?? new Date().toISOString().slice(0, 10), counterpartyId: base.counterpartyId ?? undefined,
      contractId: base.contractId ?? undefined, storeId: base.storeId ?? undefined, vatIncluded: (base.attributes as any)?.vatIncluded,
      baseId, lines, status: 'DRAFT',
    });
  }

  async list(ctx: OrgContext, q: { docType?: string; status?: string; from?: string; to?: string; search?: string; page?: number; limit?: number }) {
    const stores = (await this.prisma.store.findMany({ where: { organizationId: ctx.organizationId }, select: { id: true } })).map((s) => s.id);
    const where: Prisma.DocumentWhereInput = { OR: [{ organizationId: ctx.organizationId }, { organizationId: null, storeId: { in: stores } }] };
    const and: Prisma.DocumentWhereInput[] = [];
    if (q.docType) and.push({ docType: q.docType as any });
    if (q.status) and.push({ status: q.status as any });
    if (q.from || q.to) and.push({ date: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to + 'T23:59:59.999Z') } : {}) } });
    if (q.search) and.push({ OR: [{ number: { contains: q.search, mode: 'insensitive' } }, { counterparty: { name: { contains: q.search, mode: 'insensitive' } } }] });
    if (and.length) where.AND = and;
    const limit = Math.min(200, Number(q.limit) || 50);
    const page = Math.max(1, Number(q.page) || 1);
    const [items, total] = await Promise.all([
      this.prisma.document.findMany({ where, include: { counterparty: { select: { id: true, name: true } } }, orderBy: [{ date: 'desc' }, { number: 'desc' }], skip: (page - 1) * limit, take: limit }),
      this.prisma.document.count({ where }),
    ]);
    const entries = await this.prisma.accEntry.findMany({ where: { organizationId: ctx.organizationId, sourceType: TRADE_SOURCE, sourceId: { in: items.map((i) => i.id) }, status: 'ACTIVE' }, select: { sourceId: true } });
    const issues = await this.prisma.accAutopilotIssue.findMany({ where: { sourceType: TRADE_SOURCE, sourceId: { in: items.map((i) => i.id) }, resolvedAt: null } });
    return {
      items: items.map((i) => ({
        ...i,
        accounting: entries.some((e) => e.sourceId === i.id) ? 'REFLECTED' : issues.find((x) => x.sourceId === i.id) ? 'ISSUE' : 'NONE',
        issue: issues.find((x) => x.sourceId === i.id) ?? null,
      })),
      total, page, limit,
    };
  }

  async get(ctx: OrgContext, id: string) {
    return this.prisma.$transaction(async (tx) => {
      await this.scoped(tx, ctx, id);
      return this.view(tx, id);
    });
  }

  private async view(tx: Tx, id: string) {
    const doc = await tx.document.findUnique({
      where: { id },
      include: { counterparty: { select: { id: true, name: true, inn: true } }, lines: { include: { product: { select: { id: true, name: true, kind: true, code: true, article: true } } }, orderBy: { lineNo: 'asc' } } },
    });
    const org = doc!.organizationId;
    const entry = org ? await tx.accEntry.findFirst({
      where: { organizationId: org, sourceType: TRADE_SOURCE, sourceId: id, status: 'ACTIVE' },
      include: { postings: { include: { account: { select: { code: true, name: true } } }, orderBy: { lineNo: 'asc' } } },
    }) : null;
    const costEntries = org ? await tx.accEntry.findMany({
      where: { organizationId: org, sourceType: 'COST', sourceId: { startsWith: `${TRADE_SOURCE}:${id}:` }, status: 'ACTIVE' },
      include: { postings: { include: { account: { select: { code: true, name: true } } }, orderBy: { lineNo: 'asc' } } },
    }) : [];
    const issue = await tx.accAutopilotIssue.findFirst({ where: { sourceType: TRADE_SOURCE, sourceId: id, resolvedAt: null } });
    const children = await tx.document.findMany({ where: { attributes: { path: ['baseId'], equals: id } }, select: { id: true, number: true, docType: true, status: true, date: true, total: true } });
    const baseId = (doc!.attributes as any)?.baseId;
    const base = baseId ? await tx.document.findUnique({ where: { id: baseId }, select: { id: true, number: true, docType: true, status: true, date: true, total: true } }) : null;
    return { ...doc!, entry, costEntries, issue, related: [...(base ? [base] : []), ...children] };
  }
}
