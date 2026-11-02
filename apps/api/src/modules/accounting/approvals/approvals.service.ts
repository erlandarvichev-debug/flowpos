// FP-029: согласование проведения документа. Согласование привязано к организации и действию (scope), версии и хэшу
// содержимого, сумме и сроку действия (TTL); одноразовое; изменение документа его отменяет. При проведении всё
// сверяется заново — устаревшее, просроченное или «не та сумма» согласование не пропускает.
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AccError } from '../common/acc-error';
import { OrgContext } from '../access/org-context';
import { accHash, tradeHash } from '../documents/content-hash';

type Tx = Prisma.TransactionClient | PrismaService;
export type DocKind = 'TRADE' | 'ACC';
const KINDS: DocKind[] = ['TRADE', 'ACC'];
const D = Prisma.Decimal;
const NOTE_MIN = 5;
const TTL_MAX = 168; // неделя
/** FP-033: встроенное правило согласования расхождений инвентаризации. */
const BUILTIN_INVENTORY = { id: 'builtin:INVENTORY', docKind: 'TRADE', docType: 'INVENTORY', action: 'POST', minAmount: new Prisma.Decimal('0.01'), ttlHours: 72, enabled: true };

/** Состояние документа, к которому привязывается согласование. */
export interface DocState {
  kind: DocKind;
  id: string;
  docType: string;
  number: string | null;
  status: string;
  version: number;
  hash: string;
  amount: Prisma.Decimal;
  currency: string;
}

@Injectable()
export class ApprovalsService {
  constructor(private prisma: PrismaService) {}

  /** Текущее состояние документа своей организации (для запроса, решения и сверки). */
  async docState(db: Tx, ctx: OrgContext, kind: string, id: string): Promise<DocState> {
    if (!KINDS.includes(kind as DocKind)) throw new AccError('BAD_KIND', `Вид документа: ${KINDS.join(', ')}`);
    if (kind === 'TRADE') {
      const doc = await db.document.findUnique({ where: { id }, include: { lines: true } });
      const org = doc?.organizationId ?? (doc?.storeId ? (await db.store.findUnique({ where: { id: doc.storeId } }))?.organizationId : null);
      if (!doc || org !== ctx.organizationId) throw new AccError('DOC_NOT_FOUND', 'Документ не найден', { status: 404 });
      return { kind: 'TRADE', id, docType: doc.docType, number: doc.number, status: doc.status, version: doc.version, hash: tradeHash(doc), amount: new D(doc.total ?? 0), currency: 'KZT' };
    }
    const doc = await db.accDocument.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!doc) throw new AccError('DOC_NOT_FOUND', 'Документ не найден', { status: 404 });
    return { kind: 'ACC', id, docType: doc.docType, number: doc.number, status: doc.status, version: doc.version, hash: accHash(doc), amount: doc.amount, currency: doc.currency };
  }

  /** Правило, требующее согласования (самый короткий срок среди подходящих); null — согласование не нужно. */
  async policyFor(db: Tx, organizationId: string, st: Pick<DocState, 'kind' | 'docType' | 'amount'>, action = 'POST') {
    const rules = await db.approvalPolicy.findMany({
      where: { organizationId, docKind: st.kind, action, enabled: true, docType: { in: [st.docType, '*'] }, minAmount: { lte: st.amount.abs() } },
      orderBy: [{ ttlHours: 'asc' }, { id: 'asc' }],
    });
    // FP-033: расхождения инвентаризации согласуются всегда («четыре глаза»), даже без правил организации: встроенное
    // правило «от 0,01, 72 ч». Правило организации на INVENTORY (порог, срок) — приоритетнее.
    if (!rules[0] && st.kind === 'TRADE' && st.docType === 'INVENTORY' && st.amount.abs().gte(BUILTIN_INVENTORY.minAmount)) return BUILTIN_INVENTORY as any;
    return rules[0] ?? null;
  }

  private openKey(kind: string, id: string, action: string) {
    return `${kind}:${id}:${action}`;
  }

  /** Отменить действующие согласования документа (его изменили). Вызывается в транзакции изменения. */
  async supersede(db: Tx, organizationId: string, kind: DocKind, docId: string) {
    return db.approval.updateMany({
      where: { organizationId, docKind: kind, docId, status: { in: ['PENDING', 'APPROVED'] } },
      data: { status: 'SUPERSEDED', openKey: null, supersededAt: new Date() },
    });
  }

  /** Запросить согласование текущей версии. Повтор для той же версии — то же согласование. */
  async request(ctx: OrgContext, b: { docKind?: string; docId?: string; action?: string; expectedVersion?: unknown; note?: string }) {
    const action = b?.action ?? 'POST';
    if (action !== 'POST') throw new AccError('BAD_ACTION', 'Согласуется проведение (POST)');
    return this.prisma.$transaction(async (tx) => {
      const st = await this.docState(tx, ctx, String(b?.docKind), String(b?.docId));
      if (b?.expectedVersion === undefined || Number(b.expectedVersion) !== st.version) {
        throw new AccError('VERSION_CONFLICT', `Документ изменён (версия ${st.version}) — откройте его заново`, { status: 409, details: { currentVersion: st.version } });
      }
      if (st.status === 'POSTED' || st.status === 'CANCELLED') throw new AccError('BAD_STATUS', 'Согласуется проведение черновика');
      const policy = await this.policyFor(tx, ctx.organizationId, st, action);
      const key = this.openKey(st.kind, st.id, action);
      const open = await tx.approval.findFirst({ where: { organizationId: ctx.organizationId, openKey: key } });
      if (open && open.docVersion === st.version && open.contentHash === st.hash) return open;
      if (open) await tx.approval.update({ where: { id: open.id }, data: { status: 'SUPERSEDED', openKey: null, supersededAt: new Date() } });
      try {
        const a = await tx.approval.create({ data: {
          organizationId: ctx.organizationId, docKind: st.kind, docId: st.id, docType: st.docType, docNumber: st.number, action,
          docVersion: st.version, contentHash: st.hash, amount: st.amount, currency: st.currency, requestedBy: ctx.userId,
          requestNote: b?.note?.trim() || null, ttlHours: policy?.ttlHours ?? 24, openKey: key,
        } });
        await tx.auditLog.create({ data: { userId: ctx.userId, organizationId: ctx.organizationId, action: 'APPROVAL_REQUESTED', entity: 'approval', entityId: a.id, after: { docKind: st.kind, docId: st.id, version: st.version, hash: st.hash, amount: st.amount.toFixed(2) } as any } });
        return a;
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new AccError('APPROVAL_RACE', 'Согласование запрашивается параллельно — обновите страницу', { status: 409 });
        throw e;
      }
    });
  }

  /**
   * Решение: согласовать или отклонить. Согласует не тот, кто запросил (четыре глаза). Перед согласованием документ
   * сверяется: если его уже изменили — согласование отменяется, а не выдаётся на другое содержимое.
   */
  async decide(ctx: OrgContext, id: string, b: { decision?: string; note?: string }) {
    const decision = b?.decision;
    if (decision !== 'APPROVE' && decision !== 'REJECT') throw new AccError('BAD_DECISION', 'Решение: APPROVE или REJECT');
    const note = b?.note?.trim() || null;
    if (decision === 'REJECT' && (!note || note.length < NOTE_MIN)) throw new AccError('REASON_REQUIRED', `Укажите причину отказа (не короче ${NOTE_MIN} символов)`);
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM approvals WHERE id = ${id} FOR UPDATE`;
      const a = await tx.approval.findFirst({ where: { id, organizationId: ctx.organizationId } });
      if (!a) throw new AccError('NOT_FOUND', 'Согласование не найдено', { status: 404 });
      if (a.status !== 'PENDING') throw new AccError('APPROVAL_DECIDED', `Согласование уже ${STATUS_TEXT[a.status] ?? a.status}`, { status: 409 });
      if (a.requestedBy === ctx.userId) throw new AccError('FOUR_EYES', 'Согласовать может только другой сотрудник — не тот, кто запросил', { status: 403 });
      const st = await this.docState(tx, ctx, a.docKind, a.docId);
      // Отказ откатывает транзакцию — статус не меняем: такое согласование не пройдёт сверку (хэш), а новый запрос его отменит.
      if (st.version !== a.docVersion || st.hash !== a.contentHash) throw new AccError('APPROVAL_STALE', 'Документ изменён после запроса согласования — запросите заново', { status: 409 });
      const now = new Date();
      const done = await tx.approval.update({ where: { id }, data: decision === 'APPROVE'
        ? { status: 'APPROVED', decidedBy: ctx.userId, decidedAt: now, decisionNote: note, expiresAt: new Date(now.getTime() + a.ttlHours * 3600_000) }
        : { status: 'REJECTED', decidedBy: ctx.userId, decidedAt: now, decisionNote: note, openKey: null } });
      await tx.auditLog.create({ data: { userId: ctx.userId, organizationId: ctx.organizationId, action: decision === 'APPROVE' ? 'APPROVAL_GRANTED' : 'APPROVAL_REJECTED', entity: 'approval', entityId: id, reason: note, after: { docKind: a.docKind, docId: a.docId, version: a.docVersion, expiresAt: done.expiresAt } as any } });
      return done;
    });
  }

  /**
   * Перед проведением: если правило требует согласования — нужно действующее согласование ровно этой версии и
   * содержимого, на ту же сумму, не просроченное. Оно расходуется (одноразовое). Вызывается в транзакции проведения
   * после блокировки строки документа. Возвращает израсходованное согласование или null (не требуется).
   */
  async consumeForPost(tx: Prisma.TransactionClient, ctx: OrgContext, st: DocState) {
    const policy = await this.policyFor(tx, ctx.organizationId, st, 'POST');
    if (!policy) return null;
    const key = this.openKey(st.kind, st.id, 'POST');
    const a = await tx.approval.findFirst({ where: { organizationId: ctx.organizationId, openKey: key } });
    const need = { policyId: policy.id, minAmount: policy.minAmount.toFixed(2), amount: st.amount.toFixed(2), version: st.version };
    if (!a) throw new AccError('APPROVAL_REQUIRED', `Проведение на сумму ${st.amount.toFixed(2)} требует согласования`, { status: 409, fix: 'Запросите согласование и дождитесь решения.', details: need });
    if (a.status !== 'APPROVED') throw new AccError('APPROVAL_PENDING', 'Согласование ещё не получено', { status: 409, details: { ...need, approvalId: a.id } });
    // Не та версия/содержимое — отказ (транзакция проведения откатится; новый запрос согласования отменит это).
    if (a.docVersion !== st.version || a.contentHash !== st.hash) throw new AccError('APPROVAL_STALE', 'Согласовано другое содержимое документа — запросите согласование заново', { status: 409, details: need });
    if (!new D(a.amount).eq(st.amount) || a.currency !== st.currency) throw new AccError('APPROVAL_AMOUNT_MISMATCH', 'Сумма документа не совпадает с согласованной', { status: 409, details: need });
    if (!a.expiresAt || a.expiresAt.getTime() <= Date.now()) throw new AccError('APPROVAL_EXPIRED', 'Срок согласования истёк — запросите заново', { status: 409, details: { ...need, expiredAt: a.expiresAt } });
    const used = await tx.approval.updateMany({ where: { id: a.id, status: 'APPROVED' }, data: { status: 'CONSUMED', consumedAt: new Date(), openKey: null } });
    if (used.count !== 1) throw new AccError('APPROVAL_RACE', 'Согласование уже использовано', { status: 409 });
    await tx.auditLog.create({ data: { userId: ctx.userId, organizationId: ctx.organizationId, action: 'APPROVAL_CONSUMED', entity: 'approval', entityId: a.id, after: { docKind: st.kind, docId: st.id, version: st.version } as any } });
    return a;
  }

  /** Что нужно для проведения сейчас — для экрана и пробного проведения. */
  async requirement(db: Tx, ctx: OrgContext, st: DocState) {
    const policy = await this.policyFor(db, ctx.organizationId, st, 'POST');
    const open = await db.approval.findFirst({ where: { organizationId: ctx.organizationId, openKey: this.openKey(st.kind, st.id, 'POST') } });
    const valid = !!open && open.status === 'APPROVED' && open.docVersion === st.version && open.contentHash === st.hash
      && new D(open.amount).eq(st.amount) && !!open.expiresAt && open.expiresAt.getTime() > Date.now();
    return {
      required: !!policy,
      policy: policy ? { id: policy.id, minAmount: policy.minAmount.toFixed(2), ttlHours: policy.ttlHours } : null,
      approval: open,
      satisfied: !policy || valid,
      hash: st.hash,
      version: st.version,
    };
  }

  list(ctx: OrgContext, q: { status?: string; docKind?: string; docId?: string } = {}) {
    return this.prisma.approval.findMany({
      where: { organizationId: ctx.organizationId, ...(q.status ? { status: q.status } : {}), ...(q.docKind ? { docKind: q.docKind } : {}), ...(q.docId ? { docId: q.docId } : {}) },
      orderBy: { createdAt: 'desc' }, take: 200,
    });
  }

  // ── Правила ──

  policies(ctx: OrgContext) {
    return this.prisma.approvalPolicy.findMany({ where: { organizationId: ctx.organizationId }, orderBy: [{ docKind: 'asc' }, { minAmount: 'asc' }] });
  }

  private policyData(b: any) {
    const out: Record<string, any> = {};
    if ('docKind' in b) {
      if (!KINDS.includes(b.docKind)) throw new AccError('BAD_KIND', `Вид документа: ${KINDS.join(', ')}`);
      out.docKind = b.docKind;
    }
    if ('docType' in b) out.docType = String(b.docType || '*');
    if ('minAmount' in b) {
      let v: Prisma.Decimal;
      try { v = new D(String(b.minAmount)); } catch { throw new AccError('NUMBER', 'Сумма от — число'); }
      if (!v.isFinite() || v.lt(0) || v.decimalPlaces() > 2) throw new AccError('NUMBER', 'Сумма от — неотрицательное число (до 2 знаков)');
      out.minAmount = v;
    }
    if ('ttlHours' in b) {
      const t = Number(b.ttlHours);
      if (!Number.isInteger(t) || t < 1 || t > TTL_MAX) throw new AccError('TTL', `Срок согласования — от 1 до ${TTL_MAX} часов`);
      out.ttlHours = t;
    }
    if ('enabled' in b) out.enabled = !!b.enabled;
    return out;
  }

  async createPolicy(ctx: OrgContext, b: any) {
    const data = this.policyData({ docType: '*', minAmount: 0, ttlHours: 24, ...(b ?? {}) });
    if (!data.docKind) throw new AccError('BAD_KIND', `Вид документа: ${KINDS.join(', ')}`);
    const p = await this.prisma.approvalPolicy.create({ data: { ...(data as any), organizationId: ctx.organizationId, createdBy: ctx.userId } });
    await this.prisma.auditLog.create({ data: { userId: ctx.userId, organizationId: ctx.organizationId, action: 'APPROVAL_POLICY_CREATED', entity: 'approval_policy', entityId: p.id, after: { ...data, minAmount: p.minAmount.toFixed(2) } as any } });
    return p;
  }

  async updatePolicy(ctx: OrgContext, id: string, b: any) {
    const cur = await this.prisma.approvalPolicy.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!cur) throw new AccError('NOT_FOUND', 'Правило не найдено', { status: 404 });
    const data = this.policyData(b ?? {});
    const p = await this.prisma.approvalPolicy.update({ where: { id }, data });
    await this.prisma.auditLog.create({ data: { userId: ctx.userId, organizationId: ctx.organizationId, action: 'APPROVAL_POLICY_UPDATED', entity: 'approval_policy', entityId: id, after: { changes: Object.keys(data) } as any } });
    return p;
  }
}

const STATUS_TEXT: Record<string, string> = { APPROVED: 'согласовано', REJECTED: 'отклонено', SUPERSEDED: 'отменено изменением документа', CONSUMED: 'использовано' };
