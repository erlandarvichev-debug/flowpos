import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AccError } from '../common/acc-error';
import { D } from '../common/money';
import { OrgContext } from '../access/org-context';

export const EVENTS = ['DOC_CREATED', 'DOC_POSTED'] as const;
export const ACTIONS = ['CREATE_TASK', 'SET_ORDER_STAGE'] as const;
const STAGES = ['NEW', 'CONFIRMED', 'ASSEMBLING', 'ASSEMBLED', 'SENT'];
const DOC_TYPES = ['CUSTOMER_ORDER', 'PURCHASE_ORDER', 'INVOICE_OUT', 'INVOICE_IN', 'DEMAND', 'SUPPLY', 'SALES_RETURN', 'PURCHASE_RETURN', 'MOVE', 'INTERNAL_ORDER', 'LOSS', 'ENTER', 'INVENTORY'];

interface FireDoc { id: string; docType: string; number: string | null; total?: any; counterpartyId?: string | null; attributes?: any; updatedBy?: string | null }

/**
 * Сценарии «если — то»: при создании или проведении документа нужного вида (и условия по сумме / контрагенту) —
 * поставить задачу или сменить этап заказа. Ошибка сценария не мешает документу: пишется в сценарий (lastError).
 */
@Injectable()
export class AutomationService {
  private log = new Logger('Automation');
  constructor(private prisma: PrismaService) {}

  list(ctx: OrgContext) {
    return this.prisma.automationRule.findMany({ where: { organizationId: ctx.organizationId }, orderBy: { createdAt: 'asc' } });
  }

  private clean(b: any) {
    const name = String(b?.name ?? '').trim();
    if (name.length < 3) throw new AccError('NAME_REQUIRED', 'Назовите сценарий');
    if (!EVENTS.includes(b?.event)) throw new AccError('BAD_EVENT', 'Событие: документ создан или проведён');
    if (!DOC_TYPES.includes(b?.docType)) throw new AccError('BAD_DOC_TYPE', 'Выберите вид документа');
    if (!ACTIONS.includes(b?.action)) throw new AccError('BAD_ACTION', 'Действие: поставить задачу или сменить этап заказа');
    const c = b?.condition ?? {};
    const condition: any = {};
    if (c.minTotal !== undefined && c.minTotal !== null && c.minTotal !== '') {
      const n = new D(String(c.minTotal).replace(',', '.'));
      if (n.lt(0)) throw new AccError('BAD_CONDITION', 'Сумма в условии — не меньше нуля');
      condition.minTotal = n.toFixed(2);
    }
    if (c.counterpartyId) condition.counterpartyId = String(c.counterpartyId);
    const p = b?.params ?? {};
    let params: any;
    if (b.action === 'CREATE_TASK') {
      const title = String(p.title ?? '').trim();
      if (title.length < 3) throw new AccError('BAD_PARAMS', 'Текст задачи — не короче 3 символов');
      const dueDays = Number(p.dueDays ?? 0);
      if (!Number.isInteger(dueDays) || dueDays < 0 || dueDays > 365) throw new AccError('BAD_PARAMS', 'Срок задачи — от 0 до 365 дней');
      params = { title, dueDays, assignee: p.assignee || 'AUTHOR' };
    } else {
      if (!['CUSTOMER_ORDER', 'PURCHASE_ORDER'].includes(b.docType)) throw new AccError('BAD_PARAMS', 'Этап меняется только у заказов');
      if (!STAGES.includes(p.stage)) throw new AccError('BAD_PARAMS', 'Выберите этап заказа');
      params = { stage: p.stage };
    }
    return { name, isActive: b.isActive !== false, event: b.event, docType: b.docType, condition, action: b.action, params };
  }

  async save(ctx: OrgContext, id: string | null, b: any) {
    const data = this.clean(b);
    if (data.action === 'CREATE_TASK' && !['AUTHOR', 'RESPONSIBLE'].includes(data.params.assignee)) {
      const m = await this.prisma.orgMembership.findFirst({ where: { organizationId: ctx.organizationId, userId: data.params.assignee, isActive: true } });
      if (!m) throw new AccError('BAD_ASSIGNEE', 'Исполнитель должен быть сотрудником организации');
    }
    if (id) {
      const cur = await this.prisma.automationRule.findFirst({ where: { id, organizationId: ctx.organizationId } });
      if (!cur) throw new AccError('NOT_FOUND', 'Сценарий не найден', { status: 404 });
      return this.prisma.automationRule.update({ where: { id }, data: { ...data, lastError: null } });
    }
    return this.prisma.automationRule.create({ data: { ...data, tenantId: ctx.tenantId, organizationId: ctx.organizationId, createdBy: ctx.userId } });
  }

  async remove(ctx: OrgContext, id: string) {
    const cur = await this.prisma.automationRule.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!cur) throw new AccError('NOT_FOUND', 'Сценарий не найден', { status: 404 });
    await this.prisma.automationRule.delete({ where: { id } });
    return { ok: true };
  }

  /** Выполнить сценарии события для документа. Никогда не бросает: документ уже сохранён. */
  async fire(ctx: OrgContext, event: (typeof EVENTS)[number], doc: FireDoc) {
    let rules: any[] = [];
    try {
      rules = await this.prisma.automationRule.findMany({ where: { organizationId: ctx.organizationId, isActive: true, event, docType: doc.docType } });
    } catch { return; }
    for (const r of rules) {
      const c = (r.condition ?? {}) as any;
      if (c.minTotal && new D(doc.total ?? 0).lt(c.minTotal)) continue;
      if (c.counterpartyId && c.counterpartyId !== doc.counterpartyId) continue;
      try {
        const p = (r.params ?? {}) as any;
        if (r.action === 'CREATE_TASK') {
          const cp = doc.counterpartyId ? await this.prisma.counterparty.findUnique({ where: { id: doc.counterpartyId }, select: { name: true } }) : null;
          const title = String(p.title).replace(/\{номер\}/g, doc.number ?? '').replace(/\{контрагент\}/g, cp?.name ?? '').replace(/\{сумма\}/g, new D(doc.total ?? 0).toFixed(2));
          const assigneeId = p.assignee === 'RESPONSIBLE' ? doc.attributes?.responsibleId ?? ctx.userId : p.assignee === 'AUTHOR' ? ctx.userId : p.assignee;
          const due = new Date(`${new Date(Date.now() + 5 * 3600e3 + Number(p.dueDays ?? 0) * 86400e3).toISOString().slice(0, 10)}T18:00:00+05:00`);
          await this.prisma.task.create({
            data: { tenantId: ctx.tenantId, organizationId: ctx.organizationId, title, description: `Сценарий «${r.name}»`, assigneeId, dueAt: due, counterpartyId: doc.counterpartyId ?? null, documentId: doc.id, documentKind: 'TRADE', createdBy: ctx.userId },
          });
        } else if (r.action === 'SET_ORDER_STAGE') {
          const d = await this.prisma.document.findUnique({ where: { id: doc.id }, select: { attributes: true } });
          const a = (d?.attributes ?? {}) as any;
          if (!a.closed) await this.prisma.document.update({ where: { id: doc.id }, data: { attributes: { ...a, stage: p.stage } } });
        }
        await this.prisma.automationRule.update({ where: { id: r.id }, data: { runs: { increment: 1 }, lastRunAt: new Date(), lastError: null } });
      } catch (e: any) {
        this.log.warn(`Сценарий ${r.id}: ${e?.message}`);
        await this.prisma.automationRule.update({ where: { id: r.id }, data: { lastError: String(e?.message ?? e).slice(0, 500), lastRunAt: new Date() } }).catch(() => undefined);
      }
    }
  }
}
