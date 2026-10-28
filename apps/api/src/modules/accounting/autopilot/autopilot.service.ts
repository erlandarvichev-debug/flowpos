import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AccError } from '../common/acc-error';
import { OrgContext } from '../access/org-context';
import { hasPermission } from '../access/roles';
import { PostingService } from '../core/posting.service';
import { PeriodsService, OverrideRequest } from '../periods/periods.service';
import { CostService } from '../inventory/cost.service';
import { DEFAULT_ACCOUNTS, AccountsMap } from './accounts';
import { NO_ACCOUNTING, TRADE_RULE_VERSION, TRADE_SOURCE, TradeDoc, buildTradeEntry, isSupported } from './trade-rules';

type Tx = Prisma.TransactionClient;

export function systemCtx(organizationId: string, userId?: string | null): OrgContext {
  // Автопилот не может переопределять закрытый период
  return { organizationId, userId: userId ?? 'system:autopilot', role: 'system', can: (p) => p !== 'acc.period.override' && hasPermission('chief_accountant', p) };
}

export interface SyncResult { status: 'POSTED' | 'CANCELLED' | 'SKIPPED' | 'UNCHANGED'; reason?: string; entryId?: string }

/**
 * Автопилот: торговые и кассовые документы FlowPOS → проводки, НДС, себестоимость.
 * Синхронно — при проведении из бухгалтерии; асинхронно — фоновый сверщик по updated_at
 * (документы из POS, 1С, МойСклада). Ошибки не ломают торговлю: документ остаётся,
 * а в «Проблемы автопилота» пишется что случилось и как исправить.
 */
@Injectable()
export class AutopilotService implements OnModuleInit, OnModuleDestroy {
  private log = new Logger('Autopilot');
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private prisma: PrismaService,
    private posting: PostingService,
    private periods: PeriodsService,
    private cost: CostService,
  ) {}

  onModuleInit() {
    if (process.env.ACC_AUTOPILOT_DISABLED === '1' || process.env.NODE_ENV === 'test') return;
    const every = Number(process.env.ACC_AUTOPILOT_INTERVAL_MS || 15000);
    this.timer = setInterval(() => this.tick().catch((e) => this.log.error(e.message)), every);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async accountsFor(tx: Tx, organizationId: string, date: Date): Promise<{ accounts: AccountsMap; vatPayer: boolean; enabled: boolean; skipOwners: string[] }> {
    const p = await tx.accPolicy.findFirst({ where: { organizationId, validFrom: { lte: date } }, orderBy: { validFrom: 'desc' } });
    const params: any = p?.params ?? {};
    return {
      accounts: { ...DEFAULT_ACCOUNTS, ...(params.accounts ?? {}) },
      vatPayer: !!p?.vatPayer,
      enabled: params.autopilot?.enabled !== false,
      skipOwners: params.autopilot?.skipOwners ?? [],
    };
  }

  private async orgOf(tx: Tx, doc: { organizationId: string | null; storeId: string | null }) {
    if (doc.organizationId) return doc.organizationId;
    if (doc.storeId) return (await tx.store.findUnique({ where: { id: doc.storeId }, select: { organizationId: true } }))?.organizationId ?? null;
    return null;
  }

  private async resolveCashbox(tx: Tx, ctx: OrgContext, storeId: string | null) {
    const byStore = storeId ? await tx.cashbox.findFirst({ where: { organizationId: ctx.organizationId, storeId, isActive: true } }) : null;
    if (byStore) return byStore.id;
    if (storeId) {
      const store = await tx.store.findUnique({ where: { id: storeId } });
      const created = await tx.cashbox.create({ data: { organizationId: ctx.organizationId, name: `Касса ${store?.name ?? ''}`.trim(), storeId } });
      await tx.auditLog.create({ data: { userId: null, organizationId: ctx.organizationId, action: 'AUTOPILOT_CASHBOX_CREATE', entity: 'cashbox', entityId: created.id, after: created as any } });
      return created.id;
    }
    const any = await tx.cashbox.findFirst({ where: { organizationId: ctx.organizationId, isActive: true }, orderBy: { createdAt: 'asc' } });
    if (any) return any.id;
    throw new AccError('CASHBOX_REQUIRED', 'Нет кассы организации для розничной выручки', { fix: 'Создайте кассу в справочнике «Кассы».', link: '/accounting/refs' });
  }

  private async resolveBank(tx: Tx, ctx: OrgContext, hint?: string | null) {
    if (hint) {
      const b = await tx.orgBankAccount.findFirst({ where: { id: hint, organizationId: ctx.organizationId } });
      if (b) return b.id;
    }
    const b = await tx.orgBankAccount.findFirst({ where: { organizationId: ctx.organizationId, isActive: true, currency: 'KZT' }, orderBy: { createdAt: 'asc' } });
    if (!b) throw new AccError('BANK_ACCOUNT_REQUIRED', 'Нет банковского счёта организации для отражения платежа', { fix: 'Добавьте банковский счёт в справочнике «Банковские счета».', link: '/accounting/refs' });
    return b.id;
  }

  async loadDoc(tx: Tx, id: string): Promise<(TradeDoc & { status: string; deleted: boolean; updatedAt: Date; owner: string }) | null> {
    const d = await tx.document.findUnique({ where: { id }, include: { lines: { include: { product: true }, orderBy: { lineNo: 'asc' } } } });
    return d as any;
  }

  /** Отразить (или снять) документ в учёте. Вызывается внутри транзакции. */
  async syncTradeDocument(tx: Tx, id: string, opts: { userId?: string | null; override?: OverrideRequest; organizationId?: string } = {}): Promise<SyncResult> {
    await tx.$queryRaw`SELECT id FROM documents WHERE id = ${id} FOR UPDATE`;
    const doc = await this.loadDoc(tx, id);
    if (!doc) throw new AccError('DOC_NOT_FOUND', 'Документ не найден', { status: 404 });
    const organizationId = await this.orgOf(tx, doc);
    if (!organizationId) throw new AccError('ORG_UNKNOWN', `Документ ${doc.number ?? id}: не определена организация`, { fix: 'Укажите организацию документа или склада.' });
    if (opts.organizationId && opts.organizationId !== organizationId) throw new AccError('DOC_NOT_FOUND', 'Документ не найден', { status: 404 });
    const ctx = systemCtx(organizationId, opts.userId);
    const settings = await this.accountsFor(tx, organizationId, doc.date);
    const existing = await tx.accEntry.findFirst({ where: { organizationId, sourceType: TRADE_SOURCE, sourceId: id, status: 'ACTIVE' } });
    const oldProducts = existing ? (await tx.accStockMove.findMany({ where: { entryId: existing.id }, select: { productId: true } })).map((m) => m.productId) : [];

    const shouldPost = doc.status === 'POSTED' && !doc.deleted && settings.enabled && !settings.skipOwners.includes(doc.owner) && !NO_ACCOUNTING.includes(doc.docType);
    if (!shouldPost) {
      if (existing) {
        await this.periods.assertOpen(tx, ctx, [existing.date], opts.override, 'отмена отражения документа');
        await this.posting.cancelSource(tx, organizationId, TRADE_SOURCE, id);
        await this.cost.recalcProducts(tx, ctx, oldProducts, opts.override);
      }
      await this.resolveIssue(tx, id);
      return { status: existing ? 'CANCELLED' : 'SKIPPED', reason: NO_ACCOUNTING.includes(doc.docType) ? 'документ без бухгалтерских последствий' : undefined };
    }
    if (!isSupported(doc.docType)) throw new AccError('NO_RULE', `Нет правила отражения для документа типа ${doc.docType}`);
    const version = Math.floor(doc.updatedAt.getTime() / 1000);
    if (existing && existing.sourceVersion === version && existing.ruleVersion === TRADE_RULE_VERSION) {
      await this.resolveIssue(tx, id);
      return { status: 'UNCHANGED', entryId: existing.id };
    }
    await this.periods.assertOpen(tx, ctx, [doc.date, ...(existing ? [existing.date] : [])], opts.override, 'отражение документа');
    const { postings, moves } = await buildTradeEntry({ ...doc, organizationId }, {
      tx, organizationId, posting: this.posting, accounts: settings.accounts, vatPayer: settings.vatPayer,
      resolveCashbox: (s) => this.resolveCashbox(tx, ctx, s),
      resolveBankAccount: (h) => this.resolveBank(tx, ctx, h),
    });
    const { entry } = await this.posting.writeEntry(tx, ctx, {
      sourceType: TRADE_SOURCE, sourceId: id, sourceVersion: version, ruleCode: `TRADE_${doc.docType}`, ruleVersion: TRADE_RULE_VERSION,
      date: doc.date, postings, moves, allowEmpty: moves.length > 0,
    });
    await this.cost.recalcProducts(tx, ctx, [...oldProducts, ...moves.map((m) => m.productId)], opts.override);
    await this.resolveIssue(tx, id);
    return { status: 'POSTED', entryId: entry.id };
  }

  private async resolveIssue(tx: Tx, sourceId: string) {
    await tx.accAutopilotIssue.updateMany({ where: { sourceType: TRADE_SOURCE, sourceId, resolvedAt: null }, data: { resolvedAt: new Date() } });
  }

  async recordIssue(sourceId: string, e: any) {
    const doc = await this.prisma.document.findUnique({ where: { id: sourceId }, select: { organizationId: true, storeId: true } });
    const organizationId = doc ? await this.orgOf(this.prisma, doc) : null;
    const body = e?.getResponse?.() ?? {};
    const code = body.code ?? 'ERROR';
    const message = body.message ?? String(e?.message ?? e);
    await this.prisma.accAutopilotIssue.upsert({
      where: { sourceType_sourceId: { sourceType: TRADE_SOURCE, sourceId } },
      create: { organizationId, sourceType: TRADE_SOURCE, sourceId, code, message, fix: body.fix },
      update: { organizationId, code, message, fix: body.fix, attempts: { increment: 1 }, resolvedAt: null },
    });
  }

  /** Отразить один документ в отдельной транзакции; ошибка → проблема автопилота. */
  async process(id: string, opts: { userId?: string | null; organizationId?: string } = {}): Promise<SyncResult | { status: 'ERROR'; code: string; message: string }> {
    try {
      return await this.prisma.$transaction((tx) => this.syncTradeDocument(tx, id, opts), { timeout: 60000 });
    } catch (e: any) {
      await this.recordIssue(id, e).catch(() => undefined);
      const b = e?.getResponse?.() ?? {};
      return { status: 'ERROR', code: b.code ?? 'ERROR', message: b.message ?? e.message };
    }
  }

  /** Фоновый сверщик: документы, изменённые после курсора. */
  async tick(batch = 200) {
    if (this.running) return;
    this.running = true;
    try {
      const cursor = await this.prisma.accAutopilotCursor.findUnique({ where: { id: 'trade-documents' } });
      const since = cursor?.updatedAt ?? new Date(0);
      const docs = await this.prisma.document.findMany({
        where: { updatedAt: { gte: since } },
        orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
        take: batch,
        select: { id: true, updatedAt: true },
      });
      for (const d of docs) {
        if (cursor && d.updatedAt.getTime() === since.getTime() && cursor.lastId && d.id <= cursor.lastId) continue;
        await this.process(d.id);
        await this.prisma.accAutopilotCursor.upsert({
          where: { id: 'trade-documents' },
          create: { id: 'trade-documents', updatedAt: d.updatedAt, lastId: d.id },
          update: { updatedAt: d.updatedAt, lastId: d.id },
        });
      }
      return docs.length;
    } finally {
      this.running = false;
    }
  }

  // ── API ──
  async issues(ctx: OrgContext, includeResolved = false) {
    const items = await this.prisma.accAutopilotIssue.findMany({
      where: { organizationId: ctx.organizationId, ...(includeResolved ? {} : { resolvedAt: null }) },
      orderBy: { updatedAt: 'desc' }, take: 500,
    });
    const docs = await this.prisma.document.findMany({ where: { id: { in: items.map((i) => i.sourceId) } }, select: { id: true, number: true, docType: true, date: true } });
    return items.map((i) => ({ ...i, document: docs.find((d) => d.id === i.sourceId) ?? null }));
  }

  async status(ctx: OrgContext) {
    const stores = (await this.prisma.store.findMany({ where: { organizationId: ctx.organizationId }, select: { id: true } })).map((s) => s.id);
    const [open, reflected, cursor] = await Promise.all([
      this.prisma.accAutopilotIssue.count({ where: { organizationId: ctx.organizationId, resolvedAt: null } }),
      this.prisma.accEntry.count({ where: { organizationId: ctx.organizationId, sourceType: TRADE_SOURCE, status: 'ACTIVE' } }),
      this.prisma.accAutopilotCursor.findUnique({ where: { id: 'trade-documents' } }),
    ]);
    const posted = await this.prisma.document.count({
      where: { status: 'POSTED', deleted: false, docType: { notIn: NO_ACCOUNTING as any }, OR: [{ organizationId: ctx.organizationId }, { organizationId: null, storeId: { in: stores } }] },
    });
    return { postedTradeDocuments: posted, reflected, openIssues: open, cursor: cursor?.updatedAt ?? null, enabled: (await this.accountsFor(this.prisma, ctx.organizationId, new Date())).enabled };
  }

  /** Перепровести все документы организации (идемпотентно). */
  async resync(ctx: OrgContext) {
    const stores = (await this.prisma.store.findMany({ where: { organizationId: ctx.organizationId }, select: { id: true } })).map((s) => s.id);
    const docs = await this.prisma.document.findMany({
      where: { OR: [{ organizationId: ctx.organizationId }, { organizationId: null, storeId: { in: stores } }] },
      orderBy: [{ date: 'asc' }, { createdAt: 'asc' }], select: { id: true },
    });
    const result = { total: docs.length, posted: 0, unchanged: 0, cancelled: 0, skipped: 0, errors: 0 };
    for (const d of docs) {
      const r = await this.process(d.id, { userId: ctx.userId, organizationId: ctx.organizationId });
      const k = r.status.toLowerCase();
      if (k === 'error') result.errors++; else (result as any)[k]++;
    }
    return result;
  }
}
