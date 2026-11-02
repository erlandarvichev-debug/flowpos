// FP-041: основные средства и НМА — карточки, принятие к учёту, выбытие, амортизация за месяц.
// Амортизация прямолинейная: с месяца, следующего за принятием, по месяц выбытия включительно; месячная сумма —
// (стоимость − ликвидационная) / срок, последний месяц добирает остаток. Начисление за месяц — один раз на объект
// (регистр asset_depreciation) и одна запись в учёте; пересчёт открытого месяца заменяет запись новой версией.
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AccError } from '../common/acc-error';
import { OrgContext } from '../access/org-context';
import { D } from '../common/money';
import { DocumentsService } from '../documents/documents.service';
import { PostingService } from '../core/posting.service';
import { PeriodsService } from '../periods/periods.service';
import { PostingInput } from '../core/posting.types';
import { monthOf, nextMonth, postedDoc } from './asset-rules';

type Tx = Prisma.TransactionClient;
type Dec = Prisma.Decimal;
export const DEPR_SOURCE = 'ASSET_DEPRECIATION';
const DEPR_RULE = { code: 'KZ_ASSET_DEPRECIATION_SL', version: '1.0.0' };
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
const KIND_DEFAULTS: Record<string, { asset: string; depr: string }> = { FIXED: { asset: '2410', depr: '2420' }, INTANGIBLE: { asset: '2730', depr: '2740' } };
const EDITABLE = ['name', 'serialNumber', 'note', 'departmentId', 'employeeId'] as const;
const LOCKED = ['kind', 'assetAccount', 'deprAccount', 'expenseAccount', 'cost', 'salvage', 'usefulLifeMonths', 'method'] as const;
/** Сумма из формы: пусто — 0; не число — понятная ошибка (а не 500). */
function amount(v: unknown, what: string): Dec {
  if (v === undefined || v === null || String(v).trim() === '') return new D(0);
  const s = String(v).replace(/\s/g, '').replace(',', '.');
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) throw new AccError('BAD_AMOUNT', `${what}: число с не более чем двумя знаками после запятой`);
  return new D(s);
}
const lastDay = (p: string) => { const [y, m] = p.split('-').map(Number); return new Date(Date.UTC(y, m, 0)); };
const monthsBetween = (from: string, to: string) => { const [a, b] = [from, to].map((p) => p.split('-').map(Number)); return (b[0] - a[0]) * 12 + (b[1] - a[1]); };

export interface AssetState { status: 'DRAFT' | 'IN_USE' | 'DISPOSED'; acceptDoc: { id: string; number: string | null; date: string } | null; disposeDoc: { id: string; number: string | null; date: string } | null; accumulated: string; bookValue: string; lastPeriod: string | null }

/** Сумма амортизации объекта за месяц p (без записи). null — в этом месяце не начисляется. */
export function monthlyAmount(a: { cost: Dec | number | string; salvage: Dec | number | string; usefulLifeMonths: number }, start: string, p: string, accumulatedBefore: Dec): Dec | null {
  if (p < start) return null;
  const depreciable = new D(a.cost).minus(a.salvage);
  const remaining = depreciable.minus(accumulatedBefore);
  if (remaining.lte(0)) return null;
  const index = monthsBetween(start, p) + 1; // 1-й месяц амортизации
  if (index >= a.usefulLifeMonths) return remaining; // последний месяц — остаток (и докат, если пропусков не было)
  const monthly = depreciable.div(a.usefulLifeMonths).toDecimalPlaces(2);
  return D.min(monthly, remaining);
}

@Injectable()
export class AssetsService {
  constructor(private prisma: PrismaService, private docs: DocumentsService, private posting: PostingService, private periods: PeriodsService) {}

  private async state(tx: Tx | PrismaService, organizationId: string, a: { id: string; cost: Dec }): Promise<AssetState> {
    const [acc, disp, rows] = await Promise.all([
      postedDoc(tx as Tx, organizationId, 'ASSET_ACCEPT', a.id), postedDoc(tx as Tx, organizationId, 'ASSET_DISPOSE', a.id),
      tx.assetDepreciation.findMany({ where: { assetId: a.id }, orderBy: { period: 'asc' }, select: { amount: true, period: true } }),
    ]);
    const accumulated = rows.reduce((s, r) => s.plus(r.amount), new D(0));
    const ref = (d: any) => (d ? { id: d.id, number: d.number, date: d.date.toISOString().slice(0, 10) } : null);
    return {
      status: disp ? 'DISPOSED' : acc ? 'IN_USE' : 'DRAFT', acceptDoc: ref(acc), disposeDoc: ref(disp),
      accumulated: accumulated.toFixed(2), bookValue: disp ? '0.00' : new D(a.cost).minus(accumulated).toFixed(2), lastPeriod: rows.at(-1)?.period ?? null,
    };
  }

  async list(ctx: OrgContext, q: { kind?: string; search?: string; status?: string }) {
    const rows = await this.prisma.fixedAsset.findMany({
      where: { organizationId: ctx.organizationId, ...(q.kind ? { kind: q.kind } : {}), ...(q.search ? { OR: [{ name: { contains: q.search, mode: 'insensitive' } }, { inventoryNumber: { contains: q.search } }] } : {}) },
      orderBy: { inventoryNumber: 'asc' }, take: 1000,
    });
    const out = await Promise.all(rows.map(async (a) => ({ ...a, ...(await this.state(this.prisma, ctx.organizationId, a)) })));
    return q.status ? out.filter((a) => a.status === q.status) : out;
  }

  async get(ctx: OrgContext, id: string) {
    const a = await this.prisma.fixedAsset.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!a) throw new AccError('NOT_FOUND', 'Объект не найден', { status: 404 });
    const depreciation = await this.prisma.assetDepreciation.findMany({ where: { assetId: id }, orderBy: { period: 'asc' } });
    return { ...a, ...(await this.state(this.prisma, ctx.organizationId, a)), depreciation };
  }

  private async validRefs(ctx: OrgContext, b: any) {
    if (b.departmentId && !(await this.prisma.department.findFirst({ where: { id: b.departmentId, organizationId: ctx.organizationId } }))) throw new AccError('REF_FOREIGN', 'Подразделение не найдено');
    if (b.employeeId && !(await this.prisma.employee.findFirst({ where: { id: b.employeeId, organizationId: ctx.organizationId } }))) throw new AccError('REF_FOREIGN', 'Сотрудник не найден');
  }

  async create(ctx: OrgContext, b: any) {
    const kind = b.kind === 'INTANGIBLE' ? 'INTANGIBLE' : 'FIXED';
    const name = String(b.name ?? '').trim();
    if (name.length < 2) throw new AccError('NAME_REQUIRED', 'Укажите наименование объекта');
    const life = Number(b.usefulLifeMonths);
    if (!Number.isInteger(life) || life < 1 || life > 1200) throw new AccError('ASSET_LIFE_REQUIRED', 'Срок полезного использования — целое число месяцев от 1 до 1200');
    const cost = amount(b.cost, 'Стоимость'), salvage = amount(b.salvage, 'Ликвидационная стоимость');
    if (cost.lt(0) || salvage.lt(0) || (cost.gt(0) && salvage.gte(cost))) throw new AccError('ASSET_SALVAGE', 'Стоимость и ликвидационная стоимость: неотрицательные, ликвидационная меньше первоначальной');
    await this.validRefs(ctx, b);
    const inv = String(b.inventoryNumber ?? '').trim() || (await this.nextInventoryNumber(ctx, kind));
    const def = KIND_DEFAULTS[kind];
    const acc = (v: unknown, d: string) => { const s = String(v ?? d); if (!/^\d{4}$/.test(s)) throw new AccError('BAD_ACCOUNT', `Счёт ${s} — четыре цифры`); return s; };
    try {
      return await this.prisma.fixedAsset.create({
        data: {
          organizationId: ctx.organizationId, kind, inventoryNumber: inv, name, assetAccount: acc(b.assetAccount, def.asset), deprAccount: acc(b.deprAccount, def.depr),
          expenseAccount: acc(b.expenseAccount, '7030'), departmentId: b.departmentId || null, employeeId: b.employeeId || null, cost, salvage, usefulLifeMonths: life,
          serialNumber: b.serialNumber || null, note: b.note || null, createdBy: ctx.userId,
        },
      });
    } catch (e: any) {
      if (e?.code === 'P2002') throw new AccError('INVENTORY_NUMBER_TAKEN', `Инвентарный номер ${inv} уже занят`, { status: 409 });
      throw e;
    }
  }

  private async nextInventoryNumber(ctx: OrgContext, kind: string) {
    const prefix = kind === 'INTANGIBLE' ? 'НМА-' : 'ОС-';
    const n = await this.prisma.fixedAsset.count({ where: { organizationId: ctx.organizationId, inventoryNumber: { startsWith: prefix } } });
    return `${prefix}${String(n + 1).padStart(5, '0')}`;
  }

  /** Изменить карточку: стоимость, срок, счета — только до принятия к учёту. */
  async update(ctx: OrgContext, id: string, b: any) {
    const a = await this.get(ctx, id);
    const touchesLocked = LOCKED.some((k) => b[k] !== undefined && String(b[k]) !== String((a as any)[k]));
    if (touchesLocked && a.status !== 'DRAFT') throw new AccError('ASSET_LOCKED', 'Объект принят к учёту — стоимость, срок и счета не меняются (для изменения отмените принятие)', { status: 409 });
    await this.validRefs(ctx, b);
    const data: any = {};
    for (const k of EDITABLE) if (b[k] !== undefined) data[k] = b[k] || null;
    if (data.name !== undefined && String(data.name ?? '').trim().length < 2) throw new AccError('NAME_REQUIRED', 'Укажите наименование объекта');
    if (a.status === 'DRAFT') {
      if (b.cost !== undefined) data.cost = amount(b.cost, 'Стоимость');
      if (b.salvage !== undefined) data.salvage = amount(b.salvage, 'Ликвидационная стоимость');
      if (b.usefulLifeMonths !== undefined) {
        const life = Number(b.usefulLifeMonths);
        if (!Number.isInteger(life) || life < 1 || life > 1200) throw new AccError('ASSET_LIFE_REQUIRED', 'Срок полезного использования — целое число месяцев от 1 до 1200');
        data.usefulLifeMonths = life;
      }
      for (const k of ['assetAccount', 'deprAccount', 'expenseAccount'] as const) if (b[k] !== undefined) { if (!/^\d{4}$/.test(String(b[k]))) throw new AccError('BAD_ACCOUNT', 'Счёт — четыре цифры'); data[k] = String(b[k]); }
      const cost = data.cost ?? new D(a.cost), salvage = data.salvage ?? new D(a.salvage);
      if (cost.lt(0) || salvage.lt(0) || (cost.gt(0) && salvage.gte(cost))) throw new AccError('ASSET_SALVAGE', 'Ликвидационная стоимость меньше первоначальной');
    }
    // Перемещение между подразделениями после принятия — допустимо (история — в аудите).
    const row = await this.prisma.fixedAsset.update({ where: { id }, data });
    await this.prisma.auditLog.create({ data: { userId: ctx.userId, organizationId: ctx.organizationId, action: 'ASSET_UPDATED', entity: 'fixed_asset', entityId: id, before: a as any, after: row as any } });
    return row;
  }

  /** Принять к учёту: документ ASSET_ACCEPT создаётся и проводится (период, версии, аудит — как у документов учёта). */
  async accept(ctx: OrgContext, id: string, b: { date?: string; source?: 'SUPPLIER' | 'OTHER'; counterpartyId?: string; vatAmount?: string; corrAccount?: string; comment?: string }) {
    const a = await this.get(ctx, id);
    if (a.status !== 'DRAFT') throw new AccError('ASSET_ALREADY_ACCEPTED', `${a.inventoryNumber} уже принят к учёту`, { status: 409 });
    const doc = await this.docs.create(ctx, {
      docType: 'ASSET_ACCEPT', date: b.date ?? new Date().toISOString().slice(0, 10), comment: b.comment ?? `Принятие к учёту ${a.inventoryNumber} ${a.name}`,
      body: { assetId: a.id, cost: new D(a.cost).toFixed(2), source: b.source ?? 'OTHER', counterpartyId: b.counterpartyId, vatAmount: b.vatAmount ?? '0', corrAccount: b.corrAccount },
    });
    try { return await this.docs.post(ctx, doc.id); } catch (e) {
      await this.docs.cancel(ctx, doc.id, { reason: 'Принятие не проведено' }).catch(() => null);
      throw e;
    }
  }

  async dispose(ctx: OrgContext, id: string, b: { date?: string; reason?: string }) {
    const a = await this.get(ctx, id);
    if (a.status !== 'IN_USE') throw new AccError(a.status === 'DRAFT' ? 'ASSET_NOT_ACCEPTED' : 'ASSET_ALREADY_DISPOSED', a.status === 'DRAFT' ? `${a.inventoryNumber} не принят к учёту` : `${a.inventoryNumber} уже выбыл`, { status: 409 });
    const doc = await this.docs.create(ctx, { docType: 'ASSET_DISPOSE', date: b.date ?? new Date().toISOString().slice(0, 10), comment: `Выбытие ${a.inventoryNumber}: ${b.reason ?? ''}`.trim(), body: { assetId: a.id, cost: new D(a.cost).toFixed(2), reason: b.reason } });
    try { return await this.docs.post(ctx, doc.id); } catch (e) {
      await this.docs.cancel(ctx, doc.id, { reason: 'Выбытие не проведено' }).catch(() => null);
      throw e;
    }
  }

  /** Расчёт амортизации за месяц (без записи): по объектам организации. Пропуск прошлого месяца — ошибка. */
  async computeDepreciation(tx: Tx, ctx: OrgContext, period: string) {
    if (!PERIOD.test(period)) throw new AccError('BAD_PERIOD', 'Месяц — ГГГГ-ММ');
    const assets = await tx.fixedAsset.findMany({ where: { organizationId: ctx.organizationId }, orderBy: { inventoryNumber: 'asc' } });
    const rows: { asset: (typeof assets)[number]; amount: Dec; accumulated: Dec; bookValue: Dec }[] = [];
    const gaps: string[] = [];
    for (const a of assets) {
      const acc = await postedDoc(tx, ctx.organizationId, 'ASSET_ACCEPT', a.id);
      if (!acc) continue;
      const disp = await postedDoc(tx, ctx.organizationId, 'ASSET_DISPOSE', a.id);
      if (disp && monthOf(disp.date) < period) continue;
      const start = nextMonth(monthOf(acc.date));
      if (period < start) continue;
      const before = await tx.assetDepreciation.findMany({ where: { assetId: a.id, period: { lt: period } }, orderBy: { period: 'asc' } });
      const accumulated = before.reduce((s, r) => s.plus(r.amount), new D(0));
      // Все месяцы с начала до прошлого должны быть начислены (кроме уже самортизированного полностью).
      let expected = start, missing: string | null = null, acc2 = new D(0);
      for (const r of before) {
        if (r.period !== expected) { missing = expected; break; }
        acc2 = acc2.plus(r.amount); expected = nextMonth(expected);
      }
      if (!missing && expected < period && acc2.lt(new D(a.cost).minus(a.salvage))) missing = expected;
      if (missing) { gaps.push(`${a.inventoryNumber} — ${missing}`); continue; }
      const amount = monthlyAmount(a, start, period, accumulated);
      if (!amount) continue;
      const after = accumulated.plus(amount);
      rows.push({ asset: a, amount, accumulated: after, bookValue: new D(a.cost).minus(after) });
    }
    if (gaps.length) throw new AccError('ASSET_DEPR_GAP', `Не начислена амортизация за прошлые месяцы: ${gaps.slice(0, 10).join('; ')}${gaps.length > 10 ? '…' : ''}`, { fix: 'Начислите амортизацию по порядку, начиная с самого раннего месяца.' });
    return rows;
  }

  /** Начислить амортизацию за месяц (период открыт). Повторный запуск без изменений — ничего не меняет. */
  async depreciate(ctx: OrgContext, period: string) {
    return this.prisma.$transaction(async (tx) => {
      await this.periods.assertOpen(tx, ctx, [lastDay(period)], undefined, 'начисление амортизации');
      const later = await tx.assetDepreciation.findFirst({ where: { organizationId: ctx.organizationId, period: { gt: period } }, select: { period: true } });
      if (later) throw new AccError('ASSET_DEPR_LATER', `Амортизация уже начислена за ${later.period} — пересчёт более раннего месяца сначала требует отменить поздние`);
      const rows = await this.computeDepreciation(tx, ctx, period);
      const existing = await tx.assetDepreciation.findMany({ where: { organizationId: ctx.organizationId, period } });
      const sig = (xs: { assetId: string; amount: Dec | string }[]) => xs.map((x) => `${x.assetId}:${new D(x.amount).toFixed(2)}`).sort().join(';');
      if (existing.length && sig(existing) === sig(rows.map((r) => ({ assetId: r.asset.id, amount: r.amount })))) return { period, changed: false, rows: existing.length, total: rows.reduce((s, r) => s.plus(r.amount), new D(0)).toFixed(2) };
      const version = (existing.reduce((m, r) => Math.max(m, r.runVersion), 0) || (await this.lastRunVersion(tx, ctx, period))) + 1;
      await tx.assetDepreciation.deleteMany({ where: { organizationId: ctx.organizationId, period } });
      for (const r of rows) await tx.assetDepreciation.create({ data: { organizationId: ctx.organizationId, assetId: r.asset.id, period, amount: r.amount, accumulated: r.accumulated, bookValue: r.bookValue, runVersion: version, createdBy: ctx.userId } });
      // Проводки: свод по счёту затрат, счёту амортизации и подразделению.
      const groups = new Map<string, { expense: string; depr: string; dept: string | null; amount: Dec }>();
      for (const r of rows) {
        const k = `${r.asset.expenseAccount}|${r.asset.deprAccount}|${r.asset.departmentId ?? ''}`;
        const g = groups.get(k) ?? { expense: r.asset.expenseAccount, depr: r.asset.deprAccount, dept: r.asset.departmentId, amount: new D(0) };
        g.amount = g.amount.plus(r.amount);
        groups.set(k, g);
      }
      const P: PostingInput[] = [];
      for (const g of groups.values()) {
        const dims = g.dept ? { DEPARTMENT: g.dept } : {};
        P.push({ side: 'D', account: g.expense, amount: g.amount.toFixed(2), dims, memo: `Амортизация за ${period}` });
        P.push({ side: 'C', account: g.depr, amount: g.amount.toFixed(2), dims, memo: `Амортизация за ${period}` });
      }
      if (P.length) await this.posting.writeEntry(tx, ctx, { sourceType: DEPR_SOURCE, sourceId: period, sourceVersion: version, ruleCode: DEPR_RULE.code, ruleVersion: DEPR_RULE.version, date: lastDay(period), postings: P });
      else await this.posting.cancelSource(tx, ctx.organizationId, DEPR_SOURCE, period);
      const total = rows.reduce((s, r) => s.plus(r.amount), new D(0));
      await tx.auditLog.create({ data: { userId: ctx.userId, organizationId: ctx.organizationId, action: 'ASSET_DEPRECIATION', entity: 'asset_depreciation', entityId: period, after: { period, version, rows: rows.length, total: total.toFixed(2) } as any } });
      return { period, changed: true, rows: rows.length, total: total.toFixed(2), version };
    });
  }

  private async lastRunVersion(tx: Tx, ctx: OrgContext, period: string) {
    const e = await tx.accEntry.findFirst({ where: { organizationId: ctx.organizationId, sourceType: DEPR_SOURCE, sourceId: period }, orderBy: { sourceVersion: 'desc' }, select: { sourceVersion: true } });
    return e?.sourceVersion ?? 0;
  }

  /** Отменить начисление за месяц (период открыт; более поздних начислений нет), с причиной. */
  async cancelDepreciation(ctx: OrgContext, period: string, reason: string) {
    if (!PERIOD.test(period)) throw new AccError('BAD_PERIOD', 'Месяц — ГГГГ-ММ');
    if (String(reason ?? '').trim().length < 5) throw new AccError('REASON_REQUIRED', 'Укажите причину отмены (не короче 5 символов)');
    return this.prisma.$transaction(async (tx) => {
      await this.periods.assertOpen(tx, ctx, [lastDay(period)], undefined, 'отмена амортизации');
      const later = await tx.assetDepreciation.findFirst({ where: { organizationId: ctx.organizationId, period: { gt: period } }, select: { period: true } });
      if (later) throw new AccError('ASSET_DEPR_LATER', `Сначала отмените амортизацию за ${later.period}`);
      const disposed = await tx.accDocument.findFirst({ where: { organizationId: ctx.organizationId, docType: 'ASSET_DISPOSE', status: 'POSTED', date: { gte: new Date(`${period}-01T00:00:00Z`), lte: lastDay(period) } } });
      if (disposed) throw new AccError('ASSET_DISPOSED_IN_PERIOD', `В месяце проведено выбытие ${disposed.number} — сначала отмените его`);
      const n = await tx.assetDepreciation.deleteMany({ where: { organizationId: ctx.organizationId, period } });
      await this.posting.cancelSource(tx, ctx.organizationId, DEPR_SOURCE, period);
      await tx.auditLog.create({ data: { userId: ctx.userId, organizationId: ctx.organizationId, action: 'ASSET_DEPRECIATION_CANCELLED', entity: 'asset_depreciation', entityId: period, reason: reason.trim(), after: { rows: n.count } as any } });
      return { period, cancelled: n.count };
    });
  }

  /** Ведомость амортизации за месяц: начислено (регистр) и что начислилось бы сейчас. */
  async register(ctx: OrgContext, period: string) {
    if (!PERIOD.test(period)) throw new AccError('BAD_PERIOD', 'Месяц — ГГГГ-ММ');
    const rows = await this.prisma.assetDepreciation.findMany({ where: { organizationId: ctx.organizationId, period }, include: { asset: { select: { inventoryNumber: true, name: true, cost: true, expenseAccount: true } } }, orderBy: { asset: { inventoryNumber: 'asc' } } });
    let preview: any[] = [], previewError: string | null = null;
    try {
      preview = (await this.prisma.$transaction((tx) => this.computeDepreciation(tx, ctx, period))).map((r) => ({ assetId: r.asset.id, inventoryNumber: r.asset.inventoryNumber, name: r.asset.name, amount: r.amount.toFixed(2), accumulated: r.accumulated.toFixed(2), bookValue: r.bookValue.toFixed(2) }));
    } catch (e: any) { previewError = e?.getResponse?.()?.message ?? e.message; }
    return {
      period,
      posted: rows.map((r) => ({ assetId: r.assetId, inventoryNumber: r.asset.inventoryNumber, name: r.asset.name, amount: r.amount.toFixed(2), accumulated: r.accumulated.toFixed(2), bookValue: r.bookValue.toFixed(2), version: r.runVersion })),
      total: rows.reduce((s, r) => s.plus(r.amount), new D(0)).toFixed(2), preview, previewError,
      upToDate: !previewError && rows.length === preview.length && rows.every((r) => preview.some((p) => p.assetId === r.assetId && p.amount === r.amount.toFixed(2))),
    };
  }

  /** Для закрытия месяца: объекты, по которым амортизация за месяц не начислена или устарела. */
  async closingCheck(tx: Tx, ctx: OrgContext, period: string): Promise<{ due: number; posted: number; stale: boolean; error: string | null }> {
    try {
      const rows = await this.computeDepreciation(tx, ctx, period);
      const posted = await tx.assetDepreciation.findMany({ where: { organizationId: ctx.organizationId, period } });
      const stale = rows.length !== posted.length || rows.some((r) => !posted.some((p) => p.assetId === r.asset.id && new D(p.amount).eq(r.amount)));
      return { due: rows.length, posted: posted.length, stale, error: null };
    } catch (e: any) { return { due: 0, posted: 0, stale: true, error: e?.getResponse?.()?.message ?? e.message }; }
  }
}

/** Проверка для закрытия месяца без внедрения сервиса (расчёт не зависит от состояния сервиса). */
export function assetClosingCheck(tx: Tx, ctx: OrgContext, period: string): Promise<{ due: number; posted: number; stale: boolean; error: string | null }> {
  return AssetsService.prototype.closingCheck.call({ computeDepreciation: AssetsService.prototype.computeDepreciation } as any, tx, ctx, period);
}
