import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AccError } from '../common/acc-error';
import { OrgContext } from '../access/org-context';

export interface TaskInput {
  title?: string; description?: string | null; assigneeId?: string | null; dueAt?: string | null;
  counterpartyId?: string | null; documentId?: string | null; documentKind?: 'TRADE' | 'ACC' | null;
}

/** Срок: «ГГГГ-ММ-ДД» (до конца дня по Казахстану) или «ГГГГ-ММ-ДДTЧЧ:ММ» (время Казахстана). */
function parseDue(v: unknown): Date | null {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v);
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?$/.exec(s);
  if (!m) {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) throw new AccError('BAD_DATE', 'Срок задачи: дата ГГГГ-ММ-ДД или ГГГГ-ММ-ДДTЧЧ:ММ');
    return d;
  }
  return new Date(`${m[1]}T${m[2] ?? '23:59'}:00+05:00`);
}

/**
 * Задачи: поручение сотруднику организации со сроком; связь с контрагентом и документом; комментарии; выполнение.
 * Видят все сотрудники организации; менять — автор и исполнитель (или с правом управления сотрудниками).
 */
@Injectable()
export class TasksService {
  constructor(private prisma: PrismaService) {}

  private async checkRefs(ctx: OrgContext, b: TaskInput) {
    if (b.assigneeId) {
      const m = await this.prisma.orgMembership.findFirst({ where: { organizationId: ctx.organizationId, userId: b.assigneeId, isActive: true } });
      if (!m) throw new AccError('BAD_ASSIGNEE', 'Исполнитель должен быть сотрудником этой организации');
    }
    if (b.counterpartyId) {
      const c = await this.prisma.counterparty.findFirst({ where: { id: b.counterpartyId, tenantId: ctx.tenantId, OR: [{ organizationId: null }, { organizationId: ctx.organizationId }] }, select: { id: true } });
      if (!c) throw new AccError('REF_FOREIGN', 'Контрагент не найден');
    }
    if (b.documentId) {
      const kind = b.documentKind ?? 'TRADE';
      const d = kind === 'ACC'
        ? await this.prisma.accDocument.findFirst({ where: { id: b.documentId, organizationId: ctx.organizationId }, select: { id: true } })
        : await this.prisma.document.findFirst({ where: { id: b.documentId, OR: [{ organizationId: ctx.organizationId }, { organizationId: null, store: { organizationId: ctx.organizationId } }] }, select: { id: true } });
      if (!d) throw new AccError('REF_FOREIGN', 'Документ не найден');
    }
  }

  private async own(ctx: OrgContext, id: string) {
    const t = await this.prisma.task.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!t) throw new AccError('NOT_FOUND', 'Задача не найдена', { status: 404 });
    return t;
  }

  private canEdit(ctx: OrgContext, t: { createdBy: string; assigneeId: string | null }) {
    if (t.createdBy === ctx.userId || t.assigneeId === ctx.userId || ctx.can('org.members.manage')) return;
    throw new AccError('FORBIDDEN', 'Менять задачу могут автор, исполнитель или руководитель', { status: 403 });
  }

  /** Список: mine — мои (исполнитель), created — поставленные мной, all — все; по умолчанию невыполненные. */
  async list(ctx: OrgContext, q: { scope?: string; done?: string; counterpartyId?: string; documentId?: string; overdue?: string; search?: string; limit?: number }) {
    const where: Prisma.TaskWhereInput = { organizationId: ctx.organizationId };
    if (q.scope === 'mine' || !q.scope) where.assigneeId = ctx.userId;
    else if (q.scope === 'created') where.createdBy = ctx.userId;
    if (q.done !== 'all') where.done = q.done === '1';
    if (q.counterpartyId) where.counterpartyId = q.counterpartyId;
    if (q.documentId) where.documentId = q.documentId;
    if (q.overdue === '1') { where.done = false; where.dueAt = { lt: new Date() }; }
    if (q.search) where.OR = [{ title: { contains: q.search, mode: 'insensitive' } }, { description: { contains: q.search, mode: 'insensitive' } }];
    const items = await this.prisma.task.findMany({ where, orderBy: [{ done: 'asc' }, { dueAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }], take: Math.min(Number(q.limit) || 200, 500) });
    return this.decorate(ctx, items);
  }

  /** Счётчики для значка в меню: мои открытые и из них просроченные. */
  async summary(ctx: OrgContext) {
    const base = { organizationId: ctx.organizationId, assigneeId: ctx.userId, done: false };
    const [open, overdue, today] = await Promise.all([
      this.prisma.task.count({ where: base }),
      this.prisma.task.count({ where: { ...base, dueAt: { lt: new Date() } } }),
      this.prisma.task.count({ where: { ...base, dueAt: { gte: new Date(), lt: new Date(Date.now() + 86400000) } } }),
    ]);
    return { open, overdue, today };
  }

  async create(ctx: OrgContext, b: TaskInput) {
    const title = String(b?.title ?? '').trim();
    if (title.length < 2) throw new AccError('TITLE_REQUIRED', 'Опишите задачу (не короче 2 символов)');
    await this.checkRefs(ctx, b);
    const t = await this.prisma.task.create({
      data: {
        tenantId: ctx.tenantId, organizationId: ctx.organizationId, title, description: b.description?.trim() || null,
        assigneeId: b.assigneeId ?? ctx.userId, dueAt: parseDue(b.dueAt), counterpartyId: b.counterpartyId || null,
        documentId: b.documentId || null, documentKind: b.documentId ? b.documentKind ?? 'TRADE' : null, createdBy: ctx.userId,
      },
    });
    return (await this.decorate(ctx, [t]))[0];
  }

  async update(ctx: OrgContext, id: string, b: TaskInput) {
    const t = await this.own(ctx, id);
    this.canEdit(ctx, t);
    await this.checkRefs(ctx, b);
    const data: Prisma.TaskUpdateInput = {};
    if (b.title !== undefined) {
      const title = String(b.title ?? '').trim();
      if (title.length < 2) throw new AccError('TITLE_REQUIRED', 'Опишите задачу (не короче 2 символов)');
      data.title = title;
    }
    if (b.description !== undefined) data.description = b.description?.trim() || null;
    if (b.assigneeId !== undefined) data.assigneeId = b.assigneeId || null;
    if (b.dueAt !== undefined) data.dueAt = parseDue(b.dueAt);
    if (b.counterpartyId !== undefined) data.counterpartyId = b.counterpartyId || null;
    if (b.documentId !== undefined) { data.documentId = b.documentId || null; data.documentKind = b.documentId ? b.documentKind ?? 'TRADE' : null; }
    const u = await this.prisma.task.update({ where: { id }, data });
    return (await this.decorate(ctx, [u]))[0];
  }

  async setDone(ctx: OrgContext, id: string, done: boolean) {
    const t = await this.own(ctx, id);
    this.canEdit(ctx, t);
    const u = await this.prisma.task.update({ where: { id }, data: done ? { done: true, doneAt: new Date(), doneBy: ctx.userId } : { done: false, doneAt: null, doneBy: null } });
    return (await this.decorate(ctx, [u]))[0];
  }

  async comment(ctx: OrgContext, id: string, text: string) {
    const t = await this.own(ctx, id);
    const s = String(text ?? '').trim();
    if (!s) throw new AccError('TEXT_REQUIRED', 'Пустой комментарий');
    const comments = [...((t.comments as any[]) ?? []), { at: new Date().toISOString(), by: ctx.userId, text: s.slice(0, 2000) }];
    const u = await this.prisma.task.update({ where: { id }, data: { comments } });
    return (await this.decorate(ctx, [u]))[0];
  }

  async remove(ctx: OrgContext, id: string) {
    const t = await this.own(ctx, id);
    if (t.createdBy !== ctx.userId && !ctx.can('org.members.manage')) throw new AccError('FORBIDDEN', 'Удалить задачу может её автор', { status: 403 });
    await this.prisma.task.delete({ where: { id } });
    return { ok: true };
  }

  /** Имена исполнителя, автора, контрагента и документа; признак просрочки. */
  private async decorate(ctx: OrgContext, items: any[]) {
    const userIds = [...new Set(items.flatMap((t) => [t.assigneeId, t.createdBy, t.doneBy, ...((t.comments as any[]) ?? []).map((c) => c.by)]).filter(Boolean))] as string[];
    const cpIds = [...new Set(items.map((t) => t.counterpartyId).filter(Boolean))] as string[];
    const trade = items.filter((t) => t.documentId && t.documentKind !== 'ACC').map((t) => t.documentId);
    const acc = items.filter((t) => t.documentId && t.documentKind === 'ACC').map((t) => t.documentId);
    const [users, cps, tdocs, adocs] = await Promise.all([
      userIds.length ? this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true, firstName: true, lastName: true } }) : [],
      cpIds.length ? this.prisma.counterparty.findMany({ where: { id: { in: cpIds }, tenantId: ctx.tenantId }, select: { id: true, name: true, phone: true } }) : [],
      trade.length ? this.prisma.document.findMany({ where: { id: { in: trade } }, select: { id: true, number: true, docType: true, date: true } }) : [],
      acc.length ? this.prisma.accDocument.findMany({ where: { id: { in: acc }, organizationId: ctx.organizationId }, select: { id: true, number: true, docType: true, date: true } }) : [],
    ]);
    const uname = (id?: string | null) => {
      const u = (users as any[]).find((x) => x.id === id);
      return u ? [u.lastName, u.firstName].filter(Boolean).join(' ') || u.email : null;
    };
    const now = Date.now();
    return items.map((t) => ({
      ...t,
      assignee: t.assigneeId ? { id: t.assigneeId, name: uname(t.assigneeId) } : null,
      author: { id: t.createdBy, name: uname(t.createdBy) },
      counterparty: (cps as any[]).find((c) => c.id === t.counterpartyId) ?? null,
      document: [...(tdocs as any[]), ...(adocs as any[])].find((d) => d.id === t.documentId) ?? null,
      comments: ((t.comments as any[]) ?? []).map((c) => ({ ...c, author: uname(c.by) })),
      overdue: !t.done && !!t.dueAt && t.dueAt.getTime() < now,
    }));
  }
}
