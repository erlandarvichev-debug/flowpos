import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AccError } from '../common/acc-error';
import { money } from '../common/money';
import { OrgContext } from '../access/org-context';
import { ROLES, canGrant, ROLE_LABELS, ROLE_PERMISSIONS } from '../access/roles';
import { redactPay } from '../../../common/pay-fields';

const PAY_AUDIT_ENTITIES = new Set(['employment_contract', 'payroll_period']);

const IBAN_RE = /^KZ\d{2}[0-9A-Z]{16}$/;

/** Проверка IBAN по ISO 13616 (mod 97). */
export function isValidIban(iban: string): boolean {
  const s = iban.replace(/\s/g, '').toUpperCase();
  if (!IBAN_RE.test(s)) return false;
  const r = (s.slice(4) + s.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let mod = 0;
  for (const ch of r) mod = (mod * 10 + Number(ch)) % 97;
  return mod === 1;
}

type OrgModel = 'orgBankAccount' | 'cashbox' | 'accItem' | 'project';

@Injectable()
export class RefsService {
  constructor(private prisma: PrismaService) {}

  private audit(ctx: OrgContext, action: string, entity: string, entityId: string, after?: any, before?: any) {
    return this.prisma.auditLog.create({ data: { userId: ctx.userId, organizationId: ctx.organizationId, action, entity, entityId, after, before } });
  }

  currencies() { return this.prisma.currency.findMany({ orderBy: { code: 'asc' } }); }

  rates(q: { currency?: string; from?: string; to?: string }) {
    return this.prisma.currencyRate.findMany({
      where: {
        ...(q.currency ? { currencyCode: q.currency } : {}),
        ...(q.from || q.to ? { date: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) } } : {}),
      },
      orderBy: [{ date: 'desc' }, { currencyCode: 'asc' }], take: 500,
    });
  }

  async setRate(ctx: OrgContext, input: { currency: string; date: string; rate: string; multiplier?: number }) {
    if (input.currency === 'KZT') throw new AccError('BAD_CURRENCY', 'Курс тенге к тенге не задаётся');
    const rate = money(input.rate, 6, 'курс');
    if (rate.lte(0)) throw new AccError('BAD_RATE', 'Курс должен быть больше нуля');
    const r = await this.prisma.currencyRate.upsert({
      where: { currencyCode_date: { currencyCode: input.currency, date: new Date(input.date) } },
      create: { currencyCode: input.currency, date: new Date(input.date), rate, multiplier: input.multiplier ?? 1 },
      update: { rate, multiplier: input.multiplier ?? 1 },
    });
    await this.audit(ctx, 'RATE_SET', 'CurrencyRate', r.id, r);
    return r;
  }

  /** Курс на дату: последний известный не позже даты. */
  async rateOn(currency: string, date: Date) {
    if (currency === 'KZT') return { rate: '1', multiplier: 1 };
    const r = await this.prisma.currencyRate.findFirst({ where: { currencyCode: currency, date: { lte: date } }, orderBy: { date: 'desc' } });
    if (!r) throw new AccError('RATE_MISSING', `Нет курса ${currency} на ${date.toISOString().slice(0, 10)}`, { fix: 'Загрузите курс в справочнике «Курсы валют».', link: '/accounting/refs?tab=rates' });
    return r;
  }

  contracts(counterpartyId?: string) {
    return this.prisma.contract.findMany({
      where: { isActive: true, ...(counterpartyId ? { counterpartyId } : {}) },
      orderBy: [{ startDate: 'desc' }, { number: 'asc' }], take: 200,
      select: { id: true, number: true, name: true, counterpartyId: true, currency: true, startDate: true, endDate: true },
    });
  }

  vatRates() { return this.prisma.vatRate.findMany({ orderBy: [{ code: 'asc' }, { validFrom: 'asc' }] }); }

  list(ctx: OrgContext, model: OrgModel, q: { kind?: string } = {}) {
    return (this.prisma[model] as any).findMany({
      where: { organizationId: ctx.organizationId, ...(model === 'accItem' && q.kind ? { kind: q.kind } : {}) },
      orderBy: model === 'orgBankAccount' || model === 'cashbox' ? { name: 'asc' } : { code: 'asc' },
    });
  }

  async create(ctx: OrgContext, model: OrgModel, data: any) {
    if (model === 'orgBankAccount') {
      data.iban = String(data.iban || '').replace(/\s/g, '').toUpperCase();
      if (!isValidIban(data.iban)) throw new AccError('BAD_IBAN', 'IBAN некорректен', { fix: 'IBAN Казахстана: KZ + 18 символов, проверьте контрольные цифры.' });
    }
    if (model === 'accItem' && !['INCOME', 'EXPENSE', 'CASHFLOW'].includes(data.kind)) throw new AccError('BAD_KIND', 'Вид статьи: INCOME, EXPENSE или CASHFLOW');
    const row = await (this.prisma[model] as any).create({ data: { ...data, organizationId: ctx.organizationId } });
    await this.audit(ctx, 'CREATE', model, row.id, row);
    return row;
  }

  async update(ctx: OrgContext, model: OrgModel, id: string, data: any) {
    const before = await (this.prisma[model] as any).findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!before) throw new AccError('NOT_FOUND', 'Запись не найдена', { status: 404 });
    if (model === 'orgBankAccount' && data.iban) {
      data.iban = String(data.iban).replace(/\s/g, '').toUpperCase();
      if (!isValidIban(data.iban)) throw new AccError('BAD_IBAN', 'IBAN некорректен');
    }
    delete data.organizationId;
    const row = await (this.prisma[model] as any).update({ where: { id }, data });
    await this.audit(ctx, 'UPDATE', model, id, row, before);
    return row;
  }

  // ── Учётная политика (версии по дате начала действия) ──
  policies(ctx: OrgContext) {
    return this.prisma.accPolicy.findMany({ where: { organizationId: ctx.organizationId }, orderBy: { validFrom: 'desc' } });
  }

  async policyOn(ctx: OrgContext, date: Date) {
    return this.prisma.accPolicy.findFirst({ where: { organizationId: ctx.organizationId, validFrom: { lte: date } }, orderBy: { validFrom: 'desc' } });
  }

  async addPolicy(ctx: OrgContext, input: any) {
    const validFrom = new Date(input.validFrom);
    if (isNaN(validFrom.getTime())) throw new AccError('BAD_DATE', 'Укажите дату начала действия');
    const prev = await this.policyOn(ctx, validFrom);
    const data = {
      vatPayer: input.vatPayer ?? prev?.vatPayer ?? false,
      taxRegime: input.taxRegime ?? prev?.taxRegime ?? 'GENERAL',
      inventoryMethod: input.inventoryMethod ?? prev?.inventoryMethod ?? 'FIFO',
      allowNegativeStock: input.allowNegativeStock ?? prev?.allowNegativeStock ?? false,
      baseCurrency: 'KZT', chartId: prev?.chartId ?? null, params: input.params ?? prev?.params ?? undefined,
    };
    if (!['GENERAL', 'SIMPLIFIED', 'RETAIL_TAX', 'OTHER'].includes(data.taxRegime)) throw new AccError('BAD_REGIME', 'Неизвестный налоговый режим');
    if (!['FIFO', 'AVERAGE'].includes(data.inventoryMethod)) throw new AccError('BAD_METHOD', 'Метод оценки запасов: FIFO или AVERAGE');
    const row = await this.prisma.accPolicy.upsert({
      where: { organizationId_validFrom: { organizationId: ctx.organizationId, validFrom } },
      create: { ...data, organizationId: ctx.organizationId, validFrom, createdBy: ctx.userId },
      update: data,
    });
    await this.audit(ctx, 'POLICY_SET', 'AccPolicy', row.id, row, prev);
    return row;
  }

  // ── Организации и доступ ──
  async myOrganizations(userId: string) {
    const ms = await this.prisma.orgMembership.findMany({ where: { userId, isActive: true } });
    const orgs = await this.prisma.organization.findMany({ where: { id: { in: ms.map((m) => m.organizationId) } } });
    return orgs.map((o) => ({ ...o, role: ms.find((m) => m.organizationId === o.id)?.role }));
  }

  roles() {
    return ROLES.map((r) => ({ code: r, label: ROLE_LABELS[r], permissions: ROLE_PERMISSIONS[r] }));
  }

  async members(ctx: OrgContext) {
    const ms = await this.prisma.orgMembership.findMany({ where: { organizationId: ctx.organizationId } });
    const users = await this.prisma.user.findMany({ where: { id: { in: ms.map((m) => m.userId) } }, select: { id: true, email: true, firstName: true, lastName: true } });
    return ms.map((m) => ({ ...m, user: users.find((u) => u.id === m.userId) }));
  }

  async setMember(ctx: OrgContext, input: { email: string; role: string; isActive?: boolean }) {
    if (!ROLES.includes(input.role as any)) throw new AccError('BAD_ROLE', 'Неизвестная роль');
    // FP-008: назначить можно только роль, все права которой есть у назначающего (владельца — только владелец).
    if (!canGrant(ctx.role, input.role)) throw new AccError('ROLE_ESCALATION', `Нельзя назначить роль «${input.role}»: у вас нет всех её прав`, { status: 403 });
    // Участником может стать только пользователь того же клиента (FP-007): чужой email — «не найден».
    const user = await this.prisma.user.findFirst({ where: { email: input.email, tenantId: ctx.tenantId } });
    if (!user) throw new AccError('USER_NOT_FOUND', `Пользователь ${input.email} не найден`, { fix: 'Сначала создайте пользователя в разделе «Пользователи».' });
    if (user.id === ctx.userId && input.role !== ctx.role) throw new AccError('SELF_ROLE', 'Нельзя менять собственную роль');
    const before = await this.prisma.orgMembership.findUnique({ where: { userId_organizationId: { userId: user.id, organizationId: ctx.organizationId } } });
    if (before && user.id !== ctx.userId && !canGrant(ctx.role, before.role)) {
      throw new AccError('ROLE_ESCALATION', `Нельзя менять участника с ролью «${before.role}»: у вас нет всех её прав`, { status: 403 });
    }
    const row = await this.prisma.orgMembership.upsert({
      where: { userId_organizationId: { userId: user.id, organizationId: ctx.organizationId } },
      create: { userId: user.id, organizationId: ctx.organizationId, role: input.role, isActive: input.isActive ?? true },
      update: { role: input.role, isActive: input.isActive ?? true },
    });
    await this.audit(ctx, 'MEMBER_SET', 'OrgMembership', row.id, row, before);
    return row;
  }

  /** Новая организация: создатель становится владельцем. */
  async createOrganization(userId: string, input: { name: string; inn?: string; legalForm?: string; nameKk?: string; vatPayer?: boolean; taxRegime?: string }) {
    if (!input.name) throw new AccError('NAME_REQUIRED', 'Укажите наименование организации');
    return this.prisma.$transaction(async (tx) => {
      // Новая организация — у того же клиента (tenant), что и её создатель: доступ не выходит за клиента.
      const creator = await tx.user.findUnique({ where: { id: userId }, select: { tenantId: true } });
      if (!creator) throw new AccError('USER_NOT_FOUND', 'Пользователь не найден', { status: 404 });
      const org = await tx.organization.create({ data: { tenantId: creator.tenantId, name: input.name, inn: input.inn, legalForm: input.legalForm ?? 'TOO', nameKk: input.nameKk } });
      await tx.orgMembership.create({ data: { userId, organizationId: org.id, role: 'owner' } });
      const chart = await tx.accChart.findFirst({ where: { code: 'KZ-TYPICAL' }, orderBy: { version: 'desc' } });
      await tx.accPolicy.create({
        data: { organizationId: org.id, validFrom: new Date('2020-01-01'), chartId: chart?.id, vatPayer: !!input.vatPayer, taxRegime: input.taxRegime ?? 'GENERAL', createdBy: userId },
      });
      await tx.auditLog.create({ data: { userId, organizationId: org.id, action: 'ORG_CREATE', entity: 'Organization', entityId: org.id, after: org as any } });
      return org;
    });
  }

  async audit_log(ctx: OrgContext, q: { entity?: string; entityId?: string; limit?: number }) {
    const rows = await this.prisma.auditLog.findMany({
      where: { organizationId: ctx.organizationId, ...(q.entity ? { entity: q.entity } : {}), ...(q.entityId ? { entityId: q.entityId } : {}) },
      orderBy: { ts: 'desc' }, take: Math.min(500, Number(q.limit) || 100),
    });
    // Оклад и суммы в кадровых/зарплатных записях — только с payroll.read (FP-008); остальной журнал без изменений.
    if (ctx.can('payroll.read')) return rows;
    return rows.map((r) => (PAY_AUDIT_ENTITIES.has(r.entity) ? { ...r, before: redactPay(r.before), after: redactPay(r.after) } : r));
  }
}
