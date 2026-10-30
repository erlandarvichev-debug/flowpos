import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { AccError } from '../common/acc-error';
import { D } from '../common/money';
import { OrgContext } from '../access/org-context';
import { TRADE_SOURCE, TradeDoc, tradeLineAmounts } from '../autopilot/trade-rules';
import { EsfInvoiceData, EsfProduct, INVOICE_VERSION, esfDate, parseEsfDate, parseInvoice, signableIdList, signableIdWithReasonList } from './invoice-xml';
import { EsfSoapClient, EsfSoapError, Fetcher } from './esf-soap.client';
import { EsfSerializationError, serializeInvoice } from './invoice-serializer';
import { EsfSigningError, checkSigner, inspectCertificate, issueSigningRequest, signingEvidence, signingSecret, verifyRawSignature, verifySigningRequest } from './esf-signing';
import { ESF_UNITS } from './units.data';

type Tx = Prisma.TransactionClient;
export type EsfAction = 'REVOKE' | 'DECLINE' | 'APPROVE' | 'CONFIRM_REVOKE';

/** Документы бухгалтерии для ЭСФ: реализация → основной ЭСФ, возврат покупателя → дополнительный ЭСФ к ЭСФ реализации. */
export const ESF_SOURCE_TYPES = ['DEMAND', 'SALES_RETURN'];
/** Статусы ИС ЭСФ, после которых опрос статуса не нужен. */
const FINAL_ESF = ['DELIVERED', 'CANCELED', 'CANCELED_BY_OGD', 'CANCELED_BY_SNT_DECLINE', 'CANCELED_BY_SNT_REVOKE', 'REVOKED', 'DECLINED', 'DELETED', 'FAILED', 'FAILED_BIOMETRICS_VERIFICATION', 'DELETED_BIOMETRICS_VERIFICATION'];
const ORIGIN_CODES = ['1', '2', '3', '4', '5', '6'];

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const money = (v: Prisma.Decimal) => v.toFixed(2);
// Без округления: лишние знаки после запятой должна увидеть проверка сериализатора, а не toFixed.
const exact = (v: Prisma.Decimal) => (v.decimalPlaces() <= 2 ? v.toFixed(2) : v.toFixed());
const today = () => new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z');

function signingError(e: unknown): never {
  if (e instanceof EsfSigningError) throw new AccError(e.code, e.message, e.problems.length ? { fix: e.problems.map((p) => `• ${p}`).join('\n') } : undefined);
  throw e;
}

function stripPem(cert: string) {
  return cert.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
}

@Injectable()
export class EsfService implements OnModuleInit, OnModuleDestroy {
  private log = new Logger('ESF');
  /** Отправка дольше этого — процесс считается упавшим (таймаут SOAP 60 с). */
  static SEND_LEASE_MS = 5 * 60_000;
  /** Сверка «не найдено» доказательна только спустя этот срок после отправки (задержка обработки ИС ЭСФ). */
  static RECONCILE_QUIET_MS = 10 * 60_000;
  private timer?: NodeJS.Timeout;
  private running = false;
  /** Подменяется в тестах. */
  fetcher?: Fetcher;

  constructor(private prisma: PrismaService) {}

  onModuleInit() {
    if (process.env.ESF_WORKER_DISABLED === '1' || process.env.NODE_ENV === 'test') return;
    const every = Number(process.env.ESF_INTERVAL_MS || 60000);
    this.timer = setInterval(() => this.tick().catch((e) => this.log.error(e.message)), every);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private client(env: string) {
    return EsfSoapClient.forEnvironment(env, this.fetcher);
  }

  // ── Настройки ──

  async settings(ctx: OrgContext) {
    const s = await this.prisma.esfSettings.findUnique({ where: { organizationId: ctx.organizationId } });
    const session = await this.activeSession(this.prisma, ctx.organizationId, s?.environment ?? 'TEST');
    return { ...(s ?? { organizationId: ctx.organizationId, environment: 'TEST', autoPrepare: true, signatureType: 'COMPANY' }), inboundLastId: s?.inboundLastId?.toString() ?? null, session: session ? { iin: session.iin, openedAt: session.createdAt } : null };
  }

  async updateSettings(ctx: OrgContext, b: any) {
    const data: any = {};
    if (b.environment !== undefined) {
      if (!['TEST', 'PROD'].includes(b.environment)) throw new AccError('ESF_ENV', 'Среда ИС ЭСФ: TEST или PROD');
      data.environment = b.environment;
    }
    if (b.signerIin !== undefined) {
      if (b.signerIin && !/^\d{12}$/.test(b.signerIin)) throw new AccError('ESF_IIN', 'ИИН подписанта — 12 цифр');
      data.signerIin = b.signerIin || null;
    }
    if (b.operatorFullname !== undefined) data.operatorFullname = b.operatorFullname || null;
    if (b.signatureType !== undefined) {
      if (!['COMPANY', 'OPERATOR'].includes(b.signatureType)) throw new AccError('ESF_SIGNATURE_TYPE', 'Тип подписи: COMPANY или OPERATOR');
      data.signatureType = b.signatureType;
    }
    if (b.vatRegistrationDate !== undefined) data.vatRegistrationDate = b.vatRegistrationDate ? new Date(String(b.vatRegistrationDate).slice(0, 10) + 'T00:00:00.000Z') : null;
    if (b.transportTypeCode !== undefined) {
      if (b.transportTypeCode && !/^\d{2}$/.test(b.transportTypeCode)) throw new AccError('ESF_TRANSPORT', 'Способ отправления — двузначный код по классификатору видов транспорта (КТС № 378, прил. 3)');
      data.transportTypeCode = b.transportTypeCode || null;
    }
    if (b.defaultGoodsOrigin !== undefined) {
      if (b.defaultGoodsOrigin && !['1', '2', '3', '4', '5'].includes(b.defaultGoodsOrigin)) throw new AccError('ESF_ORIGIN', 'Признак происхождения товара: 1–5 (6 — только для работ и услуг)');
      data.defaultGoodsOrigin = b.defaultGoodsOrigin || null;
    }
    if (b.autoPrepare !== undefined) data.autoPrepare = !!b.autoPrepare;
    const before = await this.prisma.esfSettings.findUnique({ where: { organizationId: ctx.organizationId } });
    const after = await this.prisma.esfSettings.upsert({ where: { organizationId: ctx.organizationId }, create: { organizationId: ctx.organizationId, ...data }, update: data });
    await this.prisma.auditLog.create({ data: { userId: ctx.userId?.startsWith('system') ? null : ctx.userId, organizationId: ctx.organizationId, action: 'ESF_SETTINGS', entity: 'esf_settings', entityId: ctx.organizationId, before: before ? (JSON.parse(JSON.stringify(before, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))) as any) : undefined, after: JSON.parse(JSON.stringify(after, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))) as any } });
    return this.settings(ctx);
  }

  // ── Формирование ЭСФ из документа бухгалтерии ──

  /** Документ «официально» в учёте: проведён и у него есть действующая запись в журнале проводок. */
  private async accountedDoc(tx: Tx, organizationId: string, docId: string) {
    const doc = await tx.document.findFirst({
      where: { id: docId, organizationId, deleted: false },
      include: { lines: { include: { product: { include: { uom: true } } }, orderBy: { lineNo: 'asc' } }, counterparty: true },
    });
    if (!doc) throw new AccError('NOT_FOUND', 'Документ не найден', { status: 404 });
    if (!ESF_SOURCE_TYPES.includes(doc.docType)) throw new AccError('ESF_DOC_TYPE', 'ЭСФ формируется по «Реализации» (основной) или по «Возврату покупателя» (дополнительный)', { fix: 'Поступления и розничные чеки ЭСФ не требуют: входящие ЭСФ загружаются из ИС ЭСФ.' });
    if (doc.status !== 'POSTED') throw new AccError('ESF_NOT_POSTED', `Документ ${doc.number ?? ''} не проведён`, { fix: 'Проведите документ: ЭСФ выписывается только по документам, отражённым в учёте.' });
    const entry = await tx.accEntry.findFirst({ where: { organizationId, sourceType: TRADE_SOURCE, sourceId: doc.id, status: 'ACTIVE' } });
    if (!entry) throw new AccError('ESF_NOT_ACCOUNTED', `Документ ${doc.number ?? ''} ещё не отражён в бухгалтерии`, { fix: 'Дождитесь автопилота или исправьте проблему в разделе «Автопилот».', link: '/accounting/autopilot' });
    return doc;
  }

  private async vatPayerOn(tx: Tx, organizationId: string, date: Date) {
    const p = await tx.accPolicy.findFirst({ where: { organizationId, validFrom: { lte: date } }, orderBy: { validFrom: 'desc' } });
    return !!p?.vatPayer;
  }

  private async nextNum(tx: Tx, organizationId: string, date: Date) {
    const year = date.getUTCFullYear();
    const seq = await tx.accNumberSequence.upsert({
      where: { organizationId_docType_year: { organizationId, docType: 'ESF', year } },
      create: { organizationId, docType: 'ESF', year, last: 1 },
      update: { last: { increment: 1 } },
    });
    return `${year}${String(seq.last).padStart(6, '0')}`; // только цифры — требование XSD (A 1)
  }

  /** Данные ЭСФ из документа. Ошибки — понятным текстом с подсказкой, что заполнить. */
  async buildData(tx: Tx, organizationId: string, doc: Awaited<ReturnType<EsfService['accountedDoc']>>, num: string, issueDate: Date, operatorFullname: string, extra?: { invoiceType: 'ADDITIONAL_INVOICE'; related: { date: string; num: string; registrationNumber?: string } }): Promise<{ data: EsfInvoiceData; totals: { net: Prisma.Decimal; vat: Prisma.Decimal; gross: Prisma.Decimal } }> {
    const org = await tx.organization.findUnique({ where: { id: organizationId } });
    const s = await tx.esfSettings.findUnique({ where: { organizationId } });
    const problems: string[] = [];
    if (!org?.inn || !/^\d{12}$/.test(org.inn)) problems.push('у организации не указан БИН/ИИН (12 цифр) — «Настройки → Организация»');
    const vatPayer = await this.vatPayerOn(tx, organizationId, doc.date);
    if (vatPayer && !s?.vatRegistrationDate) problems.push('не указана дата постановки на учёт по НДС (графа B 9) — «ЭСФ → Настройки»');
    if (!s?.transportTypeCode) problems.push('не указан способ отправления (графа E 29) — «ЭСФ → Настройки»');
    const cp = doc.counterparty;
    if (!cp) problems.push('в документе не указан покупатель');
    else if (!cp.inn || !/^\d{12}$/.test(cp.inn)) problems.push(`у покупателя «${cp.name}» не указан ИИН/БИН (12 цифр)`);

    const tradeDoc: TradeDoc = { ...doc, organizationId, lines: doc.lines as any };
    // Дополнительный ЭСФ на возврат: суммовые графы и количество — разница со знаком «минус»; цена за единицу — без изменения
    const sg = extra ? -1 : 1;
    const sm = (v: Prisma.Decimal) => exact(v.times(sg));
    const products: EsfProduct[] = [];
    let net = new D(0), vat = new D(0), gross = new D(0);
    for (const l of doc.lines) {
      const a = await tradeLineAmounts(tx, tradeDoc, l as any, vatPayer);
      net = net.plus(a.net); vat = vat.plus(a.vat); gross = gross.plus(a.gross);
      const pa: any = (l.product.attributes as any)?.esf ?? {};
      const service = l.product.kind === 'SERVICE';
      const origin = service ? '6' : String(pa.truOriginCode ?? s?.defaultGoodsOrigin ?? '');
      if (!ORIGIN_CODES.includes(origin)) problems.push(`товар «${l.product.name}»: не задан признак происхождения (графа G 2) — укажите в карточке товара или признак по умолчанию в настройках ЭСФ`);
      if (['1', '2'].includes(origin)) problems.push(`товар «${l.product.name}»: признак ${origin} требует данных декларации/заявления о ввозе — такие ЭСФ пока выписываются в ИС ЭСФ вручную`);
      if (origin === '3' && !pa.tnvedCode) problems.push(`товар «${l.product.name}»: для признака 3 нужен код ТН ВЭД ЕАЭС (графа G 5)`);
      let unit: string | undefined;
      if (!service) {
        const cand = [l.product.uom?.code, l.product.uom?.shortName].find((c) => c && ESF_UNITS[c]);
        if (!cand) problems.push(`товар «${l.product.name}»: единица «${l.product.uom?.name ?? '?'}» не сопоставлена с классификатором ИС ЭСФ (графа G 6)`);
        unit = cand ?? undefined;
      }
      const qty = new D(l.qty);
      const rateNum = a.rate && !a.rate.isZero() ? a.rate.toNumber() : undefined;
      products.push({
        truOriginCode: origin,
        description: l.product.name,
        catalogTruId: String(pa.catalogTruId ?? '1'), // «1» — как в образце SDK КГД для товаров вне «Виртуального склада»
        unitCode: pa.tnvedCode ?? undefined,
        unitNomenclature: unit,
        quantity: service ? undefined : qty.times(sg).toFixed(),
        // Цена за единицу — производная величина (G 10), её округление до 6 знаков XSD допускает.
        unitPrice: service || qty.isZero() ? undefined : a.net.div(qty).toDecimalPlaces(6, D.ROUND_HALF_UP).toFixed(),
        priceWithoutTax: sm(a.net),
        turnoverSize: sm(a.net),
        ndsRate: rateNum,
        ndsAmount: sm(a.vat),
        priceWithTax: sm(a.gross),
        gtinCode: pa.gtinCode ?? undefined,
      });
    }
    if (!doc.lines.length) problems.push('в документе нет строк');
    if (problems.length) {
      throw new AccError('ESF_DATA_INCOMPLETE', `ЭСФ по документу ${doc.number ?? ''} не сформирован: ${problems.length === 1 ? problems[0] : 'не хватает данных'}`, { fix: problems.map((p) => `• ${p}`).join('\n'), details: { problems } });
    }

    let contract: { number: string; startDate: Date | null } | null = null;
    if (doc.contractId) contract = await tx.contract.findUnique({ where: { id: doc.contractId }, select: { number: true, startDate: true } });
    const paymentForm = (doc.attributes as any)?.paymentForm === 'CASH' ? 'CASH' : 'NON_CASH';

    const data: EsfInvoiceData = {
      date: esfDate(issueDate),
      invoiceType: extra?.invoiceType ?? 'ORDINARY_INVOICE',
      num,
      operatorFullname,
      relatedInvoice: extra?.related,
      turnoverDate: esfDate(doc.date),
      customers: [{ tin: cp!.inn!, name: cp!.fullName || cp!.name, countryCode: 'KZ' }],
      deliveryDocNum: doc.number ?? undefined,
      deliveryDocDate: doc.number ? esfDate(doc.date) : undefined,
      deliveryTerm: {
        hasContract: !!contract,
        contractNum: contract?.number,
        contractDate: contract?.startDate ? esfDate(contract.startDate) : undefined,
        paymentForm,
        transportTypeCode: s!.transportTypeCode!,
      },
      currencyCode: 'KZT',
      products,
      totals: { exciseAmount: '0.00', ndsAmount: sm(vat), priceWithTax: sm(gross), priceWithoutTax: sm(net), turnoverSize: sm(net) },
      sellers: [{ tin: org!.inn!, name: org!.name, address: org!.address ?? undefined, ndsRegistrationDate: vatPayer && s?.vatRegistrationDate ? esfDate(s.vatRegistrationDate) : undefined }],
    };
    return { data, totals: { net: net.times(sg), vat: vat.times(sg), gross: gross.times(sg) } };
  }

  /**
   * Основание для дополнительного ЭСФ по возврату: зарегистрированный основной ЭСФ реализации,
   * на основании которой оформлен возврат (attributes.baseId). Итог после всех дополнительных ЭСФ
   * не может стать отрицательным (п. 11 Пояснения к форме счёта-фактуры).
   */
  private async baseInvoiceFor(tx: Tx, organizationId: string, env: string, doc: Awaited<ReturnType<EsfService['accountedDoc']>>) {
    const baseId = (doc.attributes as any)?.baseId;
    if (!baseId) throw new AccError('ESF_RETURN_NO_BASE', `Возврат ${doc.number ?? ''} не привязан к реализации`, { fix: 'Оформите возврат «на основании» реализации — дополнительный ЭСФ выписывается к ЭСФ этой реализации.' });
    const base = await tx.esfInvoice.findFirst({ where: { organizationId, environment: env, direction: 'OUTBOUND', sourceDocId: baseId, invoiceType: { in: ['ORDINARY_INVOICE', 'FIXED_INVOICE'] }, registrationNumber: { not: null }, status: { notIn: ['REJECTED', 'CANCELLED', 'REVOKED', 'CANCELED', 'DECLINED'] } }, orderBy: { createdAt: 'desc' } });
    if (!base) throw new AccError('ESF_RETURN_BASE_NOT_REGISTERED', `По реализации, к которой оформлен возврат ${doc.number ?? ''}, нет зарегистрированного ЭСФ`, { fix: 'Сначала отправьте ЭСФ по реализации и дождитесь регистрационного номера («Обновить статусы»).' });
    return base;
  }

  private async operatorName(tx: Tx, ctx: OrgContext) {
    const s = await tx.esfSettings.findUnique({ where: { organizationId: ctx.organizationId } });
    if (s?.operatorFullname) return s.operatorFullname;
    if (ctx.userId && !ctx.userId.startsWith('system')) {
      const u: any = await tx.user.findUnique({ where: { id: ctx.userId } });
      const name = [u?.lastName, u?.firstName, u?.middleName].filter(Boolean).join(' ') || u?.name || u?.fullName;
      if (name) return String(name);
    }
    return '';
  }

  /**
   * Сформировать (или пересобрать) исходящий ЭСФ по проведённой реализации. Повторный вызов
   * для уже отправленного ЭСФ ничего не меняет. Дата выписки — день подписи (графа A 2).
   */
  async prepare(ctx: OrgContext, docId: string, issueDate = today()) {
    return this.prisma.$transaction(async (tx) => {
      const env = (await tx.esfSettings.findUnique({ where: { organizationId: ctx.organizationId } }))?.environment ?? 'TEST';
      const existing = await tx.esfInvoice.findFirst({ where: { organizationId: ctx.organizationId, environment: env, direction: 'OUTBOUND', sourceDocId: docId, status: { notIn: ['REJECTED', 'CANCELLED'] } }, orderBy: { createdAt: 'desc' } });
      if (existing && existing.status !== 'READY') return this.view(existing);
      const doc = await this.accountedDoc(tx, ctx.organizationId, docId);
      let extra: Parameters<EsfService['buildData']>[6];
      let base: Awaited<ReturnType<EsfService['baseInvoiceFor']>> | null = null;
      if (doc.docType === 'SALES_RETURN') {
        base = await this.baseInvoiceFor(tx, ctx.organizationId, env, doc);
        extra = { invoiceType: 'ADDITIONAL_INVOICE', related: { date: esfDate(base.date), num: base.num, registrationNumber: base.registrationNumber ?? undefined } };
      }
      const num = existing?.num ?? (await this.nextNum(tx, ctx.organizationId, issueDate));
      const { data, totals } = await this.buildData(tx, ctx.organizationId, doc, num, issueDate, await this.operatorName(tx, ctx), extra);
      if (base) {
        if (base.customerTin && data.customers[0].tin !== base.customerTin) throw new AccError('ESF_RETURN_CUSTOMER', 'Покупатель в возврате не совпадает с получателем в ЭСФ реализации', { fix: 'Проверьте покупателя в документе возврата.' });
        const others = await tx.esfInvoice.aggregate({ where: { organizationId: ctx.organizationId, environment: env, direction: 'OUTBOUND', relatedInvoiceId: base.id, id: existing ? { not: existing.id } : undefined, status: { notIn: ['REJECTED', 'CANCELLED', 'REVOKED', 'CANCELED', 'DECLINED'] } }, _sum: { totalWithTax: true } });
        const after = new D(base.totalWithTax).plus(others._sum.totalWithTax ?? 0).plus(totals.gross);
        if (after.lt(0)) throw new AccError('ESF_RETURN_EXCEEDS', `Возврат больше суммы ЭСФ реализации (останется ${money(after)})`, { fix: 'Сумма возвратов по одной реализации не может превышать сумму её ЭСФ.' });
      }
      let body: string;
      try {
        body = serializeInvoice(data, INVOICE_VERSION).xml;
      } catch (e) {
        if (!(e instanceof EsfSerializationError)) throw e;
        throw new AccError(e.code, `ЭСФ по документу ${doc.number ?? ''} не сформирован: данные не проходят проверку формы ${INVOICE_VERSION}`, { fix: e.errors.map((x) => `• ${x.path}: ${x.message}`).join('\n'), details: { errors: e.errors } });
      }
      const row = {
        organizationId: ctx.organizationId, environment: env, direction: 'OUTBOUND', sourceDocId: doc.id, invoiceType: data.invoiceType, relatedInvoiceId: base?.id ?? null, num,
        date: issueDate, turnoverDate: doc.date, sellerTin: data.sellers[0].tin, sellerName: data.sellers[0].name,
        customerTin: data.customers[0].tin, customerName: data.customers[0].name, counterpartyId: doc.counterpartyId,
        totalWithoutTax: totals.net, totalNds: totals.vat, totalWithTax: totals.gross, status: 'READY', body, bodyHash: sha256(body), errors: Prisma.DbNull, outdated: false,
      };
      const saved = existing
        ? await tx.esfInvoice.update({ where: { id: existing.id }, data: row })
        : await tx.esfInvoice.create({ data: row });
      return this.view(saved);
    });
  }

  // ── Список и карточка ──

  private view(r: any) {
    return { ...r, esfId: r.esfId?.toString() ?? null };
  }

  async list(ctx: OrgContext, q: any) {
    const env = (await this.prisma.esfSettings.findUnique({ where: { organizationId: ctx.organizationId } }))?.environment ?? 'TEST';
    const where: Prisma.EsfInvoiceWhereInput = { organizationId: ctx.organizationId, environment: env };
    if (q.direction) where.direction = q.direction;
    if (q.status) where.status = { in: String(q.status).split(',') };
    if (q.search) where.OR = [{ num: { contains: q.search } }, { registrationNumber: { contains: q.search } }, { customerName: { contains: q.search, mode: 'insensitive' } }, { sellerName: { contains: q.search, mode: 'insensitive' } }];
    const page = Math.max(1, Number(q.page) || 1), limit = Math.min(200, Number(q.limit) || 50);
    const [items, total] = await Promise.all([
      this.prisma.esfInvoice.findMany({ where, orderBy: [{ date: 'desc' }, { num: 'desc' }], skip: (page - 1) * limit, take: limit, select: { id: true, direction: true, invoiceType: true, num: true, date: true, turnoverDate: true, sellerTin: true, sellerName: true, customerTin: true, customerName: true, totalWithoutTax: true, totalNds: true, totalWithTax: true, status: true, esfStatus: true, esfId: true, registrationNumber: true, errors: true, outdated: true, sourceDocId: true, sentAt: true, cancelReason: true, relatedInvoiceId: true } }),
      this.prisma.esfInvoice.count({ where }),
    ]);
    // Реализации, по которым ЭСФ ещё не сформирован
    const pending = await this.pendingDocs(this.prisma, ctx.organizationId, env, 20);
    return { items: items.map((i) => this.view(i)), total, page, limit, pending };
  }

  async get(ctx: OrgContext, id: string) {
    const r = await this.prisma.esfInvoice.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!r) throw new AccError('NOT_FOUND', 'ЭСФ не найден', { status: 404 });
    let parsed: any = null;
    try { parsed = parseInvoice(r.body); } catch { /* тело ЭСФ показываем как есть */ }
    return { ...this.view(r), parsed };
  }

  /** Проведённые реализации с действующими проводками без ЭСФ. */
  private async pendingDocs(db: Tx | PrismaService, organizationId: string, env: string, limit: number) {
    return (db as any).$queryRawUnsafe(
      `SELECT d.id, d.doc_type AS "docType", d.number, d.date, d.total, c.name AS counterparty, c.inn AS "counterpartyTin"
         FROM documents d
         LEFT JOIN counterparties c ON c.id = d.counterparty_id
        WHERE d.organization_id = $1 AND d.doc_type = ANY($2::"DocType"[]) AND d.status = 'POSTED' AND d.deleted = false
          AND EXISTS (SELECT 1 FROM acc_entries e WHERE e.organization_id = d.organization_id AND e.source_type = $3 AND e.source_id = d.id AND e.status = 'ACTIVE')
          AND NOT EXISTS (SELECT 1 FROM esf_invoices i WHERE i.source_doc_id = d.id AND i.environment = $4 AND i.direction = 'OUTBOUND' AND i.status NOT IN ('CANCELLED'))
        ORDER BY d.date DESC LIMIT ${Number(limit)}`,
      organizationId, ESF_SOURCE_TYPES, TRADE_SOURCE, env,
    ) as Promise<any[]>;
  }

  // ── Сессия ──

  private async activeSession(db: Tx | PrismaService, organizationId: string, environment: string) {
    return (db as any).esfSession.findFirst({ where: { organizationId, environment, closedAt: null }, orderBy: { createdAt: 'desc' } }) as Promise<{ id: string; sessionId: string; iin: string; tin: string; createdAt: Date } | null>;
  }

  private async requireSession(organizationId: string) {
    const s = await this.prisma.esfSettings.findUnique({ where: { organizationId } });
    const env = s?.environment ?? 'TEST';
    const session = await this.activeSession(this.prisma, organizationId, env);
    if (!session) throw new AccError('ESF_NO_SESSION', 'Нет входа в ИС ЭСФ', { fix: 'Нажмите «Войти в ИС ЭСФ» и подпишите вход ключом ЭЦП (NCALayer).' });
    return { env, session };
  }

  private async closeLocal(id: string) {
    await this.prisma.esfSession.update({ where: { id }, data: { closedAt: new Date() } });
  }

  /** Тикет для входа: подписывается ключом AUTH в NCALayer (XMLDSig) на компьютере владельца ЭЦП. */
  async ticket(ctx: OrgContext) {
    const s = await this.prisma.esfSettings.findUnique({ where: { organizationId: ctx.organizationId } });
    if (!s?.signerIin) throw new AccError('ESF_IIN', 'Не указан ИИН владельца ЭЦП', { fix: 'Укажите ИИН подписанта в настройках ЭСФ.' });
    const ticket = await this.wrap(() => this.client(s.environment).createAuthTicket(s.signerIin!));
    return { environment: s.environment, iin: s.signerIin, ticket };
  }

  async openSession(ctx: OrgContext, signedTicket: string) {
    if (!signedTicket || !signedTicket.includes('Signature')) throw new AccError('ESF_BAD_TICKET', 'Подписанный тикет не получен', { fix: 'Повторите вход и подпишите тикет ключом аутентификации (AUTH).' });
    const s = await this.prisma.esfSettings.findUnique({ where: { organizationId: ctx.organizationId } });
    const org = await this.prisma.organization.findUnique({ where: { id: ctx.organizationId } });
    if (!s?.signerIin) throw new AccError('ESF_IIN', 'Не указан ИИН владельца ЭЦП');
    if (!org?.inn) throw new AccError('ESF_TIN', 'У организации не указан БИН/ИИН');
    const sessionId = await this.wrap(() => this.client(s.environment).createSessionSigned(org.inn!, signedTicket));
    await this.prisma.esfSession.updateMany({ where: { organizationId: ctx.organizationId, environment: s.environment, closedAt: null }, data: { closedAt: new Date() } });
    const row = await this.prisma.esfSession.create({ data: { organizationId: ctx.organizationId, environment: s.environment, sessionId, iin: s.signerIin, tin: org.inn, openedBy: ctx.userId } });
    await this.prisma.auditLog.create({ data: { userId: ctx.userId, organizationId: ctx.organizationId, action: 'ESF_SESSION_OPEN', entity: 'esf_session', entityId: row.id, after: { environment: s.environment, iin: s.signerIin, tin: org.inn } as any } });
    return { environment: s.environment, iin: s.signerIin, openedAt: row.createdAt };
  }

  async closeSession(ctx: OrgContext) {
    const { env, session } = await this.requireSession(ctx.organizationId);
    try { await this.client(env).closeSession(session.sessionId); } catch { /* сессия могла уже истечь */ }
    await this.closeLocal(session.id);
    return { closed: true };
  }

  /** Вызов ИС ЭСФ с понятной ошибкой для пользователя. */
  private async wrap<T>(fn: () => Promise<T>, sessionRowId?: string): Promise<T> {
    try {
      return await fn();
    } catch (e: any) {
      if (e instanceof EsfSoapError) {
        if (e.sessionClosed && sessionRowId) await this.closeLocal(sessionRowId);
        const fix = e.sessionClosed ? 'Войдите в ИС ЭСФ заново (подпись ключом ЭЦП).' : e.code === 'NETWORK' ? 'Проверьте связь и повторите — данные не потеряны.' : e.code === 'SECURITY_ERROR' ? 'ИС ЭСФ не приняла подпись: проверьте, что выбран действующий ключ AUTH этого ИИН.' : undefined;
        throw new AccError(`ESF_${e.code}`, `ИС ЭСФ: ${e.message}`, { fix, status: e.code === 'NETWORK' ? 503 : 422 });
      }
      throw e;
    }
  }

  // ── Подпись и отправка ──

  /**
   * Данные для подписи: пересобирает ЭСФ в статусе READY из текущего документа с датой выписки
   * «сегодня» и возвращает тела. Подписывается ровно строка body (UTF-8) ключом подписи (RSA/ГОСТ).
   */
  async signData(ctx: OrgContext, ids: string[]) {
    if (!ids?.length) throw new AccError('ESF_EMPTY', 'Не выбраны ЭСФ');
    const found = await this.prisma.esfInvoice.findMany({ where: { id: { in: ids }, organizationId: ctx.organizationId, direction: 'OUTBOUND' } });
    const rows = ids.map((id) => found.find((r) => r.id === id)).filter((r): r is (typeof found)[number] => !!r);
    const out: { id: string; num: string; body: string; bytesSha256: string; signingToken: string; expiresAt: Date }[] = [];
    const secret = (() => { try { return signingSecret(); } catch (e) { return signingError(e); } })();
    for (const r of rows) {
      if (r.status !== 'READY') throw new AccError('ESF_STATUS', `ЭСФ № ${r.num} уже отправлен (статус ${r.status})`);
      const fresh = r.sourceDocId ? await this.prepare(ctx, r.sourceDocId, today()) : r;
      // Подписывается ровно эта строка; запрос на подпись привязан к её хэшу, пользователю и сроку.
      const req = issueSigningRequest(secret, { organizationId: ctx.organizationId, userId: String(ctx.userId), kind: 'INVOICE', subjectId: fresh.id }, fresh.body);
      out.push({ id: fresh.id, num: fresh.num, body: fresh.body, bytesSha256: req.bytesSha256, signingToken: req.token, expiresAt: req.expiresAt });
    }
    return { version: INVOICE_VERSION, items: out };
  }

  async upload(ctx: OrgContext, b: { certificate: string; items: { id: string; signature: string; signingToken?: string }[] }) {
    const { env, session } = await this.requireSession(ctx.organizationId);
    const s = await this.prisma.esfSettings.findUnique({ where: { organizationId: ctx.organizationId } });
    if (!b?.certificate) throw new AccError('ESF_CERT', 'Не передан сертификат подписи');
    if (!b.items?.length) throw new AccError('ESF_EMPTY', 'Нет подписанных ЭСФ');
    const rows = await this.prisma.esfInvoice.findMany({ where: { id: { in: b.items.map((i) => i.id) }, organizationId: ctx.organizationId, status: 'READY' } });
    if (rows.length !== b.items.length) throw new AccError('ESF_STATUS', 'Часть ЭСФ уже отправлена или изменена — обновите список и подпишите заново');
    const byId = new Map(rows.map((r) => [r.id, r]));
    const items = b.items.map((i) => {
      if (!i.signature || i.signature.length > 400) throw new AccError('ESF_SIGNATURE', 'Подпись ЭСФ должна быть «сырой» подписью (до 400 символов base64)', { fix: 'Подписывайте через NCALayer в режиме raw ключом подписи (не AUTH).' });
      const r = byId.get(i.id)!;
      return { row: r, body: r.body, signature: i.signature, signingToken: i.signingToken, signatureType: s?.signatureType ?? 'COMPANY', version: INVOICE_VERSION };
    });
    const evidence = await this.checkSignatures(ctx, s, b.certificate, items.map((it) => ({ kind: 'INVOICE' as const, subjectId: it.row.id, label: `ЭСФ № ${it.row.num}`, bytes: it.body, signature: it.signature, token: it.signingToken })));
    const cert = stripPem(b.certificate);
    const ids = items.map((i) => i.row.id);

    // FP-017: до сети — атомарный захват READY → SENDING. Метка захвата (sentAt) — fencing для результата.
    const claimAt = new Date();
    await this.prisma.$transaction(async (tx) => {
      const c = await tx.esfInvoice.updateMany({ where: { id: { in: ids }, organizationId: ctx.organizationId, status: 'READY' }, data: { status: 'SENDING', sentAt: claimAt, sentBy: ctx.userId, certificate: cert } });
      if (c.count !== ids.length) throw new AccError('ESF_STATUS', 'Часть ЭСФ уже отправляется или отправлена — обновите список');
      for (const it of items) await tx.esfInvoice.update({ where: { id: it.row.id }, data: { signature: it.signature } });
      await tx.auditLog.create({ data: { userId: ctx.userId, organizationId: ctx.organizationId, action: 'ESF_SEND_STARTED', entity: 'esf_invoice', entityId: ids.join(','), after: { environment: env, claimAt: claimAt.toISOString(), signing: evidence } as any } });
    });
    const fenced = (id: string) => ({ id, organizationId: ctx.organizationId, status: 'SENDING', sentAt: claimAt });

    let res: Awaited<ReturnType<EsfSoapClient['syncInvoice']>>;
    try {
      res = await this.client(env).syncInvoice(session.sessionId, cert, items);
    } catch (e: any) {
      // Только отказ до обработки (нет сессии/доступа/подпись входа) доказывает, что ЭСФ не приняты.
      const notProcessed = e instanceof EsfSoapError && (e.sessionClosed || e.code === 'ACCESS_DENIED' || e.code === 'SECURITY_ERROR');
      const data = notProcessed
        ? { status: 'READY', sentAt: null, sentBy: null, signature: null, certificate: null }
        : { status: 'UNKNOWN', errors: [{ errorCode: 'OUTCOME_UNKNOWN', text: `Ответ ИС ЭСФ не получен (${e instanceof EsfSoapError ? e.code : 'ERROR'}) — ЭСФ мог быть принят. Повторная отправка заблокирована до сверки.` }] as any };
      for (const id of ids) await this.prisma.esfInvoice.updateMany({ where: fenced(id), data });
      await this.prisma.auditLog.create({ data: { userId: ctx.userId, organizationId: ctx.organizationId, action: notProcessed ? 'ESF_SEND_NOT_PROCESSED' : 'ESF_SEND_OUTCOME_UNKNOWN', entity: 'esf_invoice', entityId: ids.join(','), after: { environment: env, claimAt: claimAt.toISOString(), error: e instanceof EsfSoapError ? e.code : 'ERROR' } as any } });
      return this.wrap(() => Promise.reject(e), session.id);
    }

    const key = (num: string, date: string) => `${num}|${date}`;
    const acc = new Map(res.accepted.map((a) => [key(a.num, a.date), a]));
    const dec = new Map(res.declined.map((a) => [key(a.num, a.date), a]));
    const result: any[] = [];
    let unknown = 0;
    for (const it of items) {
      const k = key(it.row.num, esfDate(it.row.date));
      const a = acc.get(k), d = dec.get(k);
      const data: any = {};
      if (a) Object.assign(data, { status: 'SENT', esfStatus: 'IN_QUEUE', esfId: a.id ? BigInt(a.id) : null, errors: a.errors.length ? a.errors : Prisma.DbNull });
      else if (d) Object.assign(data, { status: 'REJECTED', errors: d.errors });
      else { unknown++; Object.assign(data, { status: 'UNKNOWN', esfStatus: null, errors: [{ errorCode: 'OUTCOME_UNKNOWN', text: 'ИС ЭСФ не вернула результат по этому ЭСФ — статус уточняется сверкой по дате и номеру' }] }); }
      // Результат применяется, только если строку не перехватил другой процесс/восстановление.
      const applied = (await this.prisma.esfInvoice.updateMany({ where: fenced(it.row.id), data })).count === 1;
      const upd = await this.prisma.esfInvoice.findUniqueOrThrow({ where: { id: it.row.id } });
      result.push({ id: upd.id, num: upd.num, status: upd.status, errors: upd.errors, fenced: !applied });
    }
    await this.prisma.auditLog.create({ data: { userId: ctx.userId, organizationId: ctx.organizationId, action: 'ESF_UPLOAD', entity: 'esf_invoice', entityId: ids.join(','), after: { environment: env, accepted: res.accepted.length, declined: res.declined.length, unknown, signing: evidence } as any } });
    return { accepted: res.accepted.length, declined: res.declined.length, unknown, items: result };
  }

  /** FP-017: процесс упал/завис после захвата — истёкший SENDING становится UNKNOWN, а не READY. */
  async recoverStaleSending(organizationId?: string, now = new Date()) {
    const before = new Date(now.getTime() - EsfService.SEND_LEASE_MS);
    const stale = await this.prisma.esfInvoice.findMany({ where: { ...(organizationId ? { organizationId } : {}), direction: 'OUTBOUND', status: 'SENDING', sentAt: { lt: before } }, select: { id: true, organizationId: true, sentAt: true } });
    for (const r of stale) {
      const c = await this.prisma.esfInvoice.updateMany({ where: { id: r.id, status: 'SENDING', sentAt: r.sentAt }, data: { status: 'UNKNOWN', errors: [{ errorCode: 'RECOVERED_UNKNOWN', text: 'Отправка прервалась (сбой или перезапуск) — ЭСФ мог быть принят. Повторная отправка заблокирована до сверки.' }] as any } });
      if (c.count) await this.prisma.auditLog.create({ data: { userId: null, organizationId: r.organizationId, action: 'ESF_SEND_RECOVERED_UNKNOWN', entity: 'esf_invoice', entityId: r.id, after: { sentAt: r.sentAt?.toISOString() } as any } });
    }
    return stale.length;
  }

  /**
   * FP-017: оператор явно разрешает повторную отправку UNKNOWN-ЭСФ — только если сверка по ключу
   * после «тихого» периода не нашла документ в ИС ЭСФ. Причина и автор — в журнале.
   */
  async releaseUnknown(ctx: OrgContext, id: string, reason: string) {
    if (!String(reason ?? '').trim() || String(reason).trim().length < 5) throw new AccError('ESF_REASON', 'Укажите причину (не короче 5 символов)');
    const r = await this.prisma.esfInvoice.findFirst({ where: { id, organizationId: ctx.organizationId, direction: 'OUTBOUND' } });
    if (!r) throw new AccError('NOT_FOUND', 'ЭСФ не найден', { status: 404 });
    if (r.status !== 'UNKNOWN') throw new AccError('ESF_STATUS', `Разрешить повторную отправку можно только для ЭСФ с неизвестным результатом (сейчас ${r.status})`);
    const quietFrom = new Date((r.sentAt ?? r.updatedAt).getTime() + EsfService.RECONCILE_QUIET_MS);
    const proof = await this.prisma.auditLog.findFirst({ where: { organizationId: ctx.organizationId, action: 'ESF_RECONCILE_NOT_FOUND', entityId: r.id, ts: { gte: quietFrom } }, orderBy: { ts: 'desc' } });
    if (!proof) throw new AccError('ESF_RECONCILE_REQUIRED', 'Нет доказательства, что ИС ЭСФ не приняла этот ЭСФ', { fix: `Нажмите «Обновить статусы» не раньше ${quietFrom.toISOString().slice(0, 16).replace('T', ' ')} UTC: сверка по дате и номеру должна не найти ЭСФ. Если найдёт — статус обновится сам.` });
    const c = await this.prisma.esfInvoice.updateMany({ where: { id: r.id, status: 'UNKNOWN' }, data: { status: 'READY', sentAt: null, sentBy: null, signature: null, certificate: null, errors: Prisma.DbNull } });
    if (!c.count) throw new AccError('ESF_STATUS', 'Статус ЭСФ изменился — обновите список');
    await this.prisma.auditLog.create({ data: { userId: ctx.userId, organizationId: ctx.organizationId, action: 'ESF_UNKNOWN_RELEASED', entity: 'esf_invoice', entityId: r.id, reason: String(reason).trim(), after: { num: r.num, date: esfDate(r.date), sentAt: r.sentAt?.toISOString(), proofAuditId: proof.id } as any } });
    return { id: r.id, status: 'READY' };
  }

  /**
   * FP-016: до сети — запрос на подпись выдан этому пользователю и не устарел, подписаны ровно текущие
   * байты, сертификат действует, это ключ подписи нужного ИИН/БИН, а RSA-подпись сходится с байтами.
   */
  private async checkSignatures(ctx: OrgContext, settings: { signerIin: string | null; signatureType: string } | null, certificate: string, items: { kind: 'INVOICE' | 'ACTION'; subjectId: string; label: string; bytes: string; signature: string; token?: string }[]) {
    try {
      const secret = signingSecret();
      const hashes = items.map((it) => verifySigningRequest(secret, it.token, { organizationId: ctx.organizationId, userId: String(ctx.userId), kind: it.kind, subjectId: it.subjectId }, it.bytes).bytesSha256);
      const cert = inspectCertificate(certificate);
      const org = await this.prisma.organization.findUnique({ where: { id: ctx.organizationId }, select: { inn: true } });
      const problems = checkSigner(cert, { signerIin: settings?.signerIin, organizationBin: org?.inn, signatureType: settings?.signatureType ?? 'COMPANY' });
      if (problems.length) throw new EsfSigningError('ESF_SIGNER_NOT_AUTHORIZED', 'Сертификат не подходит для подписи ЭСФ этой организации', problems);
      return items.map((it, k) => {
        const v = verifyRawSignature(cert, it.bytes, it.signature);
        if (v === 'INVALID') throw new EsfSigningError('ESF_SIGNATURE_INVALID', `${it.label}: подпись не соответствует подписываемым данным или сертификату — подпишите заново`);
        return { subjectId: it.subjectId, ...signingEvidence(cert, v, hashes[k]) };
      });
    } catch (e) {
      return signingError(e);
    }
  }

  /** «Отказаться» от ЭСФ, который ещё не отправлен (например, документ будет исправлен). */
  async discard(ctx: OrgContext, id: string) {
    const r = await this.prisma.esfInvoice.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!r) throw new AccError('NOT_FOUND', 'ЭСФ не найден', { status: 404 });
    if (!['READY', 'REJECTED'].includes(r.status)) throw new AccError('ESF_STATUS', 'Отправленный ЭСФ отменяется отзывом или исправленным ЭСФ в ИС ЭСФ', { fix: 'Отзыв и исправленные ЭСФ из FlowPOS пока не поддерживаются — выполните их в ИС ЭСФ.' });
    await this.prisma.esfInvoice.update({ where: { id }, data: { status: 'CANCELLED' } });
    return { ok: true };
  }

  // ── Отзыв, отклонение, подтверждение (подпись списка id в NCALayer) ──

  /** Что разрешено ИС ЭСФ (описание операций InvoiceService). */
  private static ACTIONS: Record<EsfAction, { direction: string; when: (r: any) => boolean; needReason: boolean; label: string }> = {
    // revokeInvoiceById: только ORDINARY_INVOICE; отозвать незарегистрированный ЭСФ нельзя (п. 13 Пояснения)
    REVOKE: { direction: 'OUTBOUND', needReason: true, label: 'отзыв', when: (r) => r.invoiceType === 'ORDINARY_INVOICE' && !!r.esfId && !!r.registrationNumber && ['SENT', 'CREATED', 'DELIVERED'].includes(r.status) && !['REVOKED', 'WAITING_CUSTOMER_REVOKE_CONFIRMATION', 'CANCELED'].includes(r.esfStatus ?? '') },
    // declineInvoiceById / approveInvoiceById: только FIXED/ADDITIONAL в ожидании подтверждения получателем
    DECLINE: { direction: 'INBOUND', needReason: true, label: 'отклонение', when: (r) => ['FIXED_INVOICE', 'ADDITIONAL_INVOICE'].includes(r.invoiceType) && (r.esfStatus === 'WAITING_CUSTOMER_CONFIRMATION' || r.status === 'WAITING_CUSTOMER_CONFIRMATION') },
    APPROVE: { direction: 'INBOUND', needReason: false, label: 'подтверждение', when: (r) => ['FIXED_INVOICE', 'ADDITIONAL_INVOICE'].includes(r.invoiceType) && (r.esfStatus === 'WAITING_CUSTOMER_CONFIRMATION' || r.status === 'WAITING_CUSTOMER_CONFIRMATION') },
    CONFIRM_REVOKE: { direction: 'INBOUND', needReason: false, label: 'подтверждение отзыва', when: (r) => r.esfStatus === 'WAITING_CUSTOMER_REVOKE_CONFIRMATION' || r.status === 'WAITING_CUSTOMER_REVOKE_CONFIRMATION' },
  };

  private async actionRows(ctx: OrgContext, action: EsfAction, ids: string[], reason?: string) {
    const def = EsfService.ACTIONS[action];
    if (!def) throw new AccError('ESF_ACTION', 'Неизвестное действие с ЭСФ');
    if (!ids?.length) throw new AccError('ESF_EMPTY', 'Не выбраны ЭСФ');
    if (def.needReason && !String(reason ?? '').trim()) throw new AccError('ESF_REASON', `Для операции «${def.label}» нужна причина`);
    const rows = await this.prisma.esfInvoice.findMany({ where: { id: { in: ids }, organizationId: ctx.organizationId, direction: def.direction } });
    if (rows.length !== ids.length) throw new AccError('NOT_FOUND', 'ЭСФ не найдены', { status: 404 });
    const bad = rows.filter((r) => !def.when(r));
    if (bad.length) throw new AccError('ESF_ACTION_NOT_ALLOWED', `Операция «${def.label}» недоступна для ЭСФ № ${bad.map((b) => b.num).join(', ')}`, { fix: action === 'REVOKE' ? 'Отозвать можно только основной ЭСФ с регистрационным номером. Исправленные и дополнительные ЭСФ корректируются новым дополнительным ЭСФ.' : 'Обновите статусы: действие доступно, пока ЭСФ ждёт вашего подтверждения.' });
    return { def, rows };
  }

  private signable(action: EsfAction, rows: { esfId: bigint | null }[], reason?: string) {
    const ids = rows.map((r) => r.esfId!.toString());
    return action === 'REVOKE' || action === 'DECLINE' ? signableIdWithReasonList(ids.map((id) => ({ id, reason: String(reason).trim() }))) : signableIdList(ids);
  }

  /** Строка для подписи «сырой» подписью ключом подписи (как generateSignature/signIdList в SDK). */
  async actionData(ctx: OrgContext, b: { action: EsfAction; ids: string[]; reason?: string }) {
    const { rows } = await this.actionRows(ctx, b.action, b.ids, b.reason);
    const data = this.signable(b.action, rows, b.reason);
    const secret = (() => { try { return signingSecret(); } catch (e) { return signingError(e); } })();
    const req = issueSigningRequest(secret, { organizationId: ctx.organizationId, userId: String(ctx.userId), kind: 'ACTION', subjectId: this.actionSubject(b.action, rows) }, data);
    return { action: b.action, data, bytesSha256: req.bytesSha256, signingToken: req.token, expiresAt: req.expiresAt };
  }

  private actionSubject(action: EsfAction, rows: { id: string }[]) {
    return `${action}:${rows.map((r) => r.id).sort().join(',')}`;
  }

  async action(ctx: OrgContext, b: { action: EsfAction; ids: string[]; reason?: string; signature: string; certificate: string; signingToken?: string }) {
    const { def, rows } = await this.actionRows(ctx, b.action, b.ids, b.reason);
    if (!b.signature || !b.certificate) throw new AccError('ESF_SIGNATURE', 'Нет подписи или сертификата');
    const { env, session } = await this.requireSession(ctx.organizationId);
    const settings = await this.prisma.esfSettings.findUnique({ where: { organizationId: ctx.organizationId } });
    const evidence = await this.checkSignatures(ctx, settings, b.certificate, [{ kind: 'ACTION', subjectId: this.actionSubject(b.action, rows), label: `Операция «${def.label}»`, bytes: this.signable(b.action, rows, b.reason), signature: b.signature, token: b.signingToken }]);
    const client = this.client(env);
    const cert = stripPem(b.certificate);
    const reason = String(b.reason ?? '').trim();
    const ids = rows.map((r) => r.esfId!.toString());
    const res = await this.wrap(() => {
      switch (b.action) {
        case 'REVOKE': return client.changeWithReason('revokeInvoiceById', session.sessionId, b.signature, cert, ids.map((id) => ({ id, reason })));
        case 'DECLINE': return client.changeWithReason('declineInvoiceById', session.sessionId, b.signature, cert, ids.map((id) => ({ id, reason })));
        case 'APPROVE': return client.changeByIds('approveInvoiceById', session.sessionId, b.signature, cert, ids);
        case 'CONFIRM_REVOKE': return client.changeByIds('revokeConfirmInvoiceById', session.sessionId, b.signature, cert, ids);
      }
    }, session.id);
    const out: any[] = [];
    for (const r of rows) {
      const c = res.find((x) => x.invoiceId === r.esfId!.toString());
      const st = c?.invoiceStatus;
      const data: any = { lastUpdateAt: new Date() };
      if (c?.isChanged && st) {
        data.esfStatus = st;
        // окончательные статусы — в локальный статус; промежуточные (ждёт подтверждения) — продолжаем опрос
        data.status = FINAL_ESF.includes(st) ? st : r.direction === 'OUTBOUND' ? 'SENT' : st;
        if (b.action === 'REVOKE' || b.action === 'DECLINE') data.cancelReason = reason;
        data.errors = Prisma.DbNull;
      } else if (c) {
        data.errors = [{ errorCode: c.errorCode, text: c.errorText ?? 'ИС ЭСФ не изменила статус' }];
      }
      const u = await this.prisma.esfInvoice.update({ where: { id: r.id }, data });
      out.push({ id: u.id, num: u.num, changed: !!c?.isChanged, status: u.status, esfStatus: u.esfStatus, error: c?.isChanged ? null : c?.errorText ?? c?.errorCode ?? 'нет ответа по ЭСФ' });
    }
    await this.prisma.auditLog.create({ data: { userId: ctx.userId, organizationId: ctx.organizationId, action: `ESF_${b.action}`, entity: 'esf_invoice', entityId: rows.map((r) => r.id).join(','), reason: reason || null, after: { environment: env, results: out, signing: evidence } as any } });
    return { action: b.action, label: def.label, changed: out.filter((o) => o.changed).length, items: out };
  }

  // ── Статусы и входящие ──

  async refresh(ctx: OrgContext) {
    const { env, session } = await this.requireSession(ctx.organizationId);
    return this.refreshWith(ctx.organizationId, env, session);
  }

  private async refreshWith(organizationId: string, env: string, session: { id: string; sessionId: string }) {
    const client = this.client(env);
    // 1) FP-017: результат неизвестен — сверка ТОЛЬКО по ключу (дата выписки + номер). Не найден → остаётся UNKNOWN.
    await this.recoverStaleSending(organizationId);
    const noId = await this.prisma.esfInvoice.findMany({ where: { organizationId, environment: env, direction: 'OUTBOUND', OR: [{ status: 'UNKNOWN' }, { status: 'SENT', esfId: null }] }, take: 50 });
    if (noId.length) {
      const found = await this.wrap(() => client.queryInvoiceSummaryByKey(session.sessionId, 'OUTBOUND', noId.map((r) => ({ date: esfDate(r.date), num: r.num }))), session.id);
      for (const r of noId) {
        const f = found.find((x) => String(x.num) === r.num && (!x.date || String(x.date) === esfDate(r.date)) && x.invoiceId);
        if (f) {
          const c = await this.prisma.esfInvoice.updateMany({ where: { id: r.id, status: r.status }, data: { status: 'SENT', esfId: BigInt(f.invoiceId), esfStatus: f.invoiceStatus ?? null, registrationNumber: f.registrationNumber ?? null, errors: Prisma.DbNull } });
          if (c.count) await this.prisma.auditLog.create({ data: { userId: null, organizationId, action: 'ESF_RECONCILE_FOUND', entity: 'esf_invoice', entityId: r.id, after: { num: r.num, date: esfDate(r.date), invoiceId: String(f.invoiceId), invoiceStatus: f.invoiceStatus ?? null } as any } });
        } else if (r.status === 'UNKNOWN') {
          await this.prisma.auditLog.create({ data: { userId: null, organizationId, action: 'ESF_RECONCILE_NOT_FOUND', entity: 'esf_invoice', entityId: r.id, after: { num: r.num, date: esfDate(r.date) } as any } });
        }
      }
    }
    // 2) Статусы отправленных
    const open = await this.prisma.esfInvoice.findMany({ where: { organizationId, environment: env, direction: 'OUTBOUND', status: 'SENT', esfId: { not: null } }, take: 100 });
    let updated = 0;
    if (open.length) {
      const sums = await this.wrap(() => client.queryInvoiceSummaryById(session.sessionId, open.map((r) => r.esfId!.toString())), session.id);
      const failed: string[] = [];
      for (const sm of sums) {
        const r = open.find((x) => x.esfId!.toString() === String(sm.invoiceId));
        if (!r) continue;
        const st = sm.invoiceStatus ?? r.esfStatus;
        const data: any = { esfStatus: st, registrationNumber: sm.registrationNumber ?? r.registrationNumber, cancelReason: sm.cancelReason ?? null, lastUpdateAt: sm.lastUpdateDate ? new Date(sm.lastUpdateDate) : new Date() };
        if (st === 'FAILED') { data.status = 'REJECTED'; failed.push(String(sm.invoiceId)); }
        else if (st && FINAL_ESF.includes(st)) data.status = st;
        await this.prisma.esfInvoice.update({ where: { id: r.id }, data });
        updated++;
      }
      if (failed.length) {
        const errs = await this.wrap(() => client.queryInvoiceErrorById(session.sessionId, failed), session.id);
        for (const e of errs) await this.prisma.esfInvoice.updateMany({ where: { organizationId, environment: env, direction: 'OUTBOUND', esfId: BigInt(e.invoiceId) }, data: { errors: e.errors as any } });
      }
    }
    const inbound = await this.importInbound(organizationId, env, session);
    return { updated, inbound };
  }

  /** Входящие ЭСФ (queryUpdates INBOUND) → реестр; сопоставление с поставщиком по БИН. */
  private async importInbound(organizationId: string, env: string, session: { id: string; sessionId: string }) {
    const client = this.client(env);
    const s = await this.prisma.esfSettings.findUnique({ where: { organizationId } });
    let lastEvent = s?.inboundLastEventAt ?? new Date(Date.now() - 30 * 86400000);
    let lastId = s?.inboundLastId?.toString() ?? null;
    let imported = 0;
    const toConfirm: string[] = [];
    for (let guard = 0; guard < 20; guard++) {
      const r = await this.wrap(() => client.queryUpdates(session.sessionId, 'INBOUND', lastEvent, lastId), session.id);
      for (const info of r.items) {
        if (!info.invoiceId) continue;
        let p;
        try { p = parseInvoice(info.invoiceBody); } catch { continue; }
        const cp = p.seller.tin ? await this.prisma.counterparty.findFirst({ where: { inn: p.seller.tin, deleted: false, OR: [{ organizationId }, { organizationId: null }] } }) : null;
        const data = {
          organizationId, environment: env, direction: 'INBOUND', invoiceType: p.invoiceType, num: p.num || String(info.invoiceId),
          date: p.date ? parseEsfDate(p.date) : new Date(), turnoverDate: p.turnoverDate ? parseEsfDate(p.turnoverDate) : new Date(),
          sellerTin: p.seller.tin ?? null, sellerName: p.seller.name ?? null, customerTin: p.customer.tin ?? null, customerName: p.customer.name ?? null,
          counterpartyId: cp?.id ?? null, currency: p.currencyCode, totalWithoutTax: new D(p.totals.priceWithoutTax), totalNds: new D(p.totals.ndsAmount), totalWithTax: new D(p.totals.priceWithTax),
          status: info.invoiceStatus ?? 'CREATED', esfStatus: info.invoiceStatus ?? null, esfId: BigInt(info.invoiceId), registrationNumber: info.registrationNumber ?? null,
          body: info.invoiceBody, bodyHash: sha256(info.invoiceBody), cancelReason: info.cancelReason ?? null, lastUpdateAt: info.lastUpdateDate ? new Date(info.lastUpdateDate) : new Date(),
        };
        const saved = await this.prisma.esfInvoice.upsert({ where: { organizationId_environment_direction_esfId: { organizationId, environment: env, direction: 'INBOUND', esfId: data.esfId } }, create: data, update: { status: data.status, esfStatus: data.esfStatus, registrationNumber: data.registrationNumber, cancelReason: data.cancelReason, lastUpdateAt: data.lastUpdateAt, counterpartyId: data.counterpartyId } });
        if (!saved.sourceDocId && saved.counterpartyId) {
          const supply = await this.matchSupply(organizationId, saved.counterpartyId, saved.totalWithTax, saved.turnoverDate);
          if (supply) await this.prisma.esfInvoice.update({ where: { id: saved.id }, data: { sourceDocId: supply } });
        }
        if (saved.esfStatus === 'CREATED') toConfirm.push(String(info.invoiceId));
        imported++;
      }
      lastEvent = new Date(r.lastEventDate);
      lastId = r.lastInvoiceId ?? lastId;
      if (r.lastBlock || !r.items.length) break;
    }
    // Отметка «получено получателем» (DELIVERED) по новым входящим — без подписи, операция confirmInvoiceById
    for (let i = 0; i < toConfirm.length; i += 100) {
      const part = toConfirm.slice(i, i + 100);
      const res = await this.wrap(() => client.confirmInvoiceById(session.sessionId, part), session.id);
      for (const sm of res as any[]) {
        if (sm?.invoiceId && sm?.invoiceStatus) await this.prisma.esfInvoice.updateMany({ where: { organizationId, environment: env, direction: 'INBOUND', esfId: BigInt(sm.invoiceId) }, data: { status: sm.invoiceStatus, esfStatus: sm.invoiceStatus } });
      }
    }
    await this.prisma.esfSettings.upsert({ where: { organizationId }, create: { organizationId, inboundLastEventAt: lastEvent, inboundLastId: lastId ? BigInt(lastId) : null }, update: { inboundLastEventAt: lastEvent, inboundLastId: lastId ? BigInt(lastId) : null } });
    return imported;
  }

  /** Поступление того же поставщика на ту же сумму (с НДС) в пределах ±10 дней от даты оборота. */
  private async matchSupply(organizationId: string, counterpartyId: string, total: Prisma.Decimal, date: Date) {
    const from = new Date(date.getTime() - 10 * 86400000), to = new Date(date.getTime() + 10 * 86400000);
    const docs = await this.prisma.document.findMany({ where: { organizationId, counterpartyId, docType: 'SUPPLY', status: 'POSTED', deleted: false, date: { gte: from, lte: to }, total: { gte: new D(total).minus('0.01'), lte: new D(total).plus('0.01') } }, select: { id: true } });
    if (docs.length !== 1) return null; // неоднозначно — оставляем на ручную привязку
    const taken = await this.prisma.esfInvoice.findFirst({ where: { organizationId, direction: 'INBOUND', sourceDocId: docs[0].id } });
    return taken ? null : docs[0].id;
  }

  /** Сводка для дашборда и бейджа. */
  async summary(ctx: OrgContext) {
    const env = (await this.prisma.esfSettings.findUnique({ where: { organizationId: ctx.organizationId } }))?.environment ?? 'TEST';
    const grouped = await this.prisma.esfInvoice.groupBy({ by: ['direction', 'status'], where: { organizationId: ctx.organizationId, environment: env }, _count: true });
    const pending = await this.pendingDocs(this.prisma, ctx.organizationId, env, 1000);
    const outdated = await this.prisma.esfInvoice.count({ where: { organizationId: ctx.organizationId, environment: env, outdated: true } });
    return { environment: env, counts: grouped.map((g) => ({ direction: g.direction, status: g.status, count: g._count })), pendingDocs: pending.length, outdated };
  }

  // ── Фоновая работа ──

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const orgs = await this.prisma.esfSettings.findMany();
      const tenantOf = new Map((await this.prisma.organization.findMany({ where: { id: { in: orgs.map((s) => s.organizationId) } }, select: { id: true, tenantId: true } })).map((o) => [o.id, o.tenantId]));
      for (const s of orgs) {
        const tenantId = tenantOf.get(s.organizationId);
        if (!tenantId) continue;
        const ctx: OrgContext = { tenantId, organizationId: s.organizationId, userId: 'system:esf', role: 'system', can: () => true };
        if (s.autoPrepare) {
          for (const d of await this.pendingDocs(this.prisma, s.organizationId, s.environment, 50)) {
            try { await this.prepare(ctx, d.id); } catch (e: any) { /* нехватка данных видна в списке «ожидают ЭСФ» */ }
          }
        }
        await this.markOutdated(s.organizationId, s.environment);
        await this.recoverStaleSending(s.organizationId);
        const session = await this.activeSession(this.prisma, s.organizationId, s.environment);
        if (session) {
          try { await this.refreshWith(s.organizationId, s.environment, session); } catch (e: any) { this.log.warn(`${s.organizationId}: ${e.message}`); }
        }
      }
    } finally {
      this.running = false;
    }
  }

  /** Документ изменён/отменён после отправки ЭСФ → нужен исправленный ЭСФ или отзыв. Неотправленные пересобираются при подписи. */
  async markOutdated(organizationId: string, env: string) {
    await this.prisma.$executeRawUnsafe(
      `UPDATE esf_invoices i SET outdated = true, updated_at = now()
         FROM documents d
        WHERE i.source_doc_id = d.id AND i.organization_id = $1 AND i.environment = $2 AND i.direction = 'OUTBOUND'
          AND i.status NOT IN ('READY','REJECTED','CANCELLED') AND i.outdated = false
          AND (d.status <> 'POSTED' OR d.deleted OR d.updated_at > i.sent_at)`,
      organizationId, env,
    );
    // Неотправленные по отменённым документам больше не нужны
    await this.prisma.$executeRawUnsafe(
      `UPDATE esf_invoices i SET status = 'CANCELLED', updated_at = now()
         FROM documents d
        WHERE i.source_doc_id = d.id AND i.organization_id = $1 AND i.environment = $2 AND i.status = 'READY'
          AND (d.status <> 'POSTED' OR d.deleted)`,
      organizationId, env,
    );
  }
}
