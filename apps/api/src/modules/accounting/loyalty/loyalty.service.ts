import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AccError } from '../common/acc-error';
import { D } from '../common/money';
import { OrgContext } from '../access/org-context';

const SALES = ['DEMAND', 'RETAIL_DEMAND'];
/** Начало сегодняшнего дня по Казахстану: продажи сегодняшней датой входят в программу, запущенную сегодня. */
const todayKz = () => new Date(`${new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10)}T00:00:00+05:00`);

/**
 * Бонусная программа: процент от покупок начисляется баллами (1 балл = 1 ₸) за каждую проведённую продажу покупателю
 * с даты запуска программы; отмена или удаление продажи снимает начисление. Списание — не больше остатка и не больше
 * установленной доли суммы документа. Начисления сверяются с документами при каждом чтении (идемпотентно).
 */
@Injectable()
export class LoyaltyService {
  constructor(private prisma: PrismaService) {}

  async settings(ctx: OrgContext) {
    const p = await this.prisma.loyaltyProgram.findUnique({ where: { organizationId: ctx.organizationId } });
    return p ?? { isActive: false, accrualPercent: '0', maxPayPercent: '50', startDate: null };
  }

  async saveSettings(ctx: OrgContext, b: any) {
    const pct = (v: any, what: string, max: number) => {
      const n = new D(String(v ?? '0').replace(',', '.') || '0');
      if (n.lt(0) || n.gt(max)) throw new AccError('BAD_PERCENT', `${what}: от 0 до ${max}%`);
      return n.toFixed(2);
    };
    const data = { isActive: !!b?.isActive, accrualPercent: pct(b?.accrualPercent, 'Начисление', 50), maxPayPercent: pct(b?.maxPayPercent ?? 50, 'Оплата баллами', 100), updatedBy: ctx.userId };
    const cur = await this.prisma.loyaltyProgram.findUnique({ where: { organizationId: ctx.organizationId } });
    const p = cur
      ? await this.prisma.loyaltyProgram.update({ where: { organizationId: ctx.organizationId }, data: { ...data, ...(!cur.isActive && data.isActive ? { startDate: todayKz() } : {}) } })
      : await this.prisma.loyaltyProgram.create({ data: { ...data, tenantId: ctx.tenantId, organizationId: ctx.organizationId, startDate: todayKz() } });
    await this.prisma.auditLog.create({ data: { userId: ctx.userId, organizationId: ctx.organizationId, action: 'LOYALTY_SETTINGS', entity: 'loyalty_program', entityId: p.id, after: data as any } });
    return p;
  }

  /** Сверка начислений с продажами: новые проведённые — начислить, отменённые/удалённые — снять. */
  private async reconcile(ctx: OrgContext, counterpartyId?: string) {
    const p = await this.prisma.loyaltyProgram.findUnique({ where: { organizationId: ctx.organizationId } });
    if (!p) return;
    const stores = (await this.prisma.store.findMany({ where: { organizationId: ctx.organizationId }, select: { id: true } })).map((s) => s.id);
    const docs = await this.prisma.document.findMany({
      where: {
        docType: { in: SALES as any }, status: 'POSTED', deleted: false, date: { gte: p.startDate }, counterpartyId: counterpartyId ?? { not: null },
        OR: [{ organizationId: ctx.organizationId }, { organizationId: null, storeId: { in: stores } }],
      },
      select: { id: true, counterpartyId: true, total: true },
    });
    const accruals = await this.prisma.bonusTransaction.findMany({ where: { organizationId: ctx.organizationId, kind: 'ACCRUAL', ...(counterpartyId ? { counterpartyId } : {}) }, select: { id: true, documentId: true } });
    const have = new Set(accruals.map((a) => a.documentId));
    const live = new Set(docs.map((d) => d.id));
    const stale = accruals.filter((a) => a.documentId && !live.has(a.documentId)).map((a) => a.id);
    if (stale.length) await this.prisma.bonusTransaction.deleteMany({ where: { id: { in: stale } } });
    if (!p.isActive || new D(p.accrualPercent).lte(0)) return;
    const fresh = docs.filter((d) => !have.has(d.id) && d.total && new D(d.total).gt(0)).map((d) => ({
      tenantId: ctx.tenantId, organizationId: ctx.organizationId, counterpartyId: d.counterpartyId!, kind: 'ACCRUAL', documentId: d.id,
      points: new D(d.total!).times(p.accrualPercent).div(100).toDecimalPlaces(2).toFixed(2),
    }));
    if (fresh.length) await this.prisma.bonusTransaction.createMany({ data: fresh, skipDuplicates: true });
  }

  private async balanceOf(ctx: OrgContext, counterpartyId: string) {
    const s = await this.prisma.bonusTransaction.aggregate({ where: { organizationId: ctx.organizationId, counterpartyId }, _sum: { points: true } });
    return new D(s._sum.points ?? 0);
  }

  /** Покупатели с баллами: остаток, начислено, списано. */
  async balances(ctx: OrgContext, q: { search?: string }) {
    await this.reconcile(ctx);
    const rows = await this.prisma.bonusTransaction.groupBy({ by: ['counterpartyId', 'kind'], where: { organizationId: ctx.organizationId }, _sum: { points: true } });
    const ids = [...new Set(rows.map((r) => r.counterpartyId))];
    const cps = ids.length ? await this.prisma.counterparty.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, phone: true, inn: true } }) : [];
    const s = String(q.search ?? '').trim().toLowerCase();
    return ids.map((id) => {
      const sum = (k: string) => new D(rows.find((r) => r.counterpartyId === id && r.kind === k)?._sum.points ?? 0);
      const c = cps.find((x) => x.id === id);
      return { counterpartyId: id, name: c?.name ?? id, phone: c?.phone ?? null, inn: c?.inn ?? null, accrued: sum('ACCRUAL').toFixed(2), spent: sum('SPEND').neg().toFixed(2), adjusted: sum('ADJUST').toFixed(2), balance: sum('ACCRUAL').plus(sum('SPEND')).plus(sum('ADJUST')).toFixed(2) };
    }).filter((r) => !s || `${r.name} ${r.phone ?? ''} ${r.inn ?? ''}`.toLowerCase().includes(s)).sort((a, b) => new D(b.balance).cmp(new D(a.balance)));
  }

  async history(ctx: OrgContext, counterpartyId: string) {
    await this.reconcile(ctx, counterpartyId);
    const items = await this.prisma.bonusTransaction.findMany({ where: { organizationId: ctx.organizationId, counterpartyId }, orderBy: { createdAt: 'desc' }, take: 500 });
    const docs = await this.prisma.document.findMany({ where: { id: { in: items.map((i) => i.documentId).filter(Boolean) as string[] } }, select: { id: true, number: true, docType: true, date: true, total: true } });
    return { balance: (await this.balanceOf(ctx, counterpartyId)).toFixed(2), items: items.map((i) => ({ ...i, document: docs.find((d) => d.id === i.documentId) ?? null })) };
  }

  /** Списать баллы (оплата покупки) или поправить вручную (ADJUST со знаком, с причиной). */
  async move(ctx: OrgContext, b: { counterpartyId?: string; kind?: string; points?: any; documentId?: string; comment?: string }) {
    if (!b?.counterpartyId) throw new AccError('COUNTERPARTY_REQUIRED', 'Укажите покупателя');
    const cp = await this.prisma.counterparty.findFirst({ where: { id: b.counterpartyId, tenantId: ctx.tenantId, OR: [{ organizationId: null }, { organizationId: ctx.organizationId }] }, select: { id: true } });
    if (!cp) throw new AccError('REF_FOREIGN', 'Покупатель не найден');
    const kind = b.kind === 'ADJUST' ? 'ADJUST' : 'SPEND';
    const pts = new D(String(b.points ?? '0').replace(',', '.') || '0');
    if (pts.isZero() || (kind === 'SPEND' && pts.lt(0))) throw new AccError('BAD_POINTS', 'Укажите количество баллов');
    const comment = String(b.comment ?? '').trim() || null;
    if (kind === 'ADJUST' && (!comment || comment.length < 3)) throw new AccError('REASON_REQUIRED', 'Ручное изменение баллов — с причиной');
    await this.reconcile(ctx, b.counterpartyId);
    const bal = await this.balanceOf(ctx, b.counterpartyId);
    if (kind === 'SPEND') {
      if (pts.gt(bal)) throw new AccError('NOT_ENOUGH_POINTS', `Недостаточно баллов: есть ${bal.toFixed(2)}`);
      if (b.documentId) {
        const p = await this.prisma.loyaltyProgram.findUnique({ where: { organizationId: ctx.organizationId } });
        const d = await this.prisma.document.findFirst({ where: { id: b.documentId, counterpartyId: b.counterpartyId }, select: { total: true } });
        if (!d) throw new AccError('REF_FOREIGN', 'Документ не найден у этого покупателя');
        const limit = new D(d.total ?? 0).times(p?.maxPayPercent ?? 50).div(100);
        if (pts.gt(limit)) throw new AccError('POINTS_LIMIT', `Баллами можно оплатить не больше ${limit.toFixed(2)} ₸ этого документа`);
      }
    } else if (bal.plus(pts).lt(0)) throw new AccError('NOT_ENOUGH_POINTS', `Остаток не может стать отрицательным (сейчас ${bal.toFixed(2)})`);
    try {
      await this.prisma.bonusTransaction.create({
        data: { tenantId: ctx.tenantId, organizationId: ctx.organizationId, counterpartyId: b.counterpartyId, kind, points: (kind === 'SPEND' ? pts.neg() : pts).toFixed(2), documentId: b.documentId || null, comment, createdBy: ctx.userId },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new AccError('ALREADY_SPENT', 'По этому документу баллы уже списаны');
      throw e;
    }
    return this.history(ctx, b.counterpartyId);
  }
}
