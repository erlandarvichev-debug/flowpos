import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AccError } from '../common/acc-error';
import { D, money, round } from '../common/money';
import { OrgContext } from '../access/org-context';
import { OverrideRequest } from '../periods/periods.service';
import { AutopilotService } from './autopilot.service';
import { TRADE_SOURCE } from './trade-rules';
import { contractPeriodProblem } from '../../catalog/requisites';
import { tradeContent, tradeHash } from '../documents/content-hash';
import { ApprovalsService } from '../approvals/approvals.service';
import { recordDocumentMoves, reverseDocumentMoves } from '../../inventory/stock-ledger';
import { ReceiptError, checkReceiptLine, receiptSummary } from '../../inventory/receipt';

type Tx = Prisma.TransactionClient;

const PREFIX: Record<string, string> = {
  PURCHASE_ORDER: 'ЗП', SUPPLY: 'ПТ', PURCHASE_RETURN: 'ВП', CUSTOMER_ORDER: 'ЗК', DEMAND: 'РТ', SALES_RETURN: 'ВК',
  ENTER: 'ОПР', LOSS: 'СП', MOVE: 'ПМ', PAYMENT_IN: 'ПВ', PAYMENT_OUT: 'ИП', RETAIL_DEMAND: 'ЧЕК', RETAIL_RETURN: 'ВЧ',
};
const EDITABLE = Object.keys(PREFIX);
const BASE_TARGETS: Record<string, string[]> = { CUSTOMER_ORDER: ['DEMAND'], PURCHASE_ORDER: ['SUPPLY'], DEMAND: ['SALES_RETURN'], SUPPLY: ['PURCHASE_RETURN'] };

export interface TradeLineInput {
  productId: string; qty: string | number; price?: string | number; discount?: string | number; vatRate?: string | number | null;
  /** FP-030, поступление: по документу поставщика (заказу), отказ при приёмке, причина и пояснение расхождения. */
  expectedQty?: string | number | null; rejectedQty?: string | number | null; discrepancyReason?: string | null; discrepancyNote?: string | null;
}
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
  constructor(private prisma: PrismaService, private autopilot: AutopilotService, private approvals: ApprovalsService) {}

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
    // FP-028: основание — документ своей организации (иначе граф связал бы документы разных организаций).
    if (input.baseId) {
      const base = await tx.document.findUnique({ where: { id: input.baseId }, select: { organizationId: true, storeId: true } });
      const baseOrg = base?.organizationId ?? (base?.storeId ? (await tx.store.findUnique({ where: { id: base.storeId } }))?.organizationId : null);
      if (!base || baseOrg !== ctx.organizationId) throw new AccError('REF_FOREIGN', 'Документ-основание не найден в этой организации');
    }
    // FP-026: договор — своей организации, с контрагентом документа и действует на дату документа.
    if (input.contractId) {
      const k = await tx.contract.findFirst({ where: { id: input.contractId, tenantId: ctx.tenantId, organizationId: ctx.organizationId } });
      if (!k || (input.counterpartyId && k.counterpartyId !== input.counterpartyId)) {
        throw new AccError('REF_FOREIGN', 'Договор не найден у этой организации и этого контрагента', { fix: 'Выберите договор своей организации с контрагентом документа.' });
      }
      const problem = input.date ? contractPeriodProblem(k, new Date(input.date)) : null;
      if (problem) throw new AccError('CONTRACT_NOT_EFFECTIVE', problem, { fix: 'Выберите договор, действующий на дату документа, или продлите срок договора.' });
    }
    const ids = [...new Set((input.lines || []).map((l) => l.productId))];
    if (ids.length) {
      const ps = await tx.product.findMany({ where: { id: { in: ids } } });
      const bad = ids.filter((id) => { const p = ps.find((x) => x.id === id); return !p || p.tenantId !== ctx.tenantId || (p.organizationId && p.organizationId !== ctx.organizationId); });
      if (bad.length) throw new AccError('REF_FOREIGN', 'В строках указана номенклатура, которой нет в этой организации', { details: { productIds: bad } });
    }
  }

  private buildLines(input: TradeDocInput) {
    const opt = (v: unknown, what: string) => (v === undefined || v === null || v === '' ? null : money(v as any, 3, what));
    const lines = (input.lines || []).map((l, i) => {
      const qty = money(l.qty, 3, `количество (строка ${i + 1})`);
      // FP-030: приёмка — принятое, по документу, отказ, причина (поля только у поступления).
      const receipt = {
        expectedQty: opt(l.expectedQty, `количество по документу (строка ${i + 1})`), rejectedQty: opt(l.rejectedQty, `отказ (строка ${i + 1})`),
        discrepancyReason: l.discrepancyReason || null, discrepancyNote: (l.discrepancyNote ?? '').trim() || null,
      };
      try {
        checkReceiptLine(input.docType, i + 1, { qty, ...receipt });
      } catch (e) {
        if (e instanceof ReceiptError) throw new AccError(e.code, e.message, e.fix ? { fix: e.fix } : undefined);
        throw e;
      }
      const price = l.price !== undefined && l.price !== '' ? money(l.price, 2, `цена (строка ${i + 1})`) : null;
      const discount = l.discount !== undefined && l.discount !== '' ? money(l.discount, 2, 'скидка %') : null;
      const gross = price ? price.times(qty) : new D(0);
      const amount = round(discount ? gross.minus(gross.times(discount).div(100)) : gross);
      return {
        lineNo: i + 1, productId: l.productId, qty, price, discount, amount,
        vatRate: l.vatRate !== undefined && l.vatRate !== null && l.vatRate !== '' ? new D(String(l.vatRate)) : null,
        ...receipt,
      };
    });
    if (input.docType === 'SUPPLY' && lines.length && lines.every((l) => l.qty.isZero())) {
      throw new AccError('NOTHING_ACCEPTED', 'Ничего не принято: во всех строках принятое количество 0', { fix: 'Если поставка не пришла, не создавайте поступление — заказ останется открытым.' });
    }
    return lines;
  }

  /** Строка для записи в БД. */
  private lineData(l: ReturnType<TradeDocumentsService['buildLines']>[number]) {
    return {
      lineNo: l.lineNo, productId: l.productId, qty: l.qty, price: l.price, discount: l.discount, amount: l.amount, vatRate: l.vatRate,
      expectedQty: l.expectedQty, rejectedQty: l.rejectedQty, discrepancyReason: l.discrepancyReason, discrepancyNote: l.discrepancyNote,
    };
  }

  private attrs(input: TradeDocInput, prev: any = {}) {
    const a: any = { ...prev };
    for (const k of ['vatIncluded', 'paymentType', 'bankAccountId', 'departmentId', 'lossAccount', 'baseId', 'comment'] as const) if ((input as any)[k] !== undefined) a[k] = (input as any)[k];
    return a;
  }

  // ── FP-028: версии ──

  /** Неизменяемая запись истории: версия, действие, снимок, хэш содержимого. */
  private async writeVersion(tx: Tx, ctx: OrgContext, id: string, action: string, reason?: string) {
    const doc = await tx.document.findUniqueOrThrow({ where: { id }, include: { lines: true } });
    const snapshot = tradeContent(doc);
    const hash = tradeHash(doc);
    await tx.documentVersion.create({ data: { tenantId: doc.tenantId, organizationId: ctx.organizationId, documentId: id, version: doc.version, action, snapshot: { ...snapshot, status: doc.status } as any, hash, changedBy: ctx.userId, reason } });
  }

  private checkVersion(doc: { version: number }, expected: unknown) {
    if (expected !== undefined && expected !== null && Number(expected) !== doc.version) {
      throw new AccError('VERSION_CONFLICT', `Документ уже изменён другим пользователем или обменом (версия ${doc.version}, у вас ${expected})`, { status: 409, fix: 'Обновите документ и повторите действие.', details: { currentVersion: doc.version } });
    }
  }

  versions(ctx: OrgContext, id: string) {
    return this.prisma.$transaction(async (tx) => {
      await this.scoped(tx, ctx, id);
      return tx.documentVersion.findMany({ where: { documentId: id }, orderBy: [{ createdAt: 'asc' }] });
    });
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
          lines: { create: lines.map((l) => this.lineData(l)) },
        },
      });
      await tx.auditLog.create({ data: { userId: ctx.userId, organizationId: ctx.organizationId, action: 'TRADE_DOC_CREATE', entity: 'document', entityId: doc.id, after: { docType: doc.docType, number, total: total.toFixed(2) } } });
      await this.writeVersion(tx, ctx, doc.id, 'CREATE');
      if (input.status === 'POSTED') return this.postIn(tx, ctx, doc.id, override);
      return this.view(tx, doc.id);
    }, { timeout: 60000 });
  }

  async update(ctx: OrgContext, id: string, input: Partial<TradeDocInput> & { expectedVersion?: number; expectedUpdatedAt?: string; reason?: string }, override?: OverrideRequest) {
    return this.prisma.$transaction(async (tx) => {
      const doc = await this.scoped(tx, ctx, id);
      // FP-028: изменение — только с ожидаемой версией (защита от «последний записавший побеждает»).
      if (input.expectedVersion === undefined && !input.expectedUpdatedAt) {
        throw new AccError('VERSION_REQUIRED', 'Укажите версию документа, которую вы изменяете (expectedVersion)', { status: 428, details: { currentVersion: doc.version } });
      }
      this.checkVersion(doc, input.expectedVersion);
      if (input.expectedUpdatedAt && new Date(input.expectedUpdatedAt).getTime() !== doc.updatedAt.getTime()) {
        throw new AccError('VERSION_CONFLICT', 'Документ уже изменён другим пользователем или обменом', { status: 409, fix: 'Обновите документ и внесите изменения повторно.', details: { currentVersion: doc.version } });
      }
      if (doc.deleted || doc.status === 'CANCELLED') throw new AccError('DOC_CANCELLED', 'Документ помечен на удаление — сначала восстановите его');
      if (doc.status === 'POSTED' && !input.reason) throw new AccError('REASON_REQUIRED', 'Изменение проведённого документа требует указать причину');
      const merged: TradeDocInput = {
        docType: doc.docType, date: input.date ?? doc.date.toISOString(), counterpartyId: input.counterpartyId ?? doc.counterpartyId ?? undefined,
        contractId: input.contractId ?? doc.contractId ?? undefined, storeId: input.storeId ?? doc.storeId ?? undefined, storeToId: input.storeToId ?? doc.storeToId ?? undefined,
        lines: input.lines ?? doc.lines.map((l) => ({
          productId: l.productId, qty: l.qty.toString(), price: l.price?.toString(), discount: l.discount?.toString(), vatRate: l.vatRate?.toString() ?? null,
          expectedQty: l.expectedQty?.toString() ?? null, rejectedQty: l.rejectedQty?.toString() ?? null, discrepancyReason: l.discrepancyReason, discrepancyNote: l.discrepancyNote,
        })),
        amount: input.amount ?? doc.total?.toString(),
      } as TradeDocInput;
      for (const k of ['comment', 'vatIncluded', 'paymentType', 'bankAccountId', 'departmentId', 'lossAccount'] as const) if ((input as any)[k] !== undefined) (merged as any)[k] = (input as any)[k];
      await this.validateRefs(tx, ctx, merged);
      // FP-029: сохранение без изменения содержимого — не новая версия (иначе «Провести» на экране, которое сначала
      // сохраняет, отменяло бы согласование этой же версии).
      const lines0 = this.buildLines(merged);
      const total0 = doc.docType.startsWith('PAYMENT_') ? money(merged.amount, 2, 'сумма платежа') : lines0.reduce((a, l) => a.plus(l.amount), new D(0));
      const candidate = {
        ...doc, date: new Date(merged.date), counterpartyId: merged.counterpartyId ?? null, contractId: merged.contractId ?? null, storeId: merged.storeId ?? null,
        storeToId: merged.storeToId ?? null, total: total0, comment: merged.comment ?? doc.comment, attributes: this.attrs(input as TradeDocInput, doc.attributes ?? {}), lines: lines0,
      };
      if (tradeHash(candidate) === tradeHash(doc)) return this.view(tx, id);
      const wasPosted = doc.status === 'POSTED';
      // Проведённая версия неизменяема: снимаем проведение, меняем, проводим новую версию (всё в одной транзакции).
      if (wasPosted) {
        await reverseDocumentMoves(tx, doc, { userId: ctx.userId, reason: input.reason });
        await tx.document.update({ where: { id }, data: { status: 'DRAFT' } });
      }
      const lines = this.buildLines(merged);
      const isPayment = doc.docType.startsWith('PAYMENT_');
      const total = isPayment ? money(merged.amount, 2, 'сумма платежа') : lines.reduce((a, l) => a.plus(l.amount), new D(0));
      await tx.documentLine.deleteMany({ where: { documentId: id } });
      await tx.document.update({
        where: { id },
        data: {
          date: new Date(merged.date), counterpartyId: merged.counterpartyId, contractId: merged.contractId, storeId: merged.storeId, storeToId: merged.storeToId,
          total, comment: merged.comment ?? doc.comment, attributes: this.attrs(input as TradeDocInput, doc.attributes ?? {}), updatedBy: ctx.userId, version: { increment: 1 },
          lines: { create: lines.map((l) => this.lineData(l)) },
        },
      });
      await tx.auditLog.create({ data: { userId: ctx.userId, organizationId: ctx.organizationId, action: 'TRADE_DOC_UPDATE', entity: 'document', entityId: id, reason: input.reason, before: { total: doc.total, date: doc.date } as any, after: { total: total.toFixed(2), date: merged.date } } });
      await this.writeVersion(tx, ctx, id, 'UPDATE', input.reason);
      // FP-029: изменение отменяет согласования прежней версии.
      await this.approvals.supersede(tx, ctx.organizationId, 'TRADE', id);
      if (wasPosted) {
        const fresh = await tx.document.findUnique({ where: { id }, include: { lines: true } });
        await tx.document.update({ where: { id }, data: { status: 'POSTED', postedVersion: fresh!.version } });
        await this.autopilot.syncTradeDocument(tx, id, { userId: ctx.userId, override, organizationId: ctx.organizationId });
        await recordDocumentMoves(tx, fresh!, { userId: ctx.userId, reason: input.reason });
        await this.writeVersion(tx, ctx, id, 'POST', input.reason);
      }
      return this.view(tx, id);
    }, { timeout: 60000 });
  }

  /**
   * FP-028: проведение версии. Строка документа заблокирована (scoped — FOR UPDATE), поэтому параллельные проведения
   * идут по очереди; второе видит «уже проведён» и получает 409, а не тихий успех. Законный повтор того же запроса —
   * через Idempotency-Key (ответ первого).
   */
  private async postIn(tx: Tx, ctx: OrgContext, id: string, override?: OverrideRequest, expectedVersion?: unknown) {
    const doc = await this.scoped(tx, ctx, id);
    this.checkVersion(doc, expectedVersion);
    if (doc.deleted) throw new AccError('DOC_CANCELLED', 'Документ помечен на удаление');
    if (doc.status === 'POSTED') {
      throw new AccError('DOC_ALREADY_POSTED', `Документ ${doc.number ?? ''} уже проведён (версия ${doc.postedVersion ?? doc.version})`, { status: 409, details: { postedVersion: doc.postedVersion ?? doc.version } });
    }
    // FP-029: если правило требует согласования — нужно действующее согласование этой версии (расходуется).
    await this.approvals.consumeForPost(tx, ctx, await this.approvals.docState(tx, ctx, 'TRADE', id));
    await tx.document.update({ where: { id }, data: { status: 'POSTED', postedVersion: doc.version, updatedBy: ctx.userId } });
    // FP-030: сначала учёт (стоимость прихода — из него), затем движения склада с источником.
    await this.autopilot.syncTradeDocument(tx, id, { userId: ctx.userId, override, organizationId: ctx.organizationId });
    await recordDocumentMoves(tx, doc, { userId: ctx.userId });
    await this.writeVersion(tx, ctx, id, 'POST');
    return this.view(tx, id);
  }

  /**
   * FP-029: пробное проведение — те же шаги (склад, проводки автопилота), но транзакция откатывается: ничего не
   * записывается. Показывает проводки, движение остатков, проблемы и что нужно для проведения (согласование).
   */
  async simulate(ctx: OrgContext, id: string) {
    const ROLLBACK = Symbol('simulate');
    let result: any;
    try {
      await this.prisma.$transaction(async (tx) => {
        const doc = await this.scoped(tx, ctx, id);
        const st = await this.approvals.docState(tx, ctx, 'TRADE', id);
        const approval = await this.approvals.requirement(tx, ctx, st);
        const stockKeys = doc.storeId ? doc.lines.map((l) => ({ storeId: doc.storeId!, productId: l.productId })) : [];
        if (doc.storeToId) for (const l of doc.lines) stockKeys.push({ storeId: doc.storeToId, productId: l.productId });
        const qty = async () => new Map((await tx.stock.findMany({ where: { OR: stockKeys.length ? stockKeys : [{ id: '' }] } })).map((x) => [`${x.storeId}:${x.productId}`, x.qty]));
        const before = await qty();
        let error: any = null;
        if (doc.status === 'POSTED') error = { code: 'DOC_ALREADY_POSTED', message: 'Документ уже проведён — показаны его проводки' };
        else if (doc.deleted) error = { code: 'DOC_CANCELLED', message: 'Документ помечен на удаление' };
        else {
          try {
            await tx.document.update({ where: { id }, data: { status: 'POSTED', postedVersion: doc.version } });
            await this.autopilot.syncTradeDocument(tx, id, { userId: ctx.userId, organizationId: ctx.organizationId });
            await recordDocumentMoves(tx, doc, { userId: ctx.userId });
          } catch (e: any) {
            error = { code: e?.getResponse?.()?.code ?? 'ERROR', message: e?.getResponse?.()?.message ?? e?.message };
          }
        }
        const after = await qty();
        const view = await this.view(tx, id);
        const issue = await tx.accAutopilotIssue.findFirst({ where: { sourceType: TRADE_SOURCE, sourceId: id, resolvedAt: null }, orderBy: { createdAt: 'desc' } });
        result = {
          document: { id, number: doc.number, docType: doc.docType, version: doc.version, status: doc.status, amount: doc.total?.toFixed(2) ?? null },
          entry: view.entry, costEntries: (view as any).costEntries ?? [],
          stock: stockKeys.filter((k, i, a) => a.findIndex((x) => x.storeId === k.storeId && x.productId === k.productId) === i).map((k) => {
            const key = `${k.storeId}:${k.productId}`;
            const b = new D(before.get(key) ?? 0), a = new D(after.get(key) ?? 0);
            return { ...k, before: b.toString(), after: a.toString(), change: a.minus(b).toString() };
          }),
          issue: issue && doc.status !== 'POSTED' ? { code: issue.code, message: issue.message } : null,
          error,
          approval,
        };
        throw ROLLBACK;
      }, { timeout: 60000 });
    } catch (e) {
      if (e !== ROLLBACK) throw e;
    }
    return result;
  }

  post(ctx: OrgContext, id: string, override?: OverrideRequest, expectedVersion?: unknown) {
    return this.prisma.$transaction((tx) => this.postIn(tx, ctx, id, override, expectedVersion), { timeout: 60000 });
  }

  unpost(ctx: OrgContext, id: string, override?: OverrideRequest, expectedVersion?: unknown) {
    return this.prisma.$transaction(async (tx) => {
      const doc = await this.scoped(tx, ctx, id);
      this.checkVersion(doc, expectedVersion);
      if (doc.status !== 'POSTED') return this.view(tx, id);
      await tx.document.update({ where: { id }, data: { status: 'DRAFT', postedVersion: null, updatedBy: ctx.userId } });
      await reverseDocumentMoves(tx, doc, { userId: ctx.userId, reason: 'Снятие проведения' });
      await this.autopilot.syncTradeDocument(tx, id, { userId: ctx.userId, override, organizationId: ctx.organizationId });
      await this.writeVersion(tx, ctx, id, 'UNPOST');
      return this.view(tx, id);
    }, { timeout: 60000 });
  }

  cancel(ctx: OrgContext, id: string, override?: OverrideRequest, expectedVersion?: unknown) {
    return this.prisma.$transaction(async (tx) => {
      const doc = await this.scoped(tx, ctx, id);
      this.checkVersion(doc, expectedVersion);
      if (doc.deleted && doc.status === 'CANCELLED') return this.view(tx, id);
      if (doc.status === 'POSTED') await reverseDocumentMoves(tx, doc, { userId: ctx.userId, reason: 'Пометка на удаление' });
      await tx.document.update({ where: { id }, data: { status: 'CANCELLED', deleted: true, postedVersion: null, updatedBy: ctx.userId } });
      await this.autopilot.syncTradeDocument(tx, id, { userId: ctx.userId, override, organizationId: ctx.organizationId });
      await this.writeVersion(tx, ctx, id, 'CANCEL');
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
      await this.writeVersion(tx, ctx, id, 'RESTORE');
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
        // FP-030: поступление по заказу — ожидается остаток заказа; принятое по умолчанию = ожидаемому (правится при приёмке).
        lines.push({
          productId: l.productId, qty: left.toFixed(3), price: l.price?.toString(), discount: l.discount?.toString(), vatRate: l.vatRate?.toString() ?? null,
          ...(targetType === 'SUPPLY' ? { expectedQty: left.toFixed(3) } : {}),
        });
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
    // FP-030: движения склада документа (с источником, количеством и стоимостью), приёмка и исполнение заказа.
    const movements = await tx.stockMovement.findMany({ where: { sourceType: TRADE_SOURCE, sourceId: id }, orderBy: [{ createdAt: 'asc' }, { sourceLine: 'asc' }, { qty: 'asc' }] });
    const receipt = doc!.docType === 'SUPPLY' ? receiptSummary(doc!.lines) : null;
    const fulfillment = doc!.docType.endsWith('_ORDER') ? await this.fulfillmentOf(tx, doc!) : null;
    return { ...doc!, entry, costEntries, issue, related: [...(base ? [base] : []), ...children], movements, receipt, fulfillment };
  }

  /**
   * FP-030: исполнение заказа по проведённым документам на его основании: заказано, исполнено (принято / отгружено),
   * отказ при приёмке, остаток. Частичная приёмка — несколько поступлений по одному заказу.
   */
  private async fulfillmentOf(tx: Tx, order: { id: string; docType: string; lines: { lineNo: number; productId: string; qty: any }[] }) {
    const target = BASE_TARGETS[order.docType]?.[0];
    const children = target ? await tx.document.findMany({
      where: { docType: target as any, status: 'POSTED', deleted: false, attributes: { path: ['baseId'], equals: order.id } },
      include: { lines: true }, orderBy: { date: 'asc' },
    }) : [];
    const done = new Map<string, Prisma.Decimal>();
    const rejected = new Map<string, Prisma.Decimal>();
    for (const c of children) for (const l of c.lines) {
      done.set(l.productId, (done.get(l.productId) ?? new D(0)).plus(l.qty));
      if (l.rejectedQty) rejected.set(l.productId, (rejected.get(l.productId) ?? new D(0)).plus(l.rejectedQty));
    }
    // Исполненное распределяется по строкам заказа одного товара по порядку (как при «создать на основании»).
    const lines = order.lines.map((l) => {
      const ordered = new D(l.qty);
      const avail = done.get(l.productId) ?? new D(0);
      const take = D.min(avail, ordered);
      done.set(l.productId, avail.minus(take));
      return { lineNo: l.lineNo, productId: l.productId, ordered: ordered.toString(), fulfilled: take.toString(), remaining: ordered.minus(take).toString() };
    });
    const extra = [...done.entries()].filter(([, q]) => q.gt(0)).map(([productId, q]) => ({ productId, qty: q.toString() }));
    const state = lines.every((l) => new D(l.remaining).isZero()) ? 'FULFILLED' : lines.some((l) => new D(l.fulfilled).gt(0)) ? 'PARTIAL' : 'OPEN';
    return {
      state, lines, overDelivered: extra,
      rejected: [...rejected.entries()].map(([productId, q]) => ({ productId, qty: q.toString() })),
      documents: children.map((c) => ({ id: c.id, number: c.number, date: c.date, total: c.total })),
    };
  }
}
