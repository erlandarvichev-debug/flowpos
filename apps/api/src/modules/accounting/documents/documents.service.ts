import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AccError } from '../common/acc-error';
import { OrgContext } from '../access/org-context';
import { PeriodsService, OverrideRequest } from '../periods/periods.service';
import { PostingService } from '../core/posting.service';
import { ruleFor, RULES, registerRule } from '../core/rules/rules';
import { MONEY_RULES } from '../core/rules/money-rules';
import { DEFAULT_ACCOUNTS } from '../autopilot/accounts';

MONEY_RULES.forEach(registerRule);

export const SOURCE = 'ACC_DOCUMENT';

export interface CreateDocInput {
  docType: string;
  date: string;
  comment?: string;
  currency?: string;
  body: any;
  baseDocumentId?: string;
  externalSource?: string;
  externalId?: string;
}

export interface UpdateDocInput {
  expectedVersion: number;
  date?: string;
  comment?: string;
  body?: any;
  reason?: string;
  override?: OverrideRequest;
}

type Tx = Prisma.TransactionClient;

/**
 * Жизненный цикл бухгалтерского документа:
 * DRAFT → (post) → POSTED → (unpost) → DRAFT; любой → CANCELLED (пометка, проводки отменяются).
 * Каждое действие пишет неизменяемую версию. Изменение проведённого документа атомарно перепроводит его.
 * Конфликт одновременного редактирования — по expectedVersion (409).
 */
@Injectable()
export class DocumentsService {
  constructor(
    private prisma: PrismaService,
    private periods: PeriodsService,
    private posting: PostingService,
  ) {}

  docTypes() {
    return Object.values(RULES).map((r) => ({ docType: r.docType, title: r.title, ruleVersion: r.version }));
  }

  private snapshot(doc: any) {
    return {
      docType: doc.docType, number: doc.number, date: doc.date, status: doc.status, version: doc.version,
      currency: doc.currency, amount: doc.amount, comment: doc.comment, body: doc.body,
      baseDocumentId: doc.baseDocumentId, reversalOfId: doc.reversalOfId,
    };
  }

  private async nextNumber(tx: Tx, organizationId: string, docType: string, date: Date) {
    const year = date.getUTCFullYear();
    const rows = await tx.$queryRaw<{ last: number }[]>`
      INSERT INTO acc_number_sequences (organization_id, doc_type, year, last)
      VALUES (${organizationId}, ${docType}, ${year}, 1)
      ON CONFLICT (organization_id, doc_type, year) DO UPDATE SET last = acc_number_sequences.last + 1
      RETURNING last`;
    const prefix = ruleFor(docType).numberPrefix;
    return `${prefix}-${year}-${String(rows[0].last).padStart(6, '0')}`;
  }

  private parseDate(v: string | undefined, field = 'Дата') {
    const d = new Date(v as string);
    if (!v || isNaN(d.getTime())) throw new AccError('BAD_DATE', `${field}: некорректная дата`, { fix: 'Укажите дату в формате ГГГГ-ММ-ДД.' });
    return d;
  }

  private async lockDoc(tx: Tx, ctx: OrgContext, id: string) {
    await tx.$queryRaw`SELECT id FROM acc_documents WHERE id = ${id} AND organization_id = ${ctx.organizationId} FOR UPDATE`;
    const doc = await tx.accDocument.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!doc) throw new AccError('DOC_NOT_FOUND', 'Документ не найден', { status: 404 });
    return doc;
  }

  private async version(tx: Tx, ctx: OrgContext, doc: any, action: string, reason?: string) {
    await tx.accDocumentVersion.create({
      data: { documentId: doc.id, version: doc.version, action, snapshot: this.snapshot(doc) as any, changedById: ctx.userId, reason },
    });
  }

  /** Проверка, что ссылки аналитик принадлежат организации (собственные справочники учёта и склады). */
  private async checkRefs(tx: Tx, ctx: OrgContext, body: any) {
    const ids = { BANK_ACCOUNT: new Set<string>(), CASHBOX: new Set<string>(), PROJECT: new Set<string>(), ITEM: new Set<string>(), STORE: new Set<string>() };
    const visit = (dims: any) => {
      if (!dims) return;
      for (const k of Object.keys(ids) as (keyof typeof ids)[]) if (dims[k]) ids[k].add(dims[k]);
    };
    for (const l of body?.lines || []) { visit(l.dims); visit(l.debit?.dims); visit(l.credit?.dims); }
    // реквизиты денежных документов
    for (const k of ['bankAccountId', 'toBankAccountId', 'fromBankAccountId']) if (body?.[k]) ids.BANK_ACCOUNT.add(body[k]);
    for (const k of ['cashboxId', 'toCashboxId']) if (body?.[k]) ids.CASHBOX.add(body[k]);
    if (body?.itemId) ids.ITEM.add(body.itemId);
    const org = ctx.organizationId;
    const checks: [string, Set<string>, (ids: string[]) => Promise<number>][] = [
      ['банковский счёт', ids.BANK_ACCOUNT, (x) => tx.orgBankAccount.count({ where: { id: { in: x }, organizationId: org } })],
      ['касса', ids.CASHBOX, (x) => tx.cashbox.count({ where: { id: { in: x }, organizationId: org } })],
      ['проект', ids.PROJECT, (x) => tx.project.count({ where: { id: { in: x }, organizationId: org } })],
      ['статья', ids.ITEM, (x) => tx.accItem.count({ where: { id: { in: x }, organizationId: org } })],
      ['склад', ids.STORE, (x) => tx.store.count({ where: { id: { in: x }, organizationId: org } })],
    ];
    for (const [label, set, count] of checks) {
      if (set.size && (await count([...set])) !== set.size) {
        throw new AccError('REF_FOREIGN', `Указан ${label}, которого нет в этой организации`, { fix: `Выберите ${label} из справочника текущей организации.` });
      }
    }
  }

  async list(ctx: OrgContext, q: { docType?: string; status?: string; from?: string; to?: string; search?: string; page?: number; limit?: number }) {
    const page = Math.max(1, Number(q.page) || 1);
    const limit = Math.min(200, Number(q.limit) || 50);
    const where: Prisma.AccDocumentWhereInput = { organizationId: ctx.organizationId };
    if (q.docType) where.docType = q.docType;
    if (q.status) where.status = q.status;
    if (q.from || q.to) where.date = { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to + 'T23:59:59.999Z') } : {}) };
    if (q.search) where.OR = [{ number: { contains: q.search, mode: 'insensitive' } }, { comment: { contains: q.search, mode: 'insensitive' } }];
    const [items, total] = await Promise.all([
      this.prisma.accDocument.findMany({ where, orderBy: [{ date: 'desc' }, { number: 'desc' }], skip: (page - 1) * limit, take: limit }),
      this.prisma.accDocument.count({ where }),
    ]);
    return { items, total, page, limit };
  }

  async get(ctx: OrgContext, id: string) {
    const doc = await this.prisma.accDocument.findFirst({
      where: { id, organizationId: ctx.organizationId },
      include: { versions: { orderBy: { createdAt: 'asc' } } },
    });
    if (!doc) throw new AccError('DOC_NOT_FOUND', 'Документ не найден', { status: 404 });
    const entry = await this.posting.activePostings(this.prisma, ctx.organizationId, SOURCE, id);
    const related = await this.prisma.accDocument.findMany({
      where: {
        organizationId: ctx.organizationId,
        OR: [
          { id: { in: [doc.baseDocumentId, doc.reversalOfId].filter(Boolean) as string[] } },
          { baseDocumentId: id }, { reversalOfId: id },
        ],
      },
      select: { id: true, docType: true, number: true, date: true, status: true, amount: true, baseDocumentId: true, reversalOfId: true },
    });
    return { ...doc, entry, related };
  }

  async create(ctx: OrgContext, input: CreateDocInput) {
    const rule = ruleFor(input.docType);
    if (input.docType === 'STORNO') throw new AccError('USE_STORNO_ACTION', 'Сторно создаётся действием «Сторнировать» из исходного документа');
    const date = this.parseDate(input.date);
    return this.prisma.$transaction(async (tx) => {
      await this.checkRefs(tx, ctx, input.body);
      if (input.externalSource && input.externalId) {
        const dup = await tx.accDocument.findFirst({ where: { organizationId: ctx.organizationId, externalSource: input.externalSource, externalId: input.externalId } });
        if (dup) return dup; // защита от дублей при обмене
      }
      const number = await this.nextNumber(tx, ctx.organizationId, input.docType, date);
      const doc = await tx.accDocument.create({
        data: {
          organizationId: ctx.organizationId, docType: input.docType, number, date, currency: input.currency || 'KZT',
          amount: rule.amount(input.body), comment: input.comment, body: input.body ?? {}, baseDocumentId: input.baseDocumentId,
          authorId: ctx.userId, updatedById: ctx.userId, externalSource: input.externalSource, externalId: input.externalId,
        },
      });
      await this.version(tx, ctx, doc, 'CREATE');
      return doc;
    });
  }

  async update(ctx: OrgContext, id: string, input: UpdateDocInput) {
    return this.prisma.$transaction(async (tx) => {
      const doc = await this.lockDoc(tx, ctx, id);
      if (doc.version !== Number(input.expectedVersion)) {
        throw new AccError('VERSION_CONFLICT', `Документ уже изменён другим пользователем (версия ${doc.version}, у вас ${input.expectedVersion})`, {
          fix: 'Обновите документ и внесите изменения повторно.', status: 409, details: { currentVersion: doc.version },
        });
      }
      if (doc.status === 'CANCELLED') throw new AccError('DOC_CANCELLED', 'Документ помечен на удаление — сначала восстановите его');
      if (doc.docType === 'STORNO') throw new AccError('STORNO_READONLY', 'Документ сторно не редактируется');
      const newDate = input.date ? this.parseDate(input.date) : doc.date;
      const body = input.body ?? doc.body;
      if (input.body) await this.checkRefs(tx, ctx, body);
      if (doc.status === 'POSTED') {
        if (!input.reason) throw new AccError('REASON_REQUIRED', 'Изменение проведённого документа требует указать причину', { fix: 'Заполните поле «Причина изменения».' });
        if (!ctx.can('acc.doc.post')) throw new AccError('FORBIDDEN', 'Нет права перепроводить документы', { status: 403 });
        await this.periods.assertOpen(tx, ctx, [doc.date, newDate], input.override, 'изменение проведённого документа');
      }
      const rule = ruleFor(doc.docType);
      const updated = await tx.accDocument.update({
        where: { id },
        data: {
          date: newDate, comment: input.comment ?? doc.comment, body, amount: rule.amount(body),
          version: { increment: 1 }, updatedById: ctx.userId,
        },
      });
      await this.version(tx, ctx, updated, 'UPDATE', input.reason);
      if (updated.status === 'POSTED') await this.writePostings(tx, ctx, updated);
      return updated;
    });
  }

  private async writePostings(tx: Tx, ctx: OrgContext, doc: any) {
    const rule = ruleFor(doc.docType);
    const policy = await tx.accPolicy.findFirst({ where: { organizationId: ctx.organizationId, validFrom: { lte: doc.date } }, orderBy: { validFrom: 'desc' } });
    const accounts = { ...DEFAULT_ACCOUNTS, ...(((policy?.params as any) ?? {}).accounts ?? {}) };
    const postings = await rule.build(doc, { tx, organizationId: ctx.organizationId, posting: this.posting, accounts });
    return this.posting.writeEntry(tx, ctx, {
      sourceType: SOURCE, sourceId: doc.id, sourceVersion: doc.version,
      ruleCode: rule.code, ruleVersion: rule.version, date: doc.date, postings,
    });
  }

  async post(ctx: OrgContext, id: string, opts: { expectedVersion?: number; override?: OverrideRequest } = {}) {
    return this.prisma.$transaction(async (tx) => {
      const doc = await this.lockDoc(tx, ctx, id);
      if (opts.expectedVersion !== undefined && doc.version !== Number(opts.expectedVersion)) {
        throw new AccError('VERSION_CONFLICT', 'Документ изменён другим пользователем', { status: 409, fix: 'Обновите документ.' });
      }
      if (doc.status === 'CANCELLED') throw new AccError('DOC_CANCELLED', 'Документ помечен на удаление');
      await this.periods.assertOpen(tx, ctx, [doc.date], opts.override, 'проведение');
      const { reused } = await this.writePostings(tx, ctx, doc);
      if (doc.status === 'POSTED' && reused) return this.withEntry(tx, ctx, doc); // повторный запрос — без дублей
      const posted = await tx.accDocument.update({ where: { id }, data: { status: 'POSTED', postedAt: new Date(), updatedById: ctx.userId } });
      await this.version(tx, ctx, posted, 'POST');
      return this.withEntry(tx, ctx, posted);
    });
  }

  async unpost(ctx: OrgContext, id: string, opts: { override?: OverrideRequest; reason?: string } = {}) {
    return this.prisma.$transaction(async (tx) => {
      const doc = await this.lockDoc(tx, ctx, id);
      if (doc.status !== 'POSTED') return doc;
      await this.assertNotStornoed(tx, ctx, id);
      await this.periods.assertOpen(tx, ctx, [doc.date], opts.override, 'отмена проведения');
      await this.posting.cancelSource(tx, ctx.organizationId, SOURCE, id);
      const d = await tx.accDocument.update({ where: { id }, data: { status: 'DRAFT', updatedById: ctx.userId } });
      await this.version(tx, ctx, d, 'UNPOST', opts.reason);
      return d;
    });
  }

  async cancel(ctx: OrgContext, id: string, opts: { override?: OverrideRequest; reason?: string } = {}) {
    return this.prisma.$transaction(async (tx) => {
      const doc = await this.lockDoc(tx, ctx, id);
      if (doc.status === 'CANCELLED') return doc;
      if (doc.status === 'POSTED') {
        await this.assertNotStornoed(tx, ctx, id);
        await this.periods.assertOpen(tx, ctx, [doc.date], opts.override, 'пометка на удаление');
        await this.posting.cancelSource(tx, ctx.organizationId, SOURCE, id);
      }
      const d = await tx.accDocument.update({ where: { id }, data: { status: 'CANCELLED', updatedById: ctx.userId } });
      await this.version(tx, ctx, d, 'CANCEL', opts.reason);
      return d;
    });
  }

  async restore(ctx: OrgContext, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const doc = await this.lockDoc(tx, ctx, id);
      if (doc.status !== 'CANCELLED') return doc;
      const d = await tx.accDocument.update({ where: { id }, data: { status: 'DRAFT', updatedById: ctx.userId } });
      await this.version(tx, ctx, d, 'RESTORE');
      return d;
    });
  }

  /** Сторно проведённого документа новым документом в открытом периоде (исходный не меняется). */
  async storno(ctx: OrgContext, id: string, input: { date: string; reason: string }) {
    if (!input.reason) throw new AccError('REASON_REQUIRED', 'Укажите причину сторно');
    const date = this.parseDate(input.date, 'Дата сторно');
    return this.prisma.$transaction(async (tx) => {
      const orig = await this.lockDoc(tx, ctx, id);
      if (orig.status !== 'POSTED') throw new AccError('STORNO_SOURCE_NOT_POSTED', 'Сторнировать можно только проведённый документ');
      if (orig.docType === 'STORNO') throw new AccError('STORNO_OF_STORNO', 'Сторно сторно не допускается — проведите исходную операцию заново');
      await this.assertNotStornoed(tx, ctx, id);
      await this.periods.assertOpen(tx, ctx, [date], undefined, 'сторно');
      const number = await this.nextNumber(tx, ctx.organizationId, 'STORNO', date);
      const doc = await tx.accDocument.create({
        data: {
          organizationId: ctx.organizationId, docType: 'STORNO', number, date, currency: orig.currency,
          amount: orig.amount.neg(), comment: input.reason, body: { originalNumber: orig.number, reason: input.reason, amount: orig.amount.neg().toFixed(2) },
          reversalOfId: orig.id, baseDocumentId: orig.id, authorId: ctx.userId, updatedById: ctx.userId,
        },
      });
      await this.version(tx, ctx, doc, 'CREATE', input.reason);
      await this.writePostings(tx, ctx, doc);
      const posted = await tx.accDocument.update({ where: { id: doc.id }, data: { status: 'POSTED', postedAt: new Date() } });
      await this.version(tx, ctx, posted, 'POST', input.reason);
      return this.withEntry(tx, ctx, posted);
    });
  }

  private async assertNotStornoed(tx: Tx, ctx: OrgContext, id: string) {
    const st = await tx.accDocument.findFirst({ where: { organizationId: ctx.organizationId, reversalOfId: id, status: 'POSTED' } });
    if (st) throw new AccError('DOC_STORNOED', `Документ уже сторнирован документом ${st.number}`, { link: `/accounting/documents/${st.id}`, fix: 'Сначала отмените проведение документа сторно.' });
  }

  private async withEntry(tx: Tx, ctx: OrgContext, doc: any) {
    const entry = await this.posting.activePostings(tx, ctx.organizationId, SOURCE, doc.id);
    return { ...doc, entry };
  }
}
