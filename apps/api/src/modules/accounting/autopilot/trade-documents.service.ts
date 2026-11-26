import { Injectable, Optional } from '@nestjs/common';
import { AutomationService } from '../automation/automation.service';
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
import { plannedMoves, recordDocumentMoves, reverseDocumentMoves, serviceIds } from '../../inventory/stock-ledger';
import { LotError, checkLotLine } from '../../inventory/lots';
import { applyBasis, assertBasisLimits, snapshotOrder } from './sales-flow';
import { CountError, bookQty, checkInventoryLine, checkLossLine, inventoryValue, stockPositions } from '../../inventory/count';
import { ReserveError, activeReservations, assertReservesCovered, consumeForShipment, releaseReservations, reserveOrder } from '../../inventory/reservations';
import { ReceiptError, checkReceiptLine, receiptSummary } from '../../inventory/receipt';
import { splitVat, standardVatRate } from './vat';
import { AGING_BUCKETS, DUE_DATE_RE, bucketOf, daysBetween, kzDay, termsFor } from './payment-terms';
import { ORDER_STAGES, fulfillLines, fulfillState, isOrder, orderStatus } from './order-info';
import { invoiceStates, isInvoice } from './invoices';

type Tx = Prisma.TransactionClient;
/** Документы, в которых цена может быть «без НДС» и НДС начисляется сверху (как в tradeLineAmounts). */
const VAT_ON_TOP_TYPES = new Set(['INVOICE_OUT', 'INVOICE_IN', 'SUPPLY', 'DEMAND', 'RETAIL_DEMAND', 'SALES_RETURN', 'RETAIL_RETURN', 'LANDED_COST', 'PURCHASE_RETURN', 'CUSTOMER_ORDER', 'PURCHASE_ORDER']);

const PREFIX: Record<string, string> = {
  INVOICE_OUT: 'СЧ', INVOICE_IN: 'СЧП', INTERNAL_ORDER: 'ВЗ', PURCHASE_ORDER: 'ЗП', SUPPLY: 'ПТ', PURCHASE_RETURN: 'ВП', LANDED_COST: 'ДР', CUSTOMER_ORDER: 'ЗК', DEMAND: 'РТ', SALES_RETURN: 'ВК',
  ENTER: 'ОПР', LOSS: 'СП', MOVE: 'ПМ', INVENTORY: 'ИНВ', PAYMENT_IN: 'ПВ', PAYMENT_OUT: 'ИП', RETAIL_DEMAND: 'ЧЕК', RETAIL_RETURN: 'ВЧ',
};
const EDITABLE = Object.keys(PREFIX);
const BASE_TARGETS: Record<string, string[]> = { CUSTOMER_ORDER: ['DEMAND', 'INVOICE_OUT'], PURCHASE_ORDER: ['SUPPLY', 'INVOICE_IN'], INVOICE_OUT: ['DEMAND'], INVOICE_IN: ['SUPPLY'], INTERNAL_ORDER: ['MOVE'], DEMAND: ['SALES_RETURN'], SUPPLY: ['PURCHASE_RETURN'], RETAIL_DEMAND: ['RETAIL_RETURN'] };

export interface TradeLineInput {
  productId: string; qty: string | number; price?: string | number; discount?: string | number; vatRate?: string | number | null;
  /** FP-030, поступление: по документу поставщика (заказу), отказ при приёмке, причина и пояснение расхождения. */
  expectedQty?: string | number | null; rejectedQty?: string | number | null; discrepancyReason?: string | null; discrepancyNote?: string | null;
  /** FP-032: ячейка склада документа (для перемещения — откуда) и ячейка склада-получателя. */
  binId?: string | null; binToId?: string | null;
  /** FP-033: партия и срок годности; инвентаризация — учётное (считает сервер, из запроса не принимается). */
  lotNumber?: string | null; expiryDate?: string | null; bookQty?: string | number | null;
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
  /** FP-031, доп. расходы: база распределения — сумма строк поступления (AMOUNT) или количество (QTY). */
  allocation?: 'AMOUNT' | 'QTY';
  /** FP-032, перемещение: в два этапа — отгрузка на «В пути», затем приёмка на склад-получатель (storeToId). */
  twoStage?: boolean;
  /** FP-033, списание: причина по умолчанию для строк без своей причины. */
  lossReason?: string;
  /** FP-034, возврат без основания (реализации) — только явно и с причиной. */
  noBasis?: boolean;
  returnReason?: string;
  /** FP-034: источник цен заказа (снимок прайс-листов и скидок) — заполняет сервер. */
  pricing?: any;
  baseId?: string;
  /** Срок оплаты документа (ГГГГ-ММ-ДД) — вместо отсрочки договора/контрагента; null — снять. */
  dueDate?: string | null;
  /** Заказы: этап (ставит человек), плановая дата отгрузки/поступления, ответственный (участник организации). */
  stage?: string | null;
  shipDate?: string | null;
  responsibleId?: string | null;
  lines?: TradeLineInput[];
  status?: 'DRAFT' | 'POSTED';
}

/**
 * Торговые документы, вводимые из бухгалтерии. Хранятся в общей таблице documents FlowPOS
 * (owner = PLATFORM), проводятся атомарно вместе с отражением в учёте и оперативным остатком.
 */
@Injectable()
export class TradeDocumentsService {
  constructor(private prisma: PrismaService, private autopilot: AutopilotService, private approvals: ApprovalsService, @Optional() private automation?: AutomationService) {}

  /** Сценарии «если — то» после сохранения (ошибки сценария документ не откатывают). */
  private async fireAutomation(ctx: OrgContext, event: 'DOC_CREATED' | 'DOC_POSTED', v: any) {
    if (!this.automation || !v?.id) return;
    await this.automation.fire(ctx, event, { id: v.id, docType: v.docType, number: v.number, total: v.total, counterpartyId: v.counterpartyId, attributes: v.attributes, updatedBy: v.updatedBy });
  }

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

  /** Поля заказа: этап — из списка для вида заказа, дата — ГГГГ-ММ-ДД, ответственный — действующий участник организации. */
  private async checkOrderFields(tx: Tx, ctx: OrgContext, docType: string, input: { stage?: string | null; shipDate?: string | null; responsibleId?: string | null }) {
    const touched = ['stage', 'shipDate', 'responsibleId'].some((k) => (input as any)[k] !== undefined && (input as any)[k] !== null && (input as any)[k] !== '');
    if (!touched) return;
    if (!isOrder(docType)) throw new AccError('NOT_ORDER', 'Этап, дата отгрузки и ответственный есть только у заказов');
    if (input.stage && !ORDER_STAGES[docType].includes(input.stage)) throw new AccError('BAD_STAGE', `Этап заказа: ${ORDER_STAGES[docType].join(', ')}`);
    if (input.shipDate && !DUE_DATE_RE.test(String(input.shipDate))) throw new AccError('BAD_DATE', 'Дата отгрузки: ГГГГ-ММ-ДД');
    if (input.responsibleId) {
      const m = await tx.orgMembership.findFirst({ where: { organizationId: ctx.organizationId, userId: input.responsibleId, isActive: true } });
      if (!m) throw new AccError('BAD_RESPONSIBLE', 'Ответственный должен быть сотрудником этой организации');
    }
  }

  private async validateRefs(tx: Tx, ctx: OrgContext, input: TradeDocInput, internal = false) {
    const st: Record<string, { isTransit: boolean } | null> = {};
    for (const [field, label] of [['storeId', 'склад'], ['storeToId', 'склад-получатель']] as const) {
      const id = input[field];
      const store = id ? await tx.store.findFirst({ where: { id, organizationId: ctx.organizationId } }) : null;
      if (id && !store) {
        throw new AccError('REF_FOREIGN', `Указан ${label}, которого нет в этой организации`, { fix: `Выберите ${label} текущей организации.` });
      }
      st[field] = store;
    }
    // FP-032: «В пути» — служебный склад двухэтапного перемещения. Вручную с него можно только списать недостачу.
    if (!internal && (st.storeToId?.isTransit || (st.storeId?.isTransit && input.docType !== 'LOSS'))) {
      throw new AccError('STORE_TRANSIT', 'Склад «В пути» используется только для перемещения в два этапа', { fix: 'Выберите обычный склад; для перемещения через «В пути» включите «в два этапа».' });
    }
    // FP-032: ячейки — своего склада (откуда — склада документа, куда — склада-получателя); внутри склада — только между ячейками.
    for (const [i, l] of (input.lines || []).entries()) {
      for (const [bf, sf, label] of [['binId', 'storeId', 'ячейка'], ['binToId', 'storeToId', 'ячейка-получатель']] as const) {
        const binId = l[bf];
        if (!binId) continue;
        const storeId = sf === 'storeToId' && input.docType !== 'MOVE' ? null : input[sf];
        if (!storeId || !(await tx.bin.findFirst({ where: { id: binId, storeId, isActive: true } }))) {
          throw new AccError('BIN_FOREIGN', `Строка ${i + 1}: ${label} не относится к ${sf === 'storeId' ? 'складу документа' : 'складу-получателю'}`, { fix: 'Выберите ячейку этого склада.' });
        }
      }
    }
    if (input.docType === 'MOVE' && input.storeId && input.storeId === input.storeToId) {
      const ok = (input.lines || []).every((l) => l.binId && l.binToId && l.binId !== l.binToId);
      if (!ok) throw new AccError('MOVE_SAME_STORE', 'Склад-отправитель и склад-получатель совпадают', { fix: 'Для перемещения внутри склада укажите в каждой строке разные ячейки «откуда» и «куда».' });
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
    // FP-031: доп. расходы — на основании проведённого поступления своей организации, склад — склад поступления.
    if (input.docType === 'LANDED_COST') {
      const base = input.baseId ? await tx.document.findUnique({ where: { id: input.baseId }, select: { docType: true, status: true, deleted: true, storeId: true, date: true, number: true } }) : null;
      if (!base || base.docType !== 'SUPPLY') throw new AccError('LANDED_BASE_REQUIRED', 'Доп. расходы оформляются на основании поступления товаров', { fix: 'Откройте поступление и выберите «Ещё → Доп. расходы».' });
      if (base.status !== 'POSTED' || base.deleted) throw new AccError('LANDED_BASE_NOT_POSTED', `Поступление ${base.number ?? ''} не проведено`, { fix: 'Сначала проведите поступление.' });
      if (input.date && new Date(input.date).getTime() < base.date.getTime()) throw new AccError('LANDED_BEFORE_BASE', `Дата доп. расходов раньше даты поступления ${base.number ?? ''}`);
      if (input.allocation !== undefined && !['AMOUNT', 'QTY'].includes(input.allocation)) throw new AccError('BAD_ALLOCATION', 'База распределения: AMOUNT (по сумме) или QTY (по количеству)');
      if (!input.counterpartyId) throw new AccError('COUNTERPARTY_REQUIRED', 'Укажите поставщика услуги (перевозчик, брокер…)');
      input.storeId = base.storeId ?? undefined;
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
      const price = l.price !== undefined && l.price !== '' && l.price !== null ? money(l.price, 2, `цена (строка ${i + 1})`) : null;
      // FP-033: партия, срок, учётное (инвентаризация), причина списания/расхождения.
      const lotNumber = (l.lotNumber ?? '').trim() || null;
      let expiryDate: Date | null = null;
      if (l.expiryDate) {
        expiryDate = new Date(String(l.expiryDate).slice(0, 10) + 'T00:00:00.000Z');
        if (isNaN(expiryDate.getTime())) throw new AccError('BAD_DATE', `Строка ${i + 1}: некорректный срок годности`);
      }
      const bookQ = input.docType === 'INVENTORY' && l.bookQty != null ? new D(String(l.bookQty)) : null;
      try {
        if (input.docType === 'INVENTORY') checkInventoryLine(i + 1, { qty, bookQty: bookQ, price, discrepancyReason: receipt.discrepancyReason, discrepancyNote: receipt.discrepancyNote });
        if (input.docType === 'LOSS') {
          if (!receipt.discrepancyReason && input.lossReason) receipt.discrepancyReason = input.lossReason;
          checkLossLine(i + 1, receipt.discrepancyReason, receipt.discrepancyNote);
        }
      } catch (e) {
        if (e instanceof CountError) throw new AccError(e.code, e.message, e.fix ? { fix: e.fix } : undefined);
        throw e;
      }
      const discount = l.discount !== undefined && l.discount !== '' ? money(l.discount, 2, 'скидка %') : null;
      const gross = price ? price.times(qty) : new D(0);
      const amount = round(discount ? gross.minus(gross.times(discount).div(100)) : gross);
      return {
        lineNo: i + 1, productId: l.productId, qty, price, discount, amount,
        vatRate: l.vatRate !== undefined && l.vatRate !== null && l.vatRate !== '' ? new D(String(l.vatRate)) : null,
        ...receipt,
        binId: l.binId || null, binToId: l.binToId || null,
        lotNumber, expiryDate, bookQty: bookQ,
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
      binId: l.binId, binToId: l.binToId, lotNumber: l.lotNumber, expiryDate: l.expiryDate, bookQty: l.bookQty,
    };
  }

  /** Итог документа: сумма строк; инвентаризации — сумма расхождений (для согласования); платежа — сумма платежа. */
  private totalOf(docType: string, lines: ReturnType<TradeDocumentsService['buildLines']>, amount?: unknown) {
    if (docType.startsWith('PAYMENT_')) return money(amount as any, 2, 'сумма платежа');
    if (docType === 'INVENTORY') return inventoryValue(lines);
    return lines.reduce((a, l) => a.plus(l.amount), new D(0));
  }

  /**
   * Итог к оплате. Цены «без НДС» у плательщика НДС: покупатель должен сумму строк + НДС сверху — ровно как в
   * проводках (tradeLineAmounts: ставка строки → ставка товара → стандартная на дату). Раньше итог был без НДС,
   * и экран показывал меньше, чем начислено в расчётах.
   */
  private async docTotal(tx: Tx, organizationId: string, docType: string, date: Date, vatIncluded: boolean | undefined, lines: ReturnType<TradeDocumentsService['buildLines']>, amount?: unknown) {
    const base = this.totalOf(docType, lines, amount);
    if (vatIncluded !== false || !VAT_ON_TOP_TYPES.has(docType) || !lines.length) return base;
    const policy = await tx.accPolicy.findFirst({ where: { organizationId, validFrom: { lte: date } }, orderBy: { validFrom: 'desc' } });
    if (!policy?.vatPayer) return base;
    const ids = [...new Set(lines.filter((l) => l.vatRate === null).map((l) => l.productId))];
    const products = ids.length ? await tx.product.findMany({ where: { id: { in: ids } }, select: { id: true, vatRate: true } }) : [];
    const productRate = new Map(products.map((p) => [p.id, p.vatRate]));
    let std: Prisma.Decimal | null = null;
    let sum = new D(0);
    for (const l of lines) {
      let rate: Prisma.Decimal | null = l.vatRate ?? (productRate.get(l.productId) != null ? new D(productRate.get(l.productId) as any) : null);
      if (rate === null) rate = std ??= await standardVatRate(tx, date);
      sum = sum.plus(splitVat(l.amount, rate, false).gross);
    }
    return sum;
  }

  /**
   * FP-033: подготовка строк перед сохранением — учётное количество инвентаризации (сервер, на конец даты документа,
   * без его собственных движений) и обязательность партии/срока для партионного прихода.
   */
  private async prepareLines(tx: Tx, input: TradeDocInput, docId?: string) {
    const lines = input.lines || [];
    if (input.docType === 'INVENTORY') {
      if (!input.storeId) throw new AccError('STORE_REQUIRED', 'Укажите склад инвентаризации');
      for (const l of lines) {
        const lotNumber = (l.lotNumber ?? '').trim() || null;
        l.bookQty = (await bookQty(tx, { productId: l.productId, storeId: input.storeId, binId: l.binId || null, lotNumber, on: new Date(input.date), excludeSourceId: docId })).toString();
      }
    }
    const incoming = ['SUPPLY', 'ENTER', 'SALES_RETURN', 'RETAIL_RETURN', 'INVENTORY'].includes(input.docType);
    const ids = [...new Set(lines.map((l) => l.productId))];
    const ps = ids.length ? await tx.product.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, lotTracking: true, expiryTracking: true } }) : [];
    for (const [i, l] of lines.entries()) {
      const p = ps.find((x) => x.id === l.productId);
      if (!p) continue;
      // Инвентаризация: остаток без партии (накоплен до включения партионного учёта) пересчитывается как есть;
      // партия обязательна только у новой находки (учётного без партии нет).
      const legacyUnlotted = input.docType === 'INVENTORY' && !(l.lotNumber ?? '').trim() && !new D(String(l.bookQty ?? 0)).isZero();
      try {
        checkLotLine(i + 1, incoming && !legacyUnlotted, p, { lotNumber: (l.lotNumber ?? '').trim() || null, expiryDate: l.expiryDate ? new Date(l.expiryDate) : null });
      } catch (e) { this.lotErr(e); }
    }
  }

  /** Встречные движения; партия, которой уже нет (продана), — понятная ошибка. */
  private async reverse(tx: Tx, doc: any, opts: { userId?: string | null; reason?: string }) {
    try { return await reverseDocumentMoves(tx, doc, opts); } catch (e) { this.lotErr(e); }
  }

  private lotErr(e: unknown): never {
    if (e instanceof LotError) throw new AccError(e.code, e.message, e.fix ? { fix: e.fix } : undefined);
    throw e;
  }

  /** FP-032: служебный склад «В пути» организации (создаётся при первом двухэтапном перемещении). */
  private async transitStore(tx: Tx, ctx: OrgContext) {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${'transit:' + ctx.organizationId}))::text`;
    return (await tx.store.findFirst({ where: { organizationId: ctx.organizationId, isTransit: true } }))
      ?? tx.store.create({ data: { organizationId: ctx.organizationId, tenantId: ctx.tenantId, name: 'В пути', code: 'TRANSIT', isTransit: true } });
  }

  private reserveErr(e: unknown): never {
    if (e instanceof ReserveError) throw new AccError(e.code, e.message, { status: e.status, details: e.details, fix: e.fix });
    throw e;
  }

  /**
   * Движения склада проведённой версии (FP-030) + резервы (FP-032): отгрузка по заказу расходует его резерв, затем
   * проверка, что расход не забрал чужой резерв.
   */
  private async moveStock(tx: Tx, ctx: OrgContext, doc: any, reason?: string) {
    try {
      await recordDocumentMoves(tx, doc, { userId: ctx.userId, reason });
    } catch (e) { this.lotErr(e); }
    // Инвентаризация фиксирует факт — резервы её не останавливают (нехватку под резерв покажет «свободно» < 0).
    if (doc.docType === 'INVENTORY') return;
    try {
      await consumeForShipment(tx, doc);
      await assertReservesCovered(tx, plannedMoves(doc, await serviceIds(tx, doc)));
    } catch (e) { this.reserveErr(e); }
  }

  /** FP-033: учёт изменился после подсчёта (задним числом провели движение) — проводить по старому учётному нельзя. */
  private async assertBookCurrent(tx: Tx, doc: { id: string; docType: string; date: Date; storeId: string | null; lines: any[] }) {
    if (doc.docType !== 'INVENTORY' || !doc.storeId) return;
    const changed: any[] = [];
    for (const l of doc.lines) {
      const now = await bookQty(tx, { productId: l.productId, storeId: doc.storeId, binId: l.binId ?? null, lotNumber: l.lotNumber ?? null, on: doc.date, excludeSourceId: doc.id });
      if (l.bookQty == null || !now.eq(l.bookQty)) changed.push({ lineNo: l.lineNo, productId: l.productId, counted: l.bookQty?.toString() ?? null, now: now.toString() });
    }
    if (changed.length) {
      throw new AccError('INVENTORY_BOOK_CHANGED', `Учётные количества изменились после подсчёта (строк: ${changed.length}) — обновите их`, { status: 409, fix: 'Сохраните инвентаризацию — учётные пересчитаются; расхождения и согласование — заново.', details: changed });
    }
  }

  private attrs(input: TradeDocInput, prev: any = {}) {
    const a: any = { ...prev };
    for (const k of ['vatIncluded', 'paymentType', 'bankAccountId', 'departmentId', 'lossAccount', 'baseId', 'comment', 'allocation', 'twoStage', 'destinationStoreId', 'transferStage', 'lossReason', 'noBasis', 'returnReason', 'pricing', 'orderId', 'corrAccount', 'productionId'] as const) if ((input as any)[k] !== undefined) a[k] = (input as any)[k];
    for (const k of ['stage', 'shipDate', 'responsibleId'] as const) {
      const v = (input as any)[k];
      if (v === undefined) continue;
      if (v === null || v === '') delete a[k];
      else a[k] = String(v);
    }
    if (input.dueDate !== undefined) {
      if (input.dueDate === null || input.dueDate === '') delete a.dueDate;
      else if (!DUE_DATE_RE.test(String(input.dueDate))) throw new AccError('BAD_DATE', 'Срок оплаты: дата ГГГГ-ММ-ДД');
      else a.dueDate = String(input.dueDate);
    }
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

  /**
   * Проведённые зависимые документы: поступление с доп. расходами (FP-031), отгрузка на «В пути» с приёмками (FP-032) —
   * не менять и не снимать, пока проведены зависимые.
   */
  private async assertNoLandedCosts(tx: Tx, doc: { id: string; docType: string; number: string | null; attributes?: any }) {
    // FP-036: на документ разнесены оплаты — не менять и не снимать, пока оплаты не перенесены (иначе оплата повиснет).
    const paid = await tx.paymentAllocation.findMany({ where: { settlementDocId: doc.id, status: 'ACTIVE', kind: 'DEBT' }, select: { paymentDocId: true, amount: true } });
    if (paid.length) {
      const docs = await tx.accDocument.findMany({ where: { id: { in: paid.map((p) => p.paymentDocId) } }, select: { number: true } });
      throw new AccError('PAYMENTS_ALLOCATED', `На документ ${doc.number ?? ''} разнесены оплаты ${docs.map((d) => d.number).join(', ')} — сначала перенесите или снимите их`, { status: 409, fix: 'Откройте платёж, укажите разнесение на другой документ (или снимите проведение платежа), затем меняйте этот документ.' });
    }
    // Проведённые возвраты на основании этого документа: снять/изменить основание — возврат повиснет (вернули больше,
    // чем отгружено; долг уйдёт в минус).
    if (['DEMAND', 'SUPPLY', 'RETAIL_DEMAND'].includes(doc.docType)) {
      const rets = await tx.document.findMany({ where: { docType: { in: ['SALES_RETURN', 'RETAIL_RETURN', 'PURCHASE_RETURN'] as any }, status: 'POSTED', deleted: false, attributes: { path: ['baseId'], equals: doc.id } }, select: { number: true } });
      if (rets.length) throw new AccError('RETURNS_DEPEND', `По документу ${doc.number ?? ''} проведены возвраты ${rets.map((d) => d.number).join(', ')}`, { status: 409, fix: 'Сначала снимите с проведения возвраты, затем меняйте этот документ.' });
    }
    // Оплаты, разнесённые на этот документ проводками других документов (платёж торговым документом, выписка):
    // раньше видны были только разнесения из банка, а платёж «Поступление оплаты» — нет, и оплата повисала.
    if (!doc.docType.startsWith('PAYMENT_')) {
      const foreign = await tx.accPosting.findMany({
        where: { settlementDocId: doc.id, isActive: true, entry: { status: 'ACTIVE', NOT: { sourceType: TRADE_SOURCE, sourceId: doc.id } } },
        select: { entry: { select: { sourceType: true, sourceId: true } } }, take: 50,
      });
      const srcIds = [...new Set(foreign.filter((p) => p.entry.sourceType === TRADE_SOURCE).map((p) => p.entry.sourceId))];
      if (srcIds.length) {
        const deps = await tx.document.findMany({ where: { id: { in: srcIds }, status: 'POSTED', deleted: false, docType: { in: ['PAYMENT_IN', 'PAYMENT_OUT'] as any } }, select: { number: true } });
        if (deps.length) throw new AccError('PAYMENTS_ALLOCATED', `На документ ${doc.number ?? ''} разнесены оплаты ${deps.map((d) => d.number).join(', ')} — сначала перенесите или снимите их`, { status: 409, fix: 'Снимите с проведения платёж (или разнесите его на другой документ), затем меняйте этот документ.' });
      }
    }
    if (doc.docType === 'MOVE' && doc.attributes?.twoStage) {
      const rec = await tx.document.findMany({ where: { docType: 'MOVE', status: 'POSTED', deleted: false, attributes: { path: ['baseId'], equals: doc.id } }, select: { number: true } });
      if (rec.length) throw new AccError('TRANSFER_RECEIVED_DEPENDS', `По перемещению ${doc.number ?? ''} проведены приёмки ${rec.map((d) => d.number).join(', ')}`, { status: 409, fix: 'Сначала снимите с проведения приёмки, затем меняйте отгрузку.' });
      return;
    }
    if (doc.docType !== 'SUPPLY') return;
    const dep = await tx.document.findMany({ where: { docType: 'LANDED_COST' as any, status: 'POSTED', deleted: false, attributes: { path: ['baseId'], equals: doc.id } }, select: { number: true } });
    if (dep.length) {
      throw new AccError('LANDED_COST_DEPENDS', `К поступлению ${doc.number ?? ''} проведены доп. расходы ${dep.map((d) => d.number).join(', ')}`, { status: 409, fix: 'Сначала снимите с проведения доп. расходы, затем меняйте поступление.' });
    }
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

  async create(ctx: OrgContext, input: TradeDocInput, override?: OverrideRequest, internal = false) {
    const v: any = await this.createTx(ctx, input, override, internal);
    await this.fireAutomation(ctx, 'DOC_CREATED', v);
    if (v?.status === 'POSTED') await this.fireAutomation(ctx, 'DOC_POSTED', v);
    return v;
  }

  private async createTx(ctx: OrgContext, input: TradeDocInput, override?: OverrideRequest, internal = false) {
    if (!EDITABLE.includes(input.docType)) throw new AccError('UNKNOWN_DOC_TYPE', `Тип документа ${input.docType} не поддерживается`);
    const date = new Date(input.date);
    if (!input.date || isNaN(date.getTime())) throw new AccError('BAD_DATE', 'Укажите дату документа');
    const isPayment = input.docType.startsWith('PAYMENT_');
    // Инвентаризация создаётся пустой и заполняется по остаткам склада (FP-033).
    if (!isPayment && input.docType !== 'INVENTORY' && !(input.lines || []).length) throw new AccError('NO_LINES', 'Добавьте хотя бы одну строку');
    return this.prisma.$transaction(async (tx) => {
      // FP-032: перемещение в два этапа — склад-получатель запоминается, отгрузка идёт на «В пути».
      if (input.docType === 'MOVE' && input.twoStage && !internal) {
        if (!input.storeToId) throw new AccError('STORE_REQUIRED', 'Укажите склад-получатель');
        await this.validateRefs(tx, ctx, { ...input, lines: input.lines?.map((l) => ({ ...l, binToId: null })) });
        input = { ...input, destinationStoreId: input.storeToId, storeToId: (await this.transitStore(tx, ctx)).id, lines: input.lines?.map((l) => ({ ...l, binToId: null })) } as TradeDocInput;
        internal = true;
      } else if (input.twoStage) {
        throw new AccError('BAD_TWO_STAGE', 'В два этапа оформляется только перемещение');
      }
      await this.validateRefs(tx, ctx, input, internal);
      await this.checkOrderFields(tx, ctx, input.docType, input);
      if (isOrder(input.docType) && input.responsibleId === undefined) input.responsibleId = ctx.userId; // по умолчанию — кто создал
      // FP-034: цены и НДС — из основания (заказа / реализации); заказ — снимок цен на дату.
      // Отгрузка/приёмка по счёту, выставленному по заказу: помним заказ — его статус и резерв учитывают и её.
      if ((input.docType === 'DEMAND' || input.docType === 'SUPPLY') && input.baseId) {
        const b = await tx.document.findUnique({ where: { id: input.baseId }, select: { docType: true, attributes: true } });
        if (b && isInvoice(b.docType) && (b.attributes as any)?.baseId) (input as any).orderId = (b.attributes as any).baseId;
      }
      await applyBasis(tx, input);
      await snapshotOrder(tx, ctx, input);
      await this.prepareLines(tx, input);
      const lines = this.buildLines(input);
      const total = await this.docTotal(tx, ctx.organizationId, input.docType, date, input.vatIncluded, lines, input.amount);
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
      if ((doc.attributes as any)?.closed) throw new AccError('ORDER_CLOSED', `Заказ ${doc.number ?? ''} закрыт — изменять его нельзя`);
      if (doc.status === 'POSTED' && !input.reason) throw new AccError('REASON_REQUIRED', 'Изменение проведённого документа требует указать причину');
      await this.checkOrderFields(tx, ctx, doc.docType, input);
      const merged: TradeDocInput = {
        docType: doc.docType, date: input.date ?? doc.date.toISOString(), counterpartyId: input.counterpartyId ?? doc.counterpartyId ?? undefined,
        contractId: input.contractId === null ? undefined : input.contractId ?? doc.contractId ?? undefined, storeId: input.storeId ?? doc.storeId ?? undefined, storeToId: input.storeToId ?? doc.storeToId ?? undefined,
        lines: input.lines ?? doc.lines.map((l) => ({
          productId: l.productId, qty: l.qty.toString(), price: l.price?.toString(), discount: l.discount?.toString(), vatRate: l.vatRate?.toString() ?? null,
          expectedQty: l.expectedQty?.toString() ?? null, rejectedQty: l.rejectedQty?.toString() ?? null, discrepancyReason: l.discrepancyReason, discrepancyNote: l.discrepancyNote,
          binId: l.binId, binToId: l.binToId, lotNumber: l.lotNumber, expiryDate: l.expiryDate ? l.expiryDate.toISOString().slice(0, 10) : null,
        })),
        amount: input.amount ?? doc.total?.toString(),
      } as TradeDocInput;
      for (const k of ['comment', 'vatIncluded', 'paymentType', 'bankAccountId', 'departmentId', 'lossAccount', 'allocation', 'lossReason'] as const) if ((input as any)[k] !== undefined) (merged as any)[k] = (input as any)[k];
      if (merged.lossReason === undefined && (doc.attributes as any)?.lossReason) merged.lossReason = (doc.attributes as any).lossReason;
      // FP-034: основание не меняется; цены — снова из основания / снимка.
      for (const k of ['baseId', 'noBasis', 'returnReason'] as const) if ((merged as any)[k] === undefined && (doc.attributes as any)?.[k] !== undefined) (merged as any)[k] = (doc.attributes as any)[k];
      if ((input as any).noBasis !== undefined) merged.noBasis = (input as any).noBasis;
      if ((input as any).returnReason !== undefined) merged.returnReason = (input as any).returnReason;
      if (doc.docType === 'LANDED_COST') merged.baseId = (doc.attributes as any)?.baseId;
      // FP-032: отгрузка в два этапа — склад «В пути» не меняется; новый склад-получатель — в реквизитах; приёмка с
      // «В пути» — служебная (склады те же).
      const da = (doc.attributes ?? {}) as any;
      const internal = !!da.twoStage || da.transferStage === 'RECEIPT';
      if (da.twoStage) {
        if (input.storeToId && input.storeToId !== doc.storeToId) {
          await this.validateRefs(tx, ctx, { docType: 'MOVE', date: merged.date, storeId: merged.storeId, storeToId: input.storeToId });
          (input as any).destinationStoreId = input.storeToId;
        }
        merged.storeToId = doc.storeToId ?? undefined;
        merged.lines = merged.lines?.map((l) => ({ ...l, binToId: null }));
      }
      if (da.transferStage === 'RECEIPT') { merged.storeId = doc.storeId ?? undefined; merged.storeToId = doc.storeToId ?? undefined; }
      await this.validateRefs(tx, ctx, merged, internal);
      await applyBasis(tx, merged);
      await snapshotOrder(tx, ctx, merged);
      if (merged.pricing) (input as any).pricing = merged.pricing;
      if (merged.storeId !== doc.storeId && merged.storeId) (input as any).storeId = merged.storeId;
      await this.prepareLines(tx, merged, id);
      // FP-029: сохранение без изменения содержимого — не новая версия (иначе «Провести» на экране, которое сначала
      // сохраняет, отменяло бы согласование этой же версии).
      const lines0 = this.buildLines(merged);
      const vatIncl = merged.vatIncluded ?? (doc.attributes as any)?.vatIncluded;
      const total0 = await this.docTotal(tx, ctx.organizationId, doc.docType, new Date(merged.date), vatIncl, lines0, merged.amount);
      const candidate = {
        ...doc, date: new Date(merged.date), counterpartyId: merged.counterpartyId ?? null, contractId: merged.contractId ?? null, storeId: merged.storeId ?? null,
        storeToId: merged.storeToId ?? null, total: total0, comment: merged.comment ?? doc.comment, attributes: this.attrs(input as TradeDocInput, doc.attributes ?? {}), lines: lines0,
      };
      if (tradeHash(candidate) === tradeHash(doc)) return this.view(tx, id);
      const wasPosted = doc.status === 'POSTED';
      if (wasPosted) await this.assertNoLandedCosts(tx, doc);
      // Проведённая версия неизменяема: снимаем проведение, меняем, проводим новую версию (всё в одной транзакции).
      if (wasPosted) {
        await this.reverse(tx, doc, { userId: ctx.userId, reason: input.reason });
        await tx.document.update({ where: { id }, data: { status: 'DRAFT' } });
      }
      const lines = this.buildLines(merged);
      const total = await this.docTotal(tx, ctx.organizationId, doc.docType, new Date(merged.date), vatIncl, lines, merged.amount);
      await tx.documentLine.deleteMany({ where: { documentId: id } });
      await tx.document.update({
        where: { id },
        data: {
          date: new Date(merged.date), counterpartyId: merged.counterpartyId, contractId: merged.contractId ?? null, storeId: merged.storeId, storeToId: merged.storeToId,
          total, comment: merged.comment ?? doc.comment, attributes: this.attrs(input as TradeDocInput, doc.attributes ?? {}), updatedBy: ctx.userId, version: { increment: 1 },
          lines: { create: lines.map((l) => this.lineData(l)) },
        },
      });
      await tx.auditLog.create({ data: { userId: ctx.userId, organizationId: ctx.organizationId, action: 'TRADE_DOC_UPDATE', entity: 'document', entityId: id, reason: input.reason, before: { total: doc.total, date: doc.date } as any, after: { total: total.toFixed(2), date: merged.date } } });
      await this.writeVersion(tx, ctx, id, 'UPDATE', input.reason);
      // FP-032: заказ с резервом — резерв подгоняется под новые строки.
      if (doc.docType === 'CUSTOMER_ORDER' && (await activeReservations(tx, id)).length) {
        try { await reserveOrder(tx, (await tx.document.findUniqueOrThrow({ where: { id }, include: { lines: { orderBy: { lineNo: 'asc' } } } })) as any, ctx.userId); } catch (e) { this.reserveErr(e); }
      }
      // FP-029: изменение отменяет согласования прежней версии.
      await this.approvals.supersede(tx, ctx.organizationId, 'TRADE', id);
      if (wasPosted) {
        const fresh = await tx.document.findUnique({ where: { id }, include: { lines: true } });
        await tx.document.update({ where: { id }, data: { status: 'POSTED', postedVersion: fresh!.version } });
        await assertBasisLimits(tx, fresh! as any);
        await this.autopilot.syncTradeDocument(tx, id, { userId: ctx.userId, override, organizationId: ctx.organizationId, force: true, actor: ctx });
        await this.moveStock(tx, ctx, fresh!, input.reason);
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
    await this.assertBookCurrent(tx, doc);
    await assertBasisLimits(tx, doc);
    // FP-029: если правило требует согласования — нужно действующее согласование этой версии (расходуется).
    await this.approvals.consumeForPost(tx, ctx, await this.approvals.docState(tx, ctx, 'TRADE', id));
    await tx.document.update({ where: { id }, data: { status: 'POSTED', postedVersion: doc.version, updatedBy: ctx.userId } });
    // FP-030: сначала учёт (стоимость прихода — из него), затем движения склада с источником.
    await this.autopilot.syncTradeDocument(tx, id, { userId: ctx.userId, override, organizationId: ctx.organizationId, actor: ctx });
    await this.moveStock(tx, ctx, doc);
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
            await assertBasisLimits(tx, doc);
            await tx.document.update({ where: { id }, data: { status: 'POSTED', postedVersion: doc.version } });
            await this.autopilot.syncTradeDocument(tx, id, { userId: ctx.userId, organizationId: ctx.organizationId });
            await this.moveStock(tx, ctx, doc);
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

  async post(ctx: OrgContext, id: string, override?: OverrideRequest, expectedVersion?: unknown) {
    const before = await this.prisma.document.findUnique({ where: { id }, select: { status: true } });
    const v: any = await this.prisma.$transaction((tx) => this.postIn(tx, ctx, id, override, expectedVersion), { timeout: 60000 });
    if (before?.status !== 'POSTED' && v?.status === 'POSTED') await this.fireAutomation(ctx, 'DOC_POSTED', v);
    return v;
  }

  unpost(ctx: OrgContext, id: string, override?: OverrideRequest, expectedVersion?: unknown) {
    return this.prisma.$transaction(async (tx) => {
      const doc = await this.scoped(tx, ctx, id);
      this.checkVersion(doc, expectedVersion);
      if (doc.status !== 'POSTED') return this.view(tx, id);
      await this.assertNoLandedCosts(tx, doc);
      await tx.document.update({ where: { id }, data: { status: 'DRAFT', postedVersion: null, updatedBy: ctx.userId } });
      await this.reverse(tx, doc, { userId: ctx.userId, reason: 'Снятие проведения' });
      await this.autopilot.syncTradeDocument(tx, id, { userId: ctx.userId, override, organizationId: ctx.organizationId, actor: ctx });
      await this.writeVersion(tx, ctx, id, 'UNPOST');
      return this.view(tx, id);
    }, { timeout: 60000 });
  }

  cancel(ctx: OrgContext, id: string, override?: OverrideRequest, expectedVersion?: unknown) {
    return this.prisma.$transaction(async (tx) => {
      const doc = await this.scoped(tx, ctx, id);
      this.checkVersion(doc, expectedVersion);
      if (doc.deleted && doc.status === 'CANCELLED') return this.view(tx, id);
      if (doc.status === 'POSTED') await this.assertNoLandedCosts(tx, doc);
      if (doc.status === 'POSTED') await this.reverse(tx, doc, { userId: ctx.userId, reason: 'Пометка на удаление' });
      if (doc.docType === 'CUSTOMER_ORDER') await releaseReservations(tx, id, 'ORDER_CANCELLED');
      await tx.document.update({ where: { id }, data: { status: 'CANCELLED', deleted: true, postedVersion: null, updatedBy: ctx.userId } });
      await this.autopilot.syncTradeDocument(tx, id, { userId: ctx.userId, override, organizationId: ctx.organizationId, actor: ctx });
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
    if (!base.docType.endsWith('_ORDER') && !isInvoice(base.docType) && base.status !== 'POSTED') throw new AccError('BASE_NOT_POSTED', `Возврат оформляется только на основании проведённого документа (${base.number} — черновик)`, { fix: 'Сначала проведите документ-основание.' });
    const viaInvoice = targetType === 'DEMAND' || targetType === 'SUPPLY';
    const children = await this.prisma.document.findMany({
      where: {
        docType: targetType as any, deleted: false, ...(isInvoice(targetType) ? { status: { not: 'CANCELLED' as any } } : { status: 'POSTED' as any }),
        OR: [{ attributes: { path: ['baseId'], equals: baseId } }, ...(viaInvoice && base.docType.endsWith('_ORDER') ? [{ attributes: { path: ['orderId'], equals: baseId } }] : [])],
      },
      include: { lines: true },
    });
    const done = new Map<string, Prisma.Decimal>();
    for (const c of children) for (const l of c.lines) done.set(l.productId, (done.get(l.productId) ?? new D(0)).plus(l.qty));
    const lines: TradeLineInput[] = [];
    for (const l of base.lines) {
      // Исполненное по товару списывается со строк основания по порядку: строки 5 + 3, исполнено 6 → остаток 0 + 2.
      const qty = new D(l.qty);
      const used = D.min(qty, done.get(l.productId) ?? new D(0));
      done.set(l.productId, (done.get(l.productId) ?? new D(0)).minus(used));
      const left = qty.minus(used);
      if (left.gt(0)) {
        // FP-030: поступление по заказу — ожидается остаток заказа; принятое по умолчанию = ожидаемому (правится при приёмке).
        lines.push({
          productId: l.productId, qty: left.toFixed(3), price: l.price?.toString(), discount: l.discount?.toString(), vatRate: l.vatRate?.toString() ?? null,
          ...(targetType === 'SUPPLY' ? { expectedQty: left.toFixed(3) } : {}),
        });
      }
    }
    if (!lines.length) throw new AccError('BASE_FULFILLED', `По документу ${base.number} всё уже исполнено`);
    // FP-034: возврат партионного товара — строками по отгруженным партиям (за вычетом уже возвращённого по партии).
    if (targetType.endsWith('_RETURN')) {
      // Возврат покупателя: основание расходовало (−), возвраты приходуют (+); возврат поставщику — наоборот.
      const sgn = targetType === 'PURCHASE_RETURN' ? -1 : 1;
      const rows = await this.prisma.$queryRaw<{ product_id: string; lot: string; expiry: Date | null; q: string }[]>`
        SELECT m.product_id, m.lot_number AS lot, max(m.expiry_date) AS expiry, sum(${-sgn}::int * m.qty)::text AS q FROM stock_movements m
        WHERE m.lot_number IS NOT NULL AND (
          (m.source_id = ${baseId} AND sign(m.qty) = ${-sgn}::int)
          OR (sign(m.qty) = ${sgn}::int AND m.source_id IN (SELECT id FROM documents WHERE attributes->>'baseId' = ${baseId} AND status = 'POSTED' AND deleted = false)))
          AND NOT EXISTS (SELECT 1 FROM stock_movements r WHERE r.reverses_id = m.id) AND m.reverses_id IS NULL
        GROUP BY m.product_id, m.lot_number HAVING sum(${-sgn}::int * m.qty) > 0 ORDER BY m.product_id, max(m.expiry_date) NULLS LAST, m.lot_number`;
      const split: TradeLineInput[] = [];
      const done = new Set<string>(); // строки одного товара (по строке на партию в основании) — раскладка один раз
      for (const l of lines) {
        const byLot = rows.filter((r) => r.product_id === l.productId);
        if (byLot.length <= 1) { split.push(l); continue; }
        if (done.has(l.productId)) continue;
        done.add(l.productId);
        for (const r of byLot) split.push({ ...l, qty: new D(r.q).toFixed(3), lotNumber: r.lot, expiryDate: r.expiry ? r.expiry.toISOString().slice(0, 10) : null });
      }
      lines.splice(0, lines.length, ...split);
    }
    return this.create(ctx, {
      docType: targetType, date: date ?? new Date().toISOString().slice(0, 10), counterpartyId: base.counterpartyId ?? undefined,
      contractId: base.contractId ?? undefined, storeId: base.storeId ?? undefined, vatIncluded: (base.attributes as any)?.vatIncluded,
      ...(targetType === 'MOVE' ? { storeToId: base.storeToId ?? undefined } : {}),
      baseId, lines: targetType === 'MOVE' ? lines.map((l) => ({ productId: l.productId, qty: l.qty })) : lines, status: 'DRAFT',
    });
  }

  // ── FP-032: резервы заказа покупателя ──

  /** Зарезервировать заказ (свободный остаток склада заказа; по строкам — сколько вышло). */
  reserve(ctx: OrgContext, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const doc = await this.scoped(tx, ctx, id);
      if ((doc.attributes as any)?.closed) throw new AccError('ORDER_CLOSED', `Заказ ${doc.number ?? ''} закрыт — резервировать нечего`);
      let lines;
      try { lines = await reserveOrder(tx, doc as any, ctx.userId); } catch (e) { this.reserveErr(e); }
      await tx.auditLog.create({ data: { userId: ctx.userId, organizationId: ctx.organizationId, action: 'STOCK_RESERVE', entity: 'document', entityId: id, after: { lines } as any } });
      return { lines, document: await this.view(tx, id) };
    }, { timeout: 60000 });
  }

  /** Снять резерв заказа. */
  releaseReserve(ctx: OrgContext, id: string) {
    return this.prisma.$transaction(async (tx) => {
      await this.scoped(tx, ctx, id);
      const n = await releaseReservations(tx, id, 'RELEASED');
      await tx.auditLog.create({ data: { userId: ctx.userId, organizationId: ctx.organizationId, action: 'STOCK_RESERVE_RELEASE', entity: 'document', entityId: id, after: { released: n } } });
      return this.view(tx, id);
    });
  }

  // ── FP-034: закрытие остатка заказа ──

  /**
   * Закрыть заказ: остаток больше не исполняется (покупатель отказался, поставщик не довезёт). Резервы снимаются,
   * новые реализации/поступления по заказу — нельзя. Причина обязательна; новая версия документа.
   */
  closeOrder(ctx: OrgContext, id: string, b: { reason?: string; expectedVersion?: unknown } = {}) {
    return this.prisma.$transaction(async (tx) => {
      const doc = await this.scoped(tx, ctx, id);
      this.checkVersion(doc, b.expectedVersion);
      if (!doc.docType.endsWith('_ORDER')) throw new AccError('NOT_ORDER', 'Закрыть можно только заказ');
      const reason = String(b.reason ?? '').trim();
      if (reason.length < 5) throw new AccError('REASON_REQUIRED', 'Укажите причину закрытия заказа (не короче 5 символов)');
      const a = (doc.attributes ?? {}) as any;
      if (a.closed) return this.view(tx, id);
      if (doc.deleted || doc.status === 'CANCELLED') throw new AccError('DOC_CANCELLED', 'Заказ помечен на удаление');
      await tx.document.update({ where: { id }, data: { attributes: { ...a, closed: { at: new Date().toISOString(), by: ctx.userId, reason } }, version: { increment: 1 }, updatedBy: ctx.userId } });
      if (doc.docType === 'CUSTOMER_ORDER') await releaseReservations(tx, id, 'RELEASED');
      await tx.auditLog.create({ data: { userId: ctx.userId, organizationId: ctx.organizationId, action: 'ORDER_CLOSE', entity: 'document', entityId: id, reason } });
      await this.writeVersion(tx, ctx, id, 'CLOSE', reason);
      return this.view(tx, id);
    });
  }

  // ── FP-033: инвентаризация ──

  /**
   * Заполнить инвентаризацию по остаткам склада (ячейки, партии) на её дату: факт = учётное (подсчётчики правят факт),
   * цена — последняя известная стоимость прихода (для оценки расхождений). Новая версия документа.
   */
  async fillFromStock(ctx: OrgContext, id: string, b: { binId?: string | null; expectedVersion?: number } = {}) {
    const lines = await this.prisma.$transaction(async (tx) => {
      const doc = await this.scoped(tx, ctx, id);
      if (doc.docType !== 'INVENTORY') throw new AccError('NOT_INVENTORY', 'Заполнить по остаткам можно только инвентаризацию');
      if (doc.status !== 'DRAFT') throw new AccError('BAD_STATUS', 'Заполнять можно только черновик инвентаризации');
      if (!doc.storeId) throw new AccError('STORE_REQUIRED', 'Укажите склад инвентаризации');
      const pos = await stockPositions(tx, doc.storeId, doc.date, b.binId ?? null, id);
      const out: TradeLineInput[] = [];
      for (const p of pos) {
        const [last] = await tx.$queryRaw<{ v: string | null }[]>`
          SELECT round(value / qty, 2)::text AS v FROM stock_movements
          WHERE organization_id = ${ctx.organizationId} AND product_id = ${p.productId} AND qty > 0 AND value > 0 AND reverses_id IS NULL
          ORDER BY (lot_number IS NOT DISTINCT FROM ${p.lotNumber}) DESC, occurred_at DESC, created_at DESC, source_line DESC LIMIT 1`; // своя партия — первой; порядок однозначен
        out.push({ productId: p.productId, qty: p.bookQty.toString(), price: last?.v ?? undefined, binId: p.binId, lotNumber: p.lotNumber, expiryDate: p.expiryDate ? p.expiryDate.toISOString().slice(0, 10) : null });
      }
      if (!out.length) throw new AccError('NOTHING_TO_COUNT', 'На складе нет учётных остатков на дату инвентаризации');
      return out;
    });
    return this.update(ctx, id, { expectedVersion: b.expectedVersion, lines: lines as any });
  }

  // ── FP-032: перемещение в два этапа ──

  /** Отгружено, принято и в пути по перемещению (по товару). */
  private async transitOf(tx: Tx, doc: { id: string; status: string; lines: { productId: string; qty: any }[] }) {
    const receipts = await tx.document.findMany({ where: { docType: 'MOVE', status: 'POSTED', deleted: false, attributes: { path: ['baseId'], equals: doc.id } }, include: { lines: true }, orderBy: { date: 'asc' } });
    const shipped = new Map<string, Prisma.Decimal>(), received = new Map<string, Prisma.Decimal>();
    if (doc.status === 'POSTED') for (const l of doc.lines) shipped.set(l.productId, (shipped.get(l.productId) ?? new D(0)).plus(l.qty));
    for (const r of receipts) for (const l of r.lines) received.set(l.productId, (received.get(l.productId) ?? new D(0)).plus(l.qty));
    const lines = [...shipped.entries()].map(([productId, q]) => {
      const rec = received.get(productId) ?? new D(0);
      return { productId, shipped: q.toString(), received: rec.toString(), inTransit: q.minus(rec).toString() };
    });
    const left = lines.some((l) => new D(l.inTransit).gt(0));
    return { state: doc.status !== 'POSTED' ? 'NOT_SHIPPED' : left ? (receipts.length ? 'PARTIAL' : 'IN_TRANSIT') : 'RECEIVED', lines, receipts: receipts.map((r) => ({ id: r.id, number: r.number, date: r.date })) };
  }

  /**
   * Приёмка перемещения на склад-получатель: проведённое перемещение «В пути» → склад-получатель, по умолчанию всё, что
   * в пути; можно частями (остаток остаётся в пути). Не раньше даты отгрузки и не больше, чем в пути.
   */
  async receive(ctx: OrgContext, id: string, input: { date?: string; lines?: { productId: string; qty: string | number; binToId?: string | null }[] } = {}) {
    const { ship, remaining } = await this.prisma.$transaction(async (tx) => {
      const ship = await this.scoped(tx, ctx, id);
      const a = (ship.attributes ?? {}) as any;
      if (ship.docType !== 'MOVE' || !a.twoStage) throw new AccError('NOT_TWO_STAGE', 'Принимать можно только перемещение в два этапа');
      if (ship.status !== 'POSTED' || ship.deleted) throw new AccError('TRANSFER_NOT_SHIPPED', 'Перемещение не проведено — товар ещё не отгружен');
      return { ship, remaining: (await this.transitOf(tx, ship)).lines };
    });
    const date = input.date ?? new Date().toISOString().slice(0, 10);
    if (new Date(date).getTime() < ship.date.getTime()) throw new AccError('RECEIVE_BEFORE_SHIP', 'Дата приёмки раньше даты отгрузки');
    const want = input.lines?.length ? input.lines : remaining.filter((l) => new D(l.inTransit).gt(0)).map((l) => ({ productId: l.productId, qty: l.inTransit }));
    if (!want.length) throw new AccError('TRANSFER_RECEIVED', `По перемещению ${ship.number ?? ''} всё уже принято`);
    const left = new Map(remaining.map((l) => [l.productId, new D(l.inTransit)]));
    for (const [i, l] of want.entries()) {
      const q = money(l.qty, 3, `количество (строка ${i + 1})`);
      const have = left.get(l.productId) ?? new D(0);
      if (q.lte(0) || q.gt(have)) throw new AccError('RECEIVE_TOO_MUCH', `Строка ${i + 1}: в пути ${have}, принимается ${q}`);
      left.set(l.productId, have.minus(q));
    }
    const dest = (ship.attributes as any).destinationStoreId as string;
    return this.create(ctx, {
      docType: 'MOVE', date, storeId: ship.storeToId!, storeToId: dest, baseId: id, comment: `Приёмка перемещения ${ship.number ?? ''}`,
      lines: want.map((l) => ({ productId: l.productId, qty: String(l.qty), binToId: l.binToId ?? null })), status: 'POSTED',
      ...({ transferStage: 'RECEIPT' } as any),
    }, undefined, true);
  }

  /** Перемещения в пути (двухэтапные, не принятые полностью). */
  async inTransit(ctx: OrgContext) {
    const docs = await this.prisma.document.findMany({ where: { organizationId: ctx.organizationId, docType: 'MOVE', status: 'POSTED', deleted: false, attributes: { path: ['twoStage'], equals: true } }, include: { lines: true }, orderBy: { date: 'asc' } });
    const out: any[] = [];
    for (const d of docs) {
      const t = await this.prisma.$transaction((tx) => this.transitOf(tx, d));
      if (t.state !== 'RECEIVED') out.push({ id: d.id, number: d.number, date: d.date, storeId: d.storeId, destinationStoreId: (d.attributes as any)?.destinationStoreId, ...t });
    }
    return out;
  }

  /**
   * Журнал торговых документов: фильтры (вид, статус, период по дням Казахстана, контрагент, склад, товар, поиск по номеру
   * и контрагенту), сортировка и итог суммы по всей выборке (не только по странице).
   */
  async list(ctx: OrgContext, q: { docType?: string; status?: string; from?: string; to?: string; search?: string; counterpartyId?: string; storeId?: string; productId?: string; responsibleId?: string; deleted?: string; sort?: string; page?: number; limit?: number }) {
    const stores = (await this.prisma.store.findMany({ where: { organizationId: ctx.organizationId }, select: { id: true } })).map((s) => s.id);
    const where: Prisma.DocumentWhereInput = { OR: [{ organizationId: ctx.organizationId }, { organizationId: null, storeId: { in: stores } }] };
    const and: Prisma.DocumentWhereInput[] = [];
    const day = (v: string, what: string) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new AccError('BAD_DATE', `${what}: дата ГГГГ-ММ-ДД`);
      return new Date(`${v}T00:00:00+05:00`);
    };
    if (q.docType) and.push({ docType: q.docType.includes(',') ? { in: q.docType.split(',') as any } : (q.docType as any) }); // журнал раздела: несколько типов
    if (q.status) and.push({ status: q.status as any });
    // Период — по дням Казахстана (UTC+5), обе даты включительно.
    if (q.from || q.to) and.push({ date: { ...(q.from ? { gte: day(q.from, 'Начало периода') } : {}), ...(q.to ? { lt: new Date(day(q.to, 'Конец периода').getTime() + 86400000) } : {}) } });
    if (q.search) and.push({ OR: [{ number: { contains: q.search, mode: 'insensitive' } }, { counterparty: { name: { contains: q.search, mode: 'insensitive' } } }, { comment: { contains: q.search, mode: 'insensitive' } }] });
    if (q.counterpartyId) and.push({ counterpartyId: q.counterpartyId });
    if (q.storeId) and.push({ OR: [{ storeId: q.storeId }, { storeToId: q.storeId }] });
    if (q.productId) and.push({ lines: { some: { productId: q.productId } } });
    // Корзина: помеченные на удаление (восстанавливаются); обычный журнал их тоже показывает — со статусом.
    if (q.deleted === '1') and.push({ OR: [{ deleted: true }, { status: 'CANCELLED' }] });
    if (q.responsibleId) and.push({ attributes: { path: ['responsibleId'], equals: q.responsibleId === 'me' ? ctx.userId : q.responsibleId } });
    if (and.length) where.AND = and;
    const limit = Math.min(200, Math.max(1, Number(q.limit) || 50));
    const page = Math.max(1, Number(q.page) || 1);
    const [field, dir] = String(q.sort || 'date_desc').split('_') as [string, string];
    const d: Prisma.SortOrder = dir === 'asc' ? 'asc' : 'desc';
    const orderBy: Prisma.DocumentOrderByWithRelationInput[] =
      field === 'number' ? [{ number: d }] : field === 'total' ? [{ total: { sort: d, nulls: 'last' } }, { date: 'desc' }]
        : field === 'counterparty' ? [{ counterparty: { name: d } }, { date: 'desc' }] : [{ date: d }, { number: d }];
    const [items, total, sum] = await Promise.all([
      this.prisma.document.findMany({ where, include: { counterparty: { select: { id: true, name: true } }, store: { select: { id: true, name: true } } }, orderBy, skip: (page - 1) * limit, take: limit }),
      this.prisma.document.count({ where }),
      this.prisma.document.aggregate({ where: { AND: [where, { deleted: false, status: { not: 'CANCELLED' } }] }, _sum: { total: true } }),
    ]);
    const entries = await this.prisma.accEntry.findMany({ where: { organizationId: ctx.organizationId, sourceType: TRADE_SOURCE, sourceId: { in: items.map((i) => i.id) }, status: 'ACTIVE' }, select: { sourceId: true } });
    const issues = await this.prisma.accAutopilotIssue.findMany({ where: { sourceType: TRADE_SOURCE, sourceId: { in: items.map((i) => i.id) }, resolvedAt: null } });
    const pay = await this.payState(this.prisma as any, ctx.organizationId, items);
    const orderSt = await this.orderStates(this.prisma as any, items);
    const invSt = await invoiceStates(this.prisma as any, ctx.organizationId, items);
    return {
      items: items.map((i) => ({
        ...i,
        accounting: entries.some((e) => e.sourceId === i.id) ? 'REFLECTED' : issues.find((x) => x.sourceId === i.id) ? 'ISSUE' : 'NONE',
        issue: issues.find((x) => x.sourceId === i.id) ?? null,
        payment: pay.get(i.id) ?? null,
        orderStatus: orderSt.get(i.id) ?? null,
        invoice: invSt.get(i.id) ?? null,
      })),
      total, page, limit, sum: (sum._sum.total ?? new D(0)).toFixed(2),
    };
  }

  /**
   * Оплата реализаций и поступлений: остаток долга по документу — сальдо расчётов (1210 / 3310 по счетам учётной
   * политики) с аналитикой «документ расчётов» = этот документ: туда же разносятся оплаты и возвраты по основанию.
   * PAID — долга нет, PARTIAL — оплачен частично, UNPAID — не оплачен. Только проведённые, не помеченные на удаление.
   */
  private async payState(tx: Tx, organizationId: string, docs: { id: string; docType: string; status: string; deleted: boolean; total: Prisma.Decimal | null; date: Date; counterpartyId?: string | null; contractId?: string | null; attributes?: any }[]) {
    const res = new Map<string, { status: 'PAID' | 'PARTIAL' | 'UNPAID'; paid: string; debt: string; dueDate: string; termSource: string; overdueDays: number }>();
    const list = docs.filter((d) => (d.docType === 'DEMAND' || d.docType === 'SUPPLY') && d.status === 'POSTED' && !d.deleted && d.total && new D(d.total).gt(0));
    if (!list.length || !organizationId) return res;
    const { accounts } = await this.autopilot.accountsFor(tx, organizationId, new Date());
    const rows = await tx.$queryRaw<{ doc: string; code: string; bal: string }[]>`
      SELECT p.settlement_doc_id AS doc, a.code, SUM(CASE WHEN p.side = 'D' THEN p.amount ELSE -p.amount END)::text AS bal
      FROM acc_postings p JOIN acc_accounts a ON a.id = p.account_id
      WHERE p.organization_id = ${organizationId} AND p.is_active AND p.ledger = 'BU'
        AND p.settlement_doc_id IN (${Prisma.join(list.map((d) => d.id))}) AND a.code IN (${accounts.receivable}, ${accounts.payable})
      GROUP BY p.settlement_doc_id, a.code`;
    const terms = await termsFor(tx, list);
    const today = kzDay(new Date());
    for (const d of list) {
      const code = d.docType === 'DEMAND' ? accounts.receivable : accounts.payable;
      const r = rows.find((x) => x.doc === d.id && x.code === code);
      if (!r) continue; // документ не отражён в учёте (нет проводок) — статус оплаты неизвестен
      const debt = D.max(d.docType === 'DEMAND' ? new D(r.bal) : new D(r.bal).neg(), 0);
      const total = new D(d.total!);
      const paid = D.max(total.minus(debt), 0);
      const t = terms.get(d.id)!;
      const open = debt.gt(0.004);
      res.set(d.id, { status: !open ? 'PAID' : debt.gte(total) ? 'UNPAID' : 'PARTIAL', paid: paid.toFixed(2), debt: debt.toFixed(2), dueDate: t.dueDate, termSource: t.source, overdueDays: open ? Math.max(0, daysBetween(t.dueDate, today)) : 0 });
    }
    return res;
  }

  /**
   * Этап заказа, дата отгрузки, ответственный — не учётные поля: меняются и в проведённом заказе без перепроведения.
   * Закрытый или помеченный на удаление заказ не меняется.
   */
  setOrderInfo(ctx: OrgContext, id: string, b: { stage?: string | null; shipDate?: string | null; responsibleId?: string | null }) {
    return this.prisma.$transaction(async (tx) => {
      const doc = await this.scoped(tx, ctx, id);
      if (!isOrder(doc.docType)) throw new AccError('NOT_ORDER', 'Этап, дата отгрузки и ответственный есть только у заказов');
      if (doc.deleted || doc.status === 'CANCELLED') throw new AccError('DOC_CANCELLED', 'Заказ помечен на удаление');
      const a = (doc.attributes ?? {}) as any;
      if (a.closed) throw new AccError('ORDER_CLOSED', `Заказ ${doc.number ?? ''} закрыт — изменять его нельзя`);
      const input = { stage: b?.stage, shipDate: b?.shipDate, responsibleId: b?.responsibleId };
      await this.checkOrderFields(tx, ctx, doc.docType, input);
      const next = this.attrs(input as TradeDocInput, a);
      const before = { stage: a.stage ?? null, shipDate: a.shipDate ?? null, responsibleId: a.responsibleId ?? null };
      const after = { stage: next.stage ?? null, shipDate: next.shipDate ?? null, responsibleId: next.responsibleId ?? null };
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        await tx.document.update({ where: { id }, data: { attributes: next, updatedBy: ctx.userId } });
        await tx.auditLog.create({ data: { userId: ctx.userId, organizationId: ctx.organizationId, action: 'ORDER_INFO', entity: 'document', entityId: id, before, after } });
      }
      return this.view(tx, id);
    });
  }

  /** Исполнение многих заказов сразу (для журнала): статус каждого по проведённым документам на основании. */
  private async orderStates(tx: Tx, orders: { id: string; docType: string; attributes: any; status: string; deleted: boolean }[]) {
    const res = new Map<string, string>();
    const list = orders.filter((o) => isOrder(o.docType));
    if (!list.length) return res;
    const [lines, children] = await Promise.all([
      tx.documentLine.findMany({ where: { documentId: { in: list.map((o) => o.id) } }, select: { documentId: true, lineNo: true, productId: true, qty: true }, orderBy: { lineNo: 'asc' } }),
      tx.document.findMany({
        where: { docType: { in: ['DEMAND', 'SUPPLY'] as any }, status: 'POSTED', deleted: false, OR: list.flatMap((o) => [{ attributes: { path: ['baseId'], equals: o.id } }, { attributes: { path: ['orderId'], equals: o.id } }]) },
        select: { docType: true, attributes: true, lines: { select: { productId: true, qty: true } } },
      }),
    ]);
    for (const o of list) {
      const target = BASE_TARGETS[o.docType][0];
      const done = new Map<string, Prisma.Decimal>();
      for (const c of children) if (c.docType === target && ((c.attributes as any)?.baseId === o.id || (c.attributes as any)?.orderId === o.id)) for (const l of c.lines) done.set(l.productId, (done.get(l.productId) ?? new D(0)).plus(l.qty));
      const { lines: fl } = fulfillLines(lines.filter((l) => l.documentId === o.id), done);
      res.set(o.id, orderStatus(o.docType, o.attributes, fulfillState(fl, o.attributes?.closed)));
    }
    return res;
  }

  /** Сотрудники организации для выбора ответственного: только имя, без ролей и адресов. */
  async assignees(ctx: OrgContext) {
    const ms = await this.prisma.orgMembership.findMany({ where: { organizationId: ctx.organizationId, isActive: true }, select: { userId: true } });
    const users = await this.prisma.user.findMany({ where: { id: { in: ms.map((m) => m.userId) } }, select: { id: true, email: true, firstName: true, lastName: true } });
    return users.map((u) => ({ id: u.id, name: [u.lastName, u.firstName].filter(Boolean).join(' ') || u.email })).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  }

  /**
   * «Оплатить до» в реализации/поступлении: срок — не учётное поле, проводки и период не трогает,
   * поэтому меняется и в проведённом документе (с записью в журнал действий).
   */
  setDueDate(ctx: OrgContext, id: string, b: { dueDate?: string | null }) {
    return this.prisma.$transaction(async (tx) => {
      const doc = await this.scoped(tx, ctx, id);
      if (doc.docType !== 'DEMAND' && doc.docType !== 'SUPPLY' && !isInvoice(doc.docType)) throw new AccError('NO_DUE_DATE', 'Срок оплаты задаётся в счёте, реализации или поступлении');
      const a = (doc.attributes ?? {}) as any;
      const next = this.attrs({ dueDate: b?.dueDate ?? null } as TradeDocInput, a);
      if ((a.dueDate ?? null) !== (next.dueDate ?? null)) {
        await tx.document.update({ where: { id }, data: { attributes: next, updatedBy: ctx.userId } });
        await tx.auditLog.create({ data: { userId: ctx.userId, organizationId: ctx.organizationId, action: 'TRADE_DOC_DUE_DATE', entity: 'document', entityId: id, before: { dueDate: a.dueDate ?? null }, after: { dueDate: next.dueDate ?? null } } });
      }
      return this.view(tx, id);
    });
  }

  /**
   * «Долги по срокам»: открытые долги покупателей (side=customers, счёт расчётов с покупателями) или наши поставщикам
   * (side=suppliers) на дату — по документам расчётов, со сроком оплаты и днями просрочки, по корзинам
   * «в срок / 1–30 / 31–60 / 61–90 / больше 90». Переплаты по документу — отдельной колонкой (уменьшают долг).
   * Остатки без документа расчётов (ввод остатков, ручные операции) — по дате проводки, без отсрочки.
   */
  async debtAging(ctx: OrgContext, q: { side?: string; date?: string; counterpartyId?: string }) {
    const side = q.side === 'suppliers' ? 'suppliers' : 'customers';
    const date = q.date ?? kzDay(new Date());
    if (!DUE_DATE_RE.test(date)) throw new AccError('BAD_DATE', 'Дата отчёта: ГГГГ-ММ-ДД');
    const toNext = new Date(new Date(`${date}T00:00:00+05:00`).getTime() + 86400000);
    const { accounts } = await this.autopilot.accountsFor(this.prisma as any, ctx.organizationId, toNext);
    const code = side === 'customers' ? accounts.receivable : accounts.payable;
    const sign = side === 'customers' ? 1 : -1;
    const cpFilter = q.counterpartyId ? Prisma.sql`AND p.counterparty_id = ${q.counterpartyId}` : Prisma.empty;
    const rows = await this.prisma.$queryRaw<{ cp: string; doc: string | null; bal: string; first: Date }[]>`
      SELECT p.counterparty_id AS cp, p.settlement_doc_id AS doc, SUM(CASE WHEN p.side = 'D' THEN p.amount ELSE -p.amount END)::text AS bal, MIN(p.date) AS first
      FROM acc_postings p JOIN acc_accounts a ON a.id = p.account_id
      WHERE p.organization_id = ${ctx.organizationId} AND p.is_active AND p.ledger = 'BU' AND a.code = ${code}
        AND p.counterparty_id IS NOT NULL AND p.date < ${toNext.toISOString()}::timestamp ${cpFilter}
      GROUP BY p.counterparty_id, p.settlement_doc_id
      HAVING SUM(CASE WHEN p.side = 'D' THEN p.amount ELSE -p.amount END) <> 0`;
    const docIds = rows.map((r) => r.doc).filter(Boolean) as string[];
    const [docs, accDocs, cps] = await Promise.all([
      docIds.length ? this.prisma.document.findMany({ where: { id: { in: docIds } }, select: { id: true, number: true, docType: true, date: true, counterpartyId: true, contractId: true, attributes: true } }) : Promise.resolve([] as any[]),
      docIds.length ? this.prisma.accDocument.findMany({ where: { id: { in: docIds }, organizationId: ctx.organizationId }, select: { id: true, number: true, docType: true, date: true } }) : Promise.resolve([] as { id: string; number: string; docType: string; date: Date }[]),
      this.prisma.counterparty.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.cp))] } }, select: { id: true, name: true, inn: true, phone: true, paymentDays: true } }),
    ]);
    const terms = await termsFor(this.prisma as any, docs);
    const byCp = new Map<string, any>();
    const zero = () => Object.fromEntries([...AGING_BUCKETS, 'credit', 'total', 'overdue'].map((k) => [k, new D(0)]));
    for (const r of rows) {
      const amount = new D(r.bal).mul(sign);
      const cp = cps.find((c) => c.id === r.cp);
      const o = byCp.get(r.cp) ?? { counterpartyId: r.cp, name: cp?.name ?? null, bin: cp?.inn ?? null, phone: cp?.phone ?? null, paymentDays: cp?.paymentDays ?? null, sums: zero(), maxOverdueDays: 0, docs: [] as any[] };
      byCp.set(r.cp, o);
      const doc = r.doc ? docs.find((d) => d.id === r.doc) : undefined;
      const acc = r.doc && !doc ? accDocs.find((d) => d.id === r.doc) : undefined;
      const t = doc ? terms.get(doc.id)! : null;
      const dueDate = t?.dueDate ?? kzDay(acc?.date ?? r.first);
      const overdueDays = amount.gt(0) ? Math.max(0, daysBetween(dueDate, date)) : 0;
      o.sums.total = o.sums.total.plus(amount);
      if (amount.lt(0)) o.sums.credit = o.sums.credit.plus(amount.neg());
      else {
        const b = bucketOf(overdueDays);
        o.sums[b] = o.sums[b].plus(amount);
        if (b !== 'notDue') o.sums.overdue = o.sums.overdue.plus(amount);
        o.maxOverdueDays = Math.max(o.maxOverdueDays, overdueDays);
      }
      o.docs.push({
        id: r.doc, kind: doc ? 'TRADE' : acc ? 'ACC' : 'NONE', number: doc?.number ?? acc?.number ?? null, docType: doc?.docType ?? acc?.docType ?? null,
        date: kzDay(doc?.date ?? acc?.date ?? r.first), dueDate, termSource: t?.source ?? 'NONE', amount: amount.toFixed(2), overdueDays,
      });
    }
    const fix = (m: Record<string, any>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, (v as Prisma.Decimal).toFixed(2)]));
    const totals = zero();
    const lines = [...byCp.values()].map((o) => {
      for (const k of Object.keys(totals)) totals[k] = totals[k].plus(o.sums[k]);
      o.docs.sort((a: any, b: any) => b.overdueDays - a.overdueDays || a.date.localeCompare(b.date));
      return { ...o, ...fix(o.sums), sums: undefined };
    }).filter((o) => new D(o.total).abs().gt(0.004))
      .sort((a, b) => new D(b.overdue).cmp(new D(a.overdue)) || new D(b.total).cmp(new D(a.total)));
    return { side, date, account: code, totals: fix(totals), lines };
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
      include: { counterparty: { select: { id: true, name: true, inn: true, phone: true } }, lines: { include: { product: { select: { id: true, name: true, kind: true, code: true, article: true, lotTracking: true, expiryTracking: true } }, bin: { select: { id: true, name: true, code: true } }, binTo: { select: { id: true, name: true, code: true } } }, orderBy: { lineNo: 'asc' } } },
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
    const fulfillment = doc!.docType.endsWith('_ORDER') || isInvoice(doc!.docType) ? await this.fulfillmentOf(tx, doc!) : null;
    const invoice = isInvoice(doc!.docType) ? (await invoiceStates(tx, doc!.organizationId ?? '', [doc!])).get(id) ?? null : null;
    const invoices = doc!.docType.endsWith('_ORDER') ? await tx.document.findMany({ where: { docType: { in: ['INVOICE_OUT', 'INVOICE_IN'] as any }, deleted: false, attributes: { path: ['baseId'], equals: id } }, select: { id: true, number: true, date: true, total: true, status: true } }) : [];
    const orderStatusV = fulfillment && isOrder(doc!.docType) ? orderStatus(doc!.docType, doc!.attributes, fulfillment.state as any) : null;
    // FP-034: возвраты по реализации / чеку — отгружено, возвращено, можно вернуть.
    const returns = BASE_TARGETS[doc!.docType]?.some((x) => x.endsWith('_RETURN')) && doc!.docType !== 'SUPPLY' ? await this.returnsOf(tx, doc!) : null;
    // FP-032: резервы заказа покупателя, состояние перемещения в два этапа.
    const reservations = doc!.docType === 'CUSTOMER_ORDER' ? await tx.stockReservation.findMany({ where: { sourceType: TRADE_SOURCE, sourceId: id }, orderBy: [{ createdAt: 'asc' }] }) : [];
    const transit = doc!.docType === 'MOVE' && (doc!.attributes as any)?.twoStage ? await this.transitOf(tx, doc!) : null;
    const payment = (await this.payState(tx, doc!.organizationId ?? '', [doc!])).get(id) ?? null;
    // ЭСФ, выписанные по этому документу (последние сначала) — статус прямо в карточке реализации.
    const esf = doc!.docType === 'DEMAND' || doc!.docType === 'SALES_RETURN'
      ? await tx.esfInvoice.findMany({ where: { sourceDocId: id, organizationId: doc!.organizationId ?? '' }, select: { id: true, num: true, status: true, esfStatus: true, registrationNumber: true, invoiceType: true }, orderBy: { createdAt: 'desc' }, take: 5 })
      : [];
    const respId = (doc!.attributes as any)?.responsibleId;
    const resp = respId ? await tx.user.findUnique({ where: { id: respId }, select: { id: true, email: true, firstName: true, lastName: true } }) : null;
    const responsible = resp ? { id: resp.id, name: [resp.lastName, resp.firstName].filter(Boolean).join(' ') || resp.email } : null;
    return { ...doc!, entry, costEntries, issue, related: [...(base ? [base] : []), ...children], movements, receipt, fulfillment, orderStatus: orderStatusV, responsible, invoice, invoices, reservations, transit, returns, payment, esf };
  }

  private async returnsOf(tx: Tx, doc: { id: string; docType: string; lines: { productId: string; qty: any }[] }) {
    const target = BASE_TARGETS[doc.docType][0];
    const rets = await tx.document.findMany({ where: { docType: target as any, status: 'POSTED', deleted: false, attributes: { path: ['baseId'], equals: doc.id } }, include: { lines: true }, orderBy: { date: 'asc' } });
    const shipped = new Map<string, Prisma.Decimal>(), returned = new Map<string, Prisma.Decimal>();
    for (const l of doc.lines) shipped.set(l.productId, (shipped.get(l.productId) ?? new D(0)).plus(l.qty));
    for (const r of rets) for (const l of r.lines) returned.set(l.productId, (returned.get(l.productId) ?? new D(0)).plus(l.qty));
    return {
      lines: [...shipped.entries()].map(([productId, q]) => ({ productId, shipped: q.toString(), returned: (returned.get(productId) ?? new D(0)).toString(), left: q.minus(returned.get(productId) ?? 0).toString() })),
      documents: rets.map((r) => ({ id: r.id, number: r.number, date: r.date, total: r.total })),
    };
  }

  /**
   * FP-030: исполнение заказа по проведённым документам на его основании: заказано, исполнено (принято / отгружено),
   * отказ при приёмке, остаток. Частичная приёмка — несколько поступлений по одному заказу.
   */
  private async fulfillmentOf(tx: Tx, order: { id: string; docType: string; attributes?: any; lines: { lineNo: number; productId: string; qty: any }[] }) {
    const target = BASE_TARGETS[order.docType]?.[0];
    const children = target ? await tx.document.findMany({
      where: { docType: target as any, status: 'POSTED', deleted: false, OR: [{ attributes: { path: ['baseId'], equals: order.id } }, { attributes: { path: ['orderId'], equals: order.id } }] },
      include: { lines: true }, orderBy: { date: 'asc' },
    }) : [];
    const done = new Map<string, Prisma.Decimal>();
    const rejected = new Map<string, Prisma.Decimal>();
    for (const c of children) for (const l of c.lines) {
      done.set(l.productId, (done.get(l.productId) ?? new D(0)).plus(l.qty));
      if (l.rejectedQty) rejected.set(l.productId, (rejected.get(l.productId) ?? new D(0)).plus(l.rejectedQty));
    }
    // Исполненное распределяется по строкам заказа одного товара по порядку (как при «создать на основании»).
    const fl = fulfillLines(order.lines, done);
    const lines = fl.lines;
    const extra = fl.extra.map(([productId, q]) => ({ productId, qty: q.toString() }));
    const closed = (order as any).attributes?.closed ?? null;
    const state = fulfillState(lines, closed);
    return {
      state, closed, lines, overDelivered: extra,
      rejected: [...rejected.entries()].map(([productId, q]) => ({ productId, qty: q.toString() })),
      documents: children.map((c) => ({ id: c.id, number: c.number, date: c.date, total: c.total })),
    };
  }
}
