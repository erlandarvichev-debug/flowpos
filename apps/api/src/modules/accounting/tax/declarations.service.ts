// FP-054: налоговые декларации (ФНО). Декларация собирается из ЗАФИКСИРОВАННОГО налогового регистра и утверждённого
// пакета правил; каждая строка — код формы, значение, формула или источник (расшифровка до регистра и документов).
// Контрольные соотношения — до фиксации. Готовая декларация неизменна (sql/150); сдача — отметка с квитанцией;
// исправление — дополнительная декларация со ссылкой на предыдущую.
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AccError } from '../common/acc-error';
import { OrgContext } from '../access/org-context';
import { TaxService } from './tax.service';
import { hashOf, TaxPackDef } from './rule-packs';
import { FORMS, FormDef, DeclLine, DeclCheck } from './forms';

type Tx = Prisma.TransactionClient;
const KINDS = ['INITIAL', 'ADDITIONAL', 'LIQUIDATION', 'BY_NOTICE'];

@Injectable()
export class DeclarationsService {
  constructor(private prisma: PrismaService, private tax: TaxService) {}

  private def(form: string): FormDef {
    const d = FORMS[form];
    if (!d) throw new AccError('FORM_UNKNOWN', `Форма ${form} не поддерживается`, { status: 404 });
    return d;
  }

  forms() {
    return Object.values(FORMS).map((f) => ({ form: f.form, title: f.title, periods: f.periods, registerKind: f.registerKind, verified: f.verified, note: f.note }));
  }

  /** Сборка черновика декларации: регистр за период должен быть зафиксирован. */
  async build(ctx: OrgContext, input: { form: string; year: number; period: string; kind?: string }) {
    const def = this.def(input.form);
    const year = Number(input.year), period = String(input.period ?? '');
    if (!def.periods.includes(period)) throw new AccError('BAD_PERIOD', `Период формы ${def.form}: ${def.periods.join(', ')}`);
    const kind = input.kind ?? 'INITIAL';
    if (!KINDS.includes(kind)) throw new AccError('BAD_KIND', 'Вид декларации: первоначальная, дополнительная, ликвидационная, по уведомлению');

    const reg = await this.prisma.taxRegister.findFirst({ where: { organizationId: ctx.organizationId, kind: def.registerKind, year, period: def.registerPeriod(period), status: 'FIXED' } });
    if (!reg) throw new AccError('REGISTER_NOT_FIXED', `Регистр ${def.registerKind} за ${def.registerPeriod(period)} ${year} не зафиксирован`, { fix: 'Соберите и зафиксируйте регистр в разделе «Налоги».', link: def.registerLink });
    const verify = await this.tax.verifyRegister(ctx, reg.id);
    if (!verify.same) throw new AccError('REGISTER_OUTDATED', 'Учёт изменился после фиксации регистра — пересоберите и зафиксируйте регистр заново');

    const prev = await this.prisma.taxDeclaration.findFirst({ where: { organizationId: ctx.organizationId, form: def.form, year, period, status: { in: ['FINAL', 'SUBMITTED', 'ACCEPTED'] } }, orderBy: { createdAt: 'desc' } });
    if (kind === 'INITIAL' && prev) throw new AccError('DECLARATION_EXISTS', 'Декларация за период уже составлена — для исправления подайте дополнительную', { status: 409 });
    if (kind === 'ADDITIONAL' && !prev) throw new AccError('NO_PREVIOUS', 'Дополнительная декларация подаётся к уже составленной');

    const pack = await this.prisma.taxRulePack.findUniqueOrThrow({ where: { id: reg.packId } });
    const packDef = { code: pack.code, version: pack.version, params: pack.params } as unknown as TaxPackDef;
    const org = await this.prisma.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { name: true, inn: true, legalForm: true } });
    const policy = await this.prisma.accPolicy.findFirst({ where: { organizationId: ctx.organizationId }, orderBy: { validFrom: 'desc' } });
    const built = def.build({ register: reg.data as any, pack: packDef, period, year, policy: policy as any });
    const header = { bin: org.inn, name: org.name, form: def.form, year, period, kind, previous: prev?.id ?? null, ...built.header, legalForm: org.legalForm === 'IP' ? 'IP' : 'LEGAL_ENTITY' };
    const core = { header, lines: built.lines.map((l) => [l.code, l.value]), register: reg.contentHash, pack: pack.contentHash };

    return this.prisma.$transaction(async (tx) => {
      await tx.taxDeclaration.deleteMany({ where: { organizationId: ctx.organizationId, form: def.form, year, period, status: 'DRAFT' } });
      return tx.taxDeclaration.create({
        data: {
          organizationId: ctx.organizationId, form: def.form, year, period, kind, previousId: prev?.id ?? null, registerId: reg.id,
          packId: reg.packId, packVersion: reg.packVersion, header: header as any, lines: built.lines as any, checks: built.checks as any,
          contentHash: hashOf(core), createdBy: ctx.userId,
        },
      });
    });
  }

  /** Готова к сдаче: контрольные соотношения выполнены, регистр не изменился. Дальше декларация неизменна. */
  async finalize(ctx: OrgContext, id: string) {
    const d = await this.get(ctx, id);
    if (d.status !== 'DRAFT') throw new AccError('NOT_DRAFT', 'Готовой можно сделать только черновик', { status: 409 });
    const failed = (d.checks as any as DeclCheck[]).filter((c) => !c.ok && c.severity === 'ERROR');
    if (failed.length) throw new AccError('CHECKS_FAILED', `Не выполнены контрольные соотношения: ${failed.map((c) => c.text).join('; ')}`);
    if (d.registerId) {
      const v = await this.tax.verifyRegister(ctx, d.registerId);
      if (!v.same) throw new AccError('REGISTER_OUTDATED', 'Учёт изменился после фиксации регистра — пересоберите регистр и декларацию');
      const reg = await this.prisma.taxRegister.findUniqueOrThrow({ where: { id: d.registerId } });
      if (reg.status !== 'FIXED') throw new AccError('REGISTER_OUTDATED', 'Регистр, из которого собрана декларация, заменён — пересоберите декларацию');
    }
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.taxDeclaration.update({ where: { id }, data: { status: 'FINAL', finalizedBy: ctx.userId, finalizedAt: new Date() } });
      await this.audit(tx, ctx, 'TAX_DECLARATION_FINAL', row);
      return row;
    });
  }

  /** Отметка о сдаче (из кабинета налогоплательщика / ИСНА) и о результате приёма. */
  async mark(ctx: OrgContext, id: string, input: { status: 'SUBMITTED' | 'ACCEPTED' | 'REJECTED'; number?: string; date?: string; note?: string }) {
    const d = await this.get(ctx, id);
    const flow: Record<string, string[]> = { FINAL: ['SUBMITTED'], SUBMITTED: ['ACCEPTED', 'REJECTED'] };
    if (!flow[d.status]?.includes(input.status)) throw new AccError('BAD_STATUS', `Из состояния «${d.status}» нельзя перейти в «${input.status}»`, { status: 409 });
    if (input.status === 'SUBMITTED' && !String(input.number ?? '').trim()) throw new AccError('RECEIPT_REQUIRED', 'Укажите регистрационный номер декларации из кабинета налогоплательщика');
    if (input.status === 'REJECTED' && String(input.note ?? '').trim().length < 5) throw new AccError('REASON_REQUIRED', 'Укажите причину отказа в приёме');
    const receipt = input.status === 'SUBMITTED'
      ? { number: String(input.number).trim(), date: input.date ?? new Date().toISOString().slice(0, 10), by: ctx.userId }
      : (d.receipt as any);
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.taxDeclaration.update({ where: { id }, data: { status: input.status, receipt: receipt as any, submittedAt: input.status === 'SUBMITTED' ? new Date() : d.submittedAt, statusNote: input.note ?? d.statusNote } });
      await this.audit(tx, ctx, `TAX_DECLARATION_${input.status}`, row, input.note);
      return row;
    });
  }

  async get(ctx: OrgContext, id: string) {
    const d = await this.prisma.taxDeclaration.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!d) throw new AccError('NOT_FOUND', 'Декларация не найдена', { status: 404 });
    return d;
  }

  list(ctx: OrgContext, q: { form?: string; year?: string }) {
    return this.prisma.taxDeclaration.findMany({
      where: { organizationId: ctx.organizationId, ...(q.form ? { form: q.form } : {}), ...(q.year ? { year: Number(q.year) } : {}) },
      orderBy: [{ year: 'desc' }, { period: 'desc' }, { createdAt: 'desc' }],
    });
  }

  private audit(tx: Tx, ctx: OrgContext, action: string, d: { id: string; form: string; year: number; period: string; kind: string; contentHash: string }, reason?: string) {
    return tx.auditLog.create({ data: { userId: ctx.userId, organizationId: ctx.organizationId, action, entity: 'tax_declaration', entityId: d.id, reason: reason ?? null, after: { form: d.form, year: d.year, period: d.period, kind: d.kind, hash: d.contentHash } as any } });
  }
}

export type { DeclLine, DeclCheck };
