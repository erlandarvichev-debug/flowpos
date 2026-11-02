// Печатные формы: данные документа для подстановки, шаблоны (встроенные + версии организации), реквизиты для подписей.
// Отрисовка — в браузере (движок engine.ts в изолированной рамке, печать и PDF — средствами браузера).
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { AccError } from '../common/acc-error';
import { OrgContext } from '../access/org-context';
import { D } from '../common/money';
import { tradeLineAmounts } from '../autopilot/trade-rules';
import { reconciliation } from '../reports/reconciliation';
import { intWords, validate, words } from './engine';
import { BUILTIN_TEMPLATES, KINDS, PrintKind } from './templates';

const iso = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : '');

@Injectable()
export class PrintService {
  constructor(private prisma: PrismaService) {}

  kinds() { return KINDS; }

  /** Шаблоны вида: встроенные и версии организации (последняя версия каждого шаблона; по умолчанию — первым). */
  async templates(ctx: OrgContext, kind?: string) {
    const rows = await this.prisma.printTemplate.findMany({ where: { organizationId: ctx.organizationId, status: 'ACTIVE', ...(kind ? { kind } : {}) }, orderBy: [{ family: 'asc' }, { version: 'desc' }] });
    const latest = new Map<string, (typeof rows)[number]>();
    for (const r of rows) if (!latest.has(r.family)) latest.set(r.family, r);
    const own = [...latest.values()].map((r) => ({ id: r.id, kind: r.kind, name: r.name, version: r.version, family: r.family, builtin: false, isDefault: rows.some((x) => x.family === r.family && x.isDefault), basedOn: r.basedOn, createdAt: r.createdAt }));
    const builtin = BUILTIN_TEMPLATES.filter((t) => !kind || t.kind === kind).map((t) => ({ id: t.id, kind: t.kind, name: t.name, version: 0, family: t.id, builtin: true, isDefault: !own.some((o) => o.kind === t.kind && o.isDefault) && t.primary, basedOn: null, createdAt: null }));
    return [...own, ...builtin].sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
  }

  async template(ctx: OrgContext, id: string) {
    const b = BUILTIN_TEMPLATES.find((t) => t.id === id);
    if (b) return { id: b.id, kind: b.kind, name: b.name, html: b.html, version: 0, builtin: true, source: b.source };
    const t = await this.prisma.printTemplate.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!t) throw new AccError('NOT_FOUND', 'Шаблон не найден', { status: 404 });
    const versions = await this.prisma.printTemplate.findMany({ where: { organizationId: ctx.organizationId, family: t.family }, orderBy: { version: 'desc' }, select: { id: true, version: true, createdAt: true, createdBy: true } });
    return { ...t, builtin: false, versions };
  }

  /** Сохранить: новая версия шаблона (или первый вариант на основе встроенного). Текст проверяется. */
  async save(ctx: OrgContext, input: { family?: string; basedOn?: string; kind?: string; name?: string; html?: string; makeDefault?: boolean }) {
    const html = String(input.html ?? '');
    const problems = validate(html);
    if (problems.length) throw new AccError('TEMPLATE_INVALID', `Шаблон не сохранён: ${problems.join('; ')}`);
    const name = String(input.name ?? '').trim();
    if (name.length < 2) throw new AccError('NAME_REQUIRED', 'Укажите название шаблона');
    return this.prisma.$transaction(async (tx) => {
      let family = input.family, kind = input.kind, basedOn = input.basedOn ?? null, version = 1;
      if (family) {
        const last = await tx.printTemplate.findFirst({ where: { organizationId: ctx.organizationId, family }, orderBy: { version: 'desc' } });
        if (!last) throw new AccError('NOT_FOUND', 'Шаблон не найден', { status: 404 });
        kind = last.kind; basedOn = last.basedOn; version = last.version + 1;
      } else {
        if (basedOn && !BUILTIN_TEMPLATES.some((t) => t.id === basedOn)) throw new AccError('NOT_FOUND', 'Встроенный шаблон не найден', { status: 404 });
        kind = kind ?? BUILTIN_TEMPLATES.find((t) => t.id === basedOn)?.kind;
        if (!kind || !KINDS.some((k) => k.kind === kind)) throw new AccError('BAD_KIND', 'Укажите вид печатной формы');
        family = randomUUID();
      }
      const wasDefault = await tx.printTemplate.findFirst({ where: { organizationId: ctx.organizationId, family, isDefault: true } });
      if (input.makeDefault || wasDefault) await tx.printTemplate.updateMany({ where: { organizationId: ctx.organizationId, kind, isDefault: true }, data: { isDefault: false } });
      const row = await tx.printTemplate.create({ data: { organizationId: ctx.organizationId, kind: kind!, name, html, version, family: family!, basedOn, isDefault: !!(input.makeDefault || wasDefault), createdBy: ctx.userId } });
      await tx.auditLog.create({ data: { userId: ctx.userId, organizationId: ctx.organizationId, action: 'PRINT_TEMPLATE_SAVED', entity: 'print_template', entityId: row.id, after: { kind, name, version, family } as any } });
      return row;
    });
  }

  /** По умолчанию для вида: шаблон организации или встроенный (id встроенного — снять свой выбор). */
  async setDefault(ctx: OrgContext, id: string) {
    const b = BUILTIN_TEMPLATES.find((t) => t.id === id);
    const t = b ? null : await this.prisma.printTemplate.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!b && !t) throw new AccError('NOT_FOUND', 'Шаблон не найден', { status: 404 });
    const kind = b?.kind ?? t!.kind;
    await this.prisma.$transaction(async (tx) => {
      await tx.printTemplate.updateMany({ where: { organizationId: ctx.organizationId, kind, isDefault: true }, data: { isDefault: false } });
      if (t) await tx.printTemplate.update({ where: { id: t.id }, data: { isDefault: true } });
    });
    return this.templates(ctx, kind);
  }

  async archive(ctx: OrgContext, family: string) {
    const r = await this.prisma.printTemplate.updateMany({ where: { organizationId: ctx.organizationId, family }, data: { status: 'ARCHIVED', isDefault: false } });
    if (!r.count) throw new AccError('NOT_FOUND', 'Шаблон не найден', { status: 404 });
    return { archived: r.count };
  }

  settings(ctx: OrgContext) { return this.prisma.printSettings.findUnique({ where: { organizationId: ctx.organizationId } }); }

  async saveSettings(ctx: OrgContext, b: any) {
    const pick = (k: string) => (b?.[k] === undefined ? undefined : String(b[k] ?? '').trim().slice(0, 300) || null);
    const data = { address: pick('address'), phone: pick('phone'), director: pick('director'), accountant: pick('accountant'), cashier: pick('cashier'), kbe: pick('kbe'), updatedBy: ctx.userId };
    if (data.kbe && !/^\d{2}$/.test(data.kbe)) throw new AccError('BAD_KBE', 'Кбе — два знака (например 17)');
    return this.prisma.printSettings.upsert({ where: { organizationId: ctx.organizationId }, create: { organizationId: ctx.organizationId, ...data }, update: data });
  }

  // ── Данные для подстановки ──

  private async orgData(ctx: OrgContext) {
    const [org, s, bank] = await Promise.all([
      this.prisma.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { name: true, inn: true, legalForm: true, address: true, phone: true } }),
      this.prisma.printSettings.findUnique({ where: { organizationId: ctx.organizationId } }),
      this.prisma.orgBankAccount.findFirst({ where: { organizationId: ctx.organizationId, isActive: true, currency: 'KZT' }, orderBy: { createdAt: 'asc' } }),
    ]);
    return {
      name: org.name, bin: org.inn ?? '', address: s?.address ?? org.address ?? '', phone: s?.phone ?? org.phone ?? '',
      director: s?.director ?? '', accountant: s?.accountant ?? '', cashier: s?.cashier ?? '',
      kbe: s?.kbe ?? (org.legalForm === 'IP' ? '19' : '17'),
      bank: { name: bank?.bankName ?? '', iban: bank?.iban ?? '', bic: bank?.bic ?? '' },
    };
  }

  private async counterpartyData(id: string | null) {
    if (!id) return null;
    const cp = await this.prisma.counterparty.findUnique({ where: { id }, select: { name: true, inn: true } });
    if (!cp) return null;
    const [addr, bank] = await Promise.all([
      this.prisma.counterpartyAddress.findFirst({ where: { counterpartyId: id, validTo: null }, orderBy: { validFrom: 'desc' } }).catch(() => null),
      this.prisma.counterpartyBankAccount.findFirst({ where: { counterpartyId: id, validTo: null }, orderBy: [{ isDefault: 'desc' }, { validFrom: 'desc' }] }).catch(() => null),
    ]);
    return { name: cp.name, bin: cp.inn ?? '', address: addr?.line ?? '', bank: { name: bank?.bankName ?? '', iban: bank?.iban ?? '', bic: bank?.bik ?? '' } };
  }

  /** Данные для печати: kind — вид формы; id — документ (для акта сверки — параметры q). */
  async data(ctx: OrgContext, kind: string, id: string, q: any = {}) {
    const k = KINDS.find((x) => x.kind === kind);
    if (!k) throw new AccError('BAD_KIND', 'Неизвестный вид печатной формы', { status: 404 });
    const org = await this.orgData(ctx);
    if (k.source === 'RECON') {
      const r = await reconciliation(this.prisma, ctx, q);
      const closing = new D(r.closing);
      return {
        org, counterparty: { ...r.counterparty }, contract: r.contract, period: r.period, opening: r.opening, closing: r.closing,
        openingDebit: new D(r.opening).gt(0) ? r.opening : '', openingCredit: new D(r.opening).lt(0) ? new D(r.opening).neg().toFixed(2) : '',
        closingDebit: closing.gt(0) ? r.closing : '', closingCredit: closing.lt(0) ? closing.neg().toFixed(2) : '',
        turnover: r.turnover, lines: r.rows,
        result: closing.isZero() ? 'задолженность отсутствует' : closing.gt(0) ? `задолженность в пользу ${org.name} составляет ${closing.toFixed(2)} тенге` : `задолженность в пользу ${r.counterparty.name} составляет ${closing.neg().toFixed(2)} тенге`,
        resultAmount: closing.abs().toFixed(2), today: iso(new Date()),
      };
    }
    if (k.source === 'ACC') {
      const d = await this.prisma.accDocument.findFirst({ where: { id, organizationId: ctx.organizationId } });
      if (!d) throw new AccError('NOT_FOUND', 'Документ не найден', { status: 404 });
      if (!k.docTypes.includes(d.docType)) throw new AccError('WRONG_DOC_TYPE', `Форма «${k.title}» не для этого вида документа`);
      const b: any = d.body ?? {};
      const cp = await this.counterpartyData(b.counterpartyId ?? null);
      const emp = b.employeeId ? await this.prisma.employee.findFirst({ where: { id: b.employeeId, organizationId: ctx.organizationId }, select: { lastName: true, firstName: true, middleName: true } }).catch(() => null) : null;
      const person = emp ? [emp.lastName, emp.firstName, (emp as any).middleName].filter(Boolean).join(' ') : cp?.name ?? b.payerName ?? b.receiverName ?? '';
      const amount = new D(b.amount ?? d.amount ?? 0);
      const vat = b.vatAmount ? new D(b.vatAmount) : null;
      // Счета проводки для ордера: касса и корреспондирующие (из записи проведённого документа).
      const posts = await this.prisma.accPosting.findMany({ where: { organizationId: ctx.organizationId, isActive: true, entry: { sourceType: 'ACC_DOCUMENT', sourceId: d.id, status: 'ACTIVE' } }, include: { account: { select: { code: true } } } });
      const codes = (side: string) => [...new Set(posts.filter((p) => p.side === side).map((p) => p.account.code))].join(', ');
      const entry = { debit: codes('D'), credit: codes('C') };
      return {
        org, doc: { number: d.number ?? '', date: iso(d.date), type: d.docType, status: d.status, comment: d.comment ?? '' },
        person, counterparty: cp, basis: b.purpose ?? d.comment ?? '', amount: amount.toFixed(2), amountWords: words(amount.toFixed(2)),
        vat: vat ? vat.toFixed(2) : '', attachment: b.attachment ?? '', entry, today: iso(new Date()),
      };
    }
    // Торговый документ.
    const d = await this.prisma.document.findFirst({
      where: { id, OR: [{ organizationId: ctx.organizationId }, { organizationId: null, store: { organizationId: ctx.organizationId } }] },
      include: { lines: { include: { product: { include: { uom: true } } }, orderBy: { lineNo: 'asc' } }, store: { select: { name: true } } },
    });
    if (!d) throw new AccError('NOT_FOUND', 'Документ не найден', { status: 404 });
    if (!k.docTypes.includes(d.docType)) throw new AccError('WRONG_DOC_TYPE', `Форма «${k.title}» не для этого вида документа`);
    const policy = await this.prisma.accPolicy.findFirst({ where: { organizationId: ctx.organizationId, validFrom: { lte: d.date } }, orderBy: { validFrom: 'desc' } });
    const vatPayer = !!policy?.vatPayer;
    const only = k.lines === 'SERVICES' ? (l: any) => l.product.kind === 'SERVICE' : k.lines === 'GOODS' ? (l: any) => l.product.kind !== 'SERVICE' : () => true;
    let net = new D(0), vat = new D(0), gross = new D(0), qty = new D(0);
    const lines = [] as any[];
    for (const l of d.lines.filter((x) => !new D(x.qty).isZero()).filter(only)) {
      const a = await tradeLineAmounts(this.prisma as any, d as any, l as any, vatPayer);
      const q = new D(l.qty);
      net = net.plus(a.net); vat = vat.plus(a.vat); gross = gross.plus(a.gross); qty = qty.plus(q);
      lines.push({
        name: l.product.name, code: l.product.article ?? l.product.code ?? '', unit: l.product.uom?.shortName ?? '', qty: q.toFixed(3),
        price: q.isZero() ? '0.00' : new D(a.gross).div(q).toFixed(2), priceNet: q.isZero() ? '0.00' : new D(a.net).div(q).toFixed(2),
        amount: new D(a.gross).toFixed(2), net: new D(a.net).toFixed(2), vat: new D(a.vat).toFixed(2), vatRate: a.rate ? new D(a.rate).toString() : '',
      });
    }
    const contract = (d as any).contractId ? await this.prisma.contract.findUnique({ where: { id: (d as any).contractId }, select: { number: true, date: true } }) : null;
    const supplierSide = ['SUPPLY', 'PURCHASE_ORDER', 'PURCHASE_RETURN'].includes(d.docType);
    const cp = await this.counterpartyData(d.counterpartyId);
    return {
      org, counterparty: cp, store: d.store?.name ?? '', contract: contract ? { number: contract.number, date: iso(contract.date) } : null,
      doc: { number: d.number ?? '', date: iso(d.date), type: d.docType, status: d.status, comment: (d as any).comment ?? '' },
      lines, vatPayer,
      totals: { qty: qty.toFixed(3), net: net.toFixed(2), vat: vat.toFixed(2), amount: gross.toFixed(2), count: lines.length },
      amountWords: words(gross.toFixed(2)), vatWords: words(vat.toFixed(2)),
      qtyWords: qty.isInteger() ? intWords(qty.toNumber()) : qty.toFixed(3).replace(/0+$/, '').replace('.', ','),
      supplier: supplierSide ? cp : { name: org.name, bin: org.bin, address: org.address, bank: org.bank },
      buyer: supplierSide ? { name: org.name, bin: org.bin, address: org.address, bank: org.bank } : cp,
      today: iso(new Date()),
    };
  }
}
