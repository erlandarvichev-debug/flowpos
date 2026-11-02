// FP-039: пакеты налоговых правил (публикация, утверждение организацией) и налоговый регистр НДС за квартал.
// Регистр собирается из проведённых документов и сверяется с проводками по счёту НДС к уплате (3130): расхождение —
// ошибка регистра. Зачёт — из регистра зачёта НДС (FP-019). Зафиксированный регистр неизменен; «перепроверить» собирает
// его заново по тому же пакету и сравнивает хэш — воспроизводимость.
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AccError } from '../common/acc-error';
import { OrgContext } from '../access/org-context';
import { D } from '../common/money';
import { AutopilotService } from '../autopilot/autopilot.service';
import { TRADE_SOURCE, tradeLineAmounts } from '../autopilot/trade-rules';
import { BUILTIN_PACKS, TaxPackDef, hashOf, packHash } from './rule-packs';

type Tx = Prisma.TransactionClient;
type Dec = Prisma.Decimal;
const OUTPUT_TYPES = ['DEMAND', 'RETAIL_DEMAND', 'SALES_RETURN', 'RETAIL_RETURN'];
const RETURNS = new Set(['SALES_RETURN', 'RETAIL_RETURN']);
const PERIOD = /^Q[1-4]$/;
const iso = (d: Date) => d.toISOString().slice(0, 10);

function quarterRange(year: number, period: string) {
  if (!Number.isInteger(year) || year < 2000 || year > 2100 || !PERIOD.test(period)) throw new AccError('BAD_PERIOD', 'Период — год и квартал Q1–Q4');
  const q = Number(period[1]);
  return { from: new Date(Date.UTC(year, (q - 1) * 3, 1)), to: new Date(Date.UTC(year, q * 3, 0)) };
}

export interface VatRegisterData {
  pack: { code: string; version: string; hash: string };
  period: { year: number; period: string; from: string; to: string };
  output: {
    rows: { docId: string; docType: string; number: string | null; date: string; counterpartyBin: string | null; counterparty: string | null; byRate: { rate: string; base: string; vat: string }[]; vat: string; ledgerVat: string }[];
    byRate: { rate: string; base: string; vat: string }[];
    vat: string;
  };
  input: {
    rows: { esfId: string; num: string; registrationNumber: string | null; date: string; sellerTin: string | null; seller: string | null; kind: string; amount: string; base: string }[];
    credit: string;
    nonCreditable: string;
  };
  payable: string;
  issues: { severity: 'ERROR' | 'WARNING'; code: string; text: string; docId?: string }[];
}

export interface SimplifiedRegisterData {
  pack: { code: string; version: string; hash: string };
  period: { year: number; period: string; from: string; to: string };
  rule: { code: string; version: string; status: string; overrides: { include: string[]; exclude: string[] } };
  rows: { account: string; name: string; amount: string; included: boolean }[];
  income: string;
  limit: string;
  issues: { severity: 'ERROR' | 'WARNING'; code: string; text: string }[];
}

/** Какие доходы (счета раздела 6) входят в доход упрощёнки. Черновик: неденежные переоценки и восстановления — не доход. */
export const SIMPLIFIED_INCOME_RULE = {
  code: 'KZ_SIMPLIFIED_INCOME',
  version: '1.0.0-draft',
  status: 'METHODOLOGIST_REVIEW',
  /** Курсовые разницы, восстановление обесценения, изменение справедливой стоимости, доля в прибыли — не включаются. */
  exclude: ['6130', '6140', '6170', '6180', '6230', '6250', '6260', '6270'],
  include(code: string) { return code.startsWith('6') && !this.exclude.includes(code); },
} as const;

/** Часть регистра, значимая для налога (без наименований для показа): от неё — хэш и воспроизводимость. */
function coreOf(d: VatRegisterData) {
  return {
    pack: d.pack, period: d.period, payable: d.payable,
    output: { vat: d.output.vat, byRate: d.output.byRate, rows: d.output.rows.map(({ counterparty: _c, ...r }) => r) },
    input: { credit: d.input.credit, nonCreditable: d.input.nonCreditable, rows: d.input.rows.map(({ seller: _s, ...r }) => r) },
    issues: d.issues.map((i) => ({ code: i.code, docId: i.docId ?? null, severity: i.severity })),
  };
}

@Injectable()
export class TaxService {
  constructor(private prisma: PrismaService, private autopilot: AutopilotService) {}

  /** Встроенные версии пакетов — в БД (неизменно). Тот же номер версии с другим содержимым — ошибка выпуска. */
  async ensureBuiltin() {
    for (const p of BUILTIN_PACKS) {
      const hash = packHash(p);
      const row = await this.prisma.taxRulePack.findUnique({ where: { code_version: { code: p.code, version: p.version } } });
      if (row && row.contentHash !== hash) throw new AccError('TAX_PACK_CHANGED', `Пакет ${p.code} ${p.version} в коде отличается от опубликованного — выпустите новую версию`, { status: 500 });
      if (!row) {
        await this.prisma.taxRulePack.create({
          data: { code: p.code, version: p.version, validFrom: new Date(p.validFrom), validTo: p.validTo ? new Date(p.validTo) : null, params: p.params as any, sources: p.sources as any, unverified: p.unverified as any, contentHash: hash },
        }).catch((e: any) => (e?.code === 'P2002' ? null : Promise.reject(e)));
      }
    }
  }

  async packs(ctx: OrgContext) {
    await this.ensureBuiltin();
    const adoptions = await this.prisma.orgTaxPack.findMany({ where: { organizationId: ctx.organizationId }, orderBy: { approvedAt: 'desc' } });
    // Действующие пакеты и те, что организация когда-либо утверждала (выведенные из действия — для истории).
    const packs = await this.prisma.taxRulePack.findMany({ where: { OR: [{ status: 'PUBLISHED' }, { id: { in: adoptions.map((a) => a.packId) } }] }, orderBy: [{ code: 'asc' }, { validFrom: 'desc' }] });
    return packs.map((p) => ({ ...p, adoption: adoptions.find((a) => a.packId === p.id && a.status === 'ACTIVE') ?? null, history: adoptions.filter((a) => a.packId === p.id) }));
  }

  /** Утверждение пакета организацией: каждый неподтверждённый пункт — явно. */
  async adopt(ctx: OrgContext, packId: string, input: { acknowledged?: string[] }) {
    await this.ensureBuiltin();
    const pack = await this.prisma.taxRulePack.findUnique({ where: { id: packId } });
    if (!pack || pack.status !== 'PUBLISHED') throw new AccError('TAX_PACK_NOT_FOUND', 'Пакет правил не найден или выведен из действия', { status: 404 });
    if (packHash({ ...(pack as any), validFrom: iso(pack.validFrom), validTo: pack.validTo ? iso(pack.validTo) : null }) !== pack.contentHash) {
      throw new AccError('TAX_PACK_CORRUPT', 'Содержимое пакета не совпадает с хэшем — утверждение невозможно', { status: 500 });
    }
    const need = ((pack.unverified as any[]) ?? []).map((u) => u.key as string);
    const ack = new Set(input.acknowledged ?? []);
    const missing = need.filter((k) => !ack.has(k));
    if (missing.length) throw new AccError('TAX_PACK_ACK_REQUIRED', `Подтвердите пункты, требующие сверки: ${missing.join(', ')}`, { fix: 'Отметьте каждый пункт после сверки с текстом НПА.' });
    return this.prisma.$transaction(async (tx) => {
      const exists = await tx.orgTaxPack.findFirst({ where: { organizationId: ctx.organizationId, packId, status: 'ACTIVE' } });
      if (exists) throw new AccError('TAX_PACK_ALREADY_APPROVED', 'Пакет уже утверждён организацией', { status: 409 });
      const row = await tx.orgTaxPack.create({ data: { organizationId: ctx.organizationId, packId, contentHash: pack.contentHash, acknowledged: need as any, approvedBy: ctx.userId } });
      await tx.auditLog.create({ data: { userId: ctx.userId, organizationId: ctx.organizationId, action: 'TAX_PACK_APPROVED', entity: 'tax_rule_pack', entityId: packId, after: { version: `${pack.code} ${pack.version}`, hash: pack.contentHash, acknowledged: need } as any } });
      return row;
    });
  }

  async revoke(ctx: OrgContext, adoptionId: string, reason: string) {
    if (!reason || reason.trim().length < 5) throw new AccError('REASON_REQUIRED', 'Укажите причину отзыва (не короче 5 символов)');
    const a = await this.prisma.orgTaxPack.findFirst({ where: { id: adoptionId, organizationId: ctx.organizationId, status: 'ACTIVE' } });
    if (!a) throw new AccError('NOT_FOUND', 'Утверждение не найдено', { status: 404 });
    const row = await this.prisma.orgTaxPack.update({ where: { id: a.id }, data: { status: 'REVOKED', revokedBy: ctx.userId, revokedAt: new Date(), revokeReason: reason.trim() } });
    await this.prisma.auditLog.create({ data: { userId: ctx.userId, organizationId: ctx.organizationId, action: 'TAX_PACK_REVOKED', entity: 'tax_rule_pack', entityId: a.packId, reason: reason.trim() } });
    return row;
  }

  /** Утверждённый организацией пакет, действующий на дату. */
  async packFor(tx: Tx, organizationId: string, date: Date): Promise<{ id: string; def: TaxPackDef }> {
    const a = await tx.orgTaxPack.findFirst({
      where: { organizationId, status: 'ACTIVE', pack: { status: 'PUBLISHED', validFrom: { lte: date }, OR: [{ validTo: null }, { validTo: { gte: date } }] } },
      include: { pack: true }, orderBy: { pack: { validFrom: 'desc' } },
    });
    if (!a) throw new AccError('TAX_PACK_NOT_APPROVED', `Нет утверждённого пакета налоговых правил на ${iso(date)}`, { fix: 'Утвердите пакет в разделе «Налоги → Налоговые правила».', link: '/tax/rules' });
    if (a.contentHash !== a.pack.contentHash) throw new AccError('TAX_PACK_CORRUPT', 'Пакет изменился после утверждения', { status: 500 });
    const p = a.pack;
    return { id: p.id, def: { code: p.code, version: p.version, validFrom: iso(p.validFrom), validTo: p.validTo ? iso(p.validTo) : null, params: p.params as any, sources: p.sources as any, unverified: p.unverified as any } };
  }

  /** Сборка регистра НДС (без записи). packId — для перепроверки зафиксированного по тому же пакету. */
  async computeVat(ctx: OrgContext, year: number, period: string, packId?: string): Promise<{ packId: string; data: VatRegisterData; hash: string }> {
    const { from, to } = quarterRange(year, period);
    return this.prisma.$transaction(async (tx) => {
      let pack: { id: string; def: TaxPackDef };
      if (packId) {
        const p = await tx.taxRulePack.findUniqueOrThrow({ where: { id: packId } });
        pack = { id: p.id, def: { code: p.code, version: p.version, validFrom: iso(p.validFrom), validTo: p.validTo ? iso(p.validTo) : null, params: p.params as any, sources: p.sources as any, unverified: p.unverified as any } };
      } else pack = await this.packFor(tx, ctx.organizationId, to);
      const settings = await this.autopilot.accountsFor(tx, ctx.organizationId, to);
      if (!settings.vatPayer) throw new AccError('NOT_VAT_PAYER', 'Организация не плательщик НДС по учётной политике — регистр НДС не ведётся', { link: '/accounting/settings' });
      const issues: VatRegisterData['issues'] = [];
      const allowed = new Set([pack.def.params.vat.standardRate, ...pack.def.params.vat.reducedRates.map((r) => r.rate), 0].map((r) => new D(r).toFixed(2)));

      // Проводки по счёту НДС к уплате за период — по записям (источникам).
      const vatAcc = await tx.accAccount.findMany({ where: { code: { startsWith: settings.accounts.vatOut }, OR: [{ organizationId: null }, { organizationId: ctx.organizationId }] }, select: { id: true } });
      const vatPost = await tx.accPosting.findMany({
        where: { organizationId: ctx.organizationId, isActive: true, ledger: 'BU', accountId: { in: vatAcc.map((a) => a.id) }, date: { gte: from, lte: to }, entry: { status: 'ACTIVE' } },
        select: { side: true, amount: true, entry: { select: { sourceType: true, sourceId: true } } },
      });
      const ledgerByDoc = new Map<string, Dec>();
      let otherLedger = new D(0);
      for (const p of vatPost) {
        const v = p.side === 'C' ? new D(p.amount) : new D(p.amount).neg();
        if (p.entry.sourceType === TRADE_SOURCE) ledgerByDoc.set(p.entry.sourceId, (ledgerByDoc.get(p.entry.sourceId) ?? new D(0)).plus(v));
        else otherLedger = otherLedger.plus(v);
      }

      // Проведённые документы реализации/возврата организации за период.
      const stores = (await tx.store.findMany({ where: { organizationId: ctx.organizationId }, select: { id: true } })).map((s) => s.id);
      const docs = await tx.document.findMany({
        where: { docType: { in: OUTPUT_TYPES as any }, status: 'POSTED', deleted: false, date: { gte: from, lte: new Date(to.getTime() + 86_399_999) }, OR: [{ organizationId: ctx.organizationId }, { organizationId: null, storeId: { in: stores } }] },
        include: { lines: { include: { product: true }, orderBy: { lineNo: 'asc' } }, counterparty: { select: { name: true, inn: true } } },
        orderBy: [{ date: 'asc' }, { number: 'asc' }],
      });
      const entries = new Set((await tx.accEntry.findMany({ where: { organizationId: ctx.organizationId, sourceType: TRADE_SOURCE, sourceId: { in: docs.map((d) => d.id) }, status: 'ACTIVE' }, select: { sourceId: true } })).map((e) => e.sourceId));

      const rows: VatRegisterData['output']['rows'] = [];
      const totalByRate = new Map<string, { base: Dec; vat: Dec }>();
      for (const d of docs) {
        if (!entries.has(d.id)) { issues.push({ severity: 'ERROR', code: 'DOC_NOT_REFLECTED', text: `Документ ${d.number ?? d.id} проведён, но не отражён в учёте`, docId: d.id }); continue; }
        const sign = RETURNS.has(d.docType) ? -1 : 1;
        const byRate = new Map<string, { base: Dec; vat: Dec }>();
        let vat = new D(0);
        for (const l of d.lines.filter((x) => !new D(x.qty).isZero())) {
          const a = await tradeLineAmounts(tx, d as any, l as any, true);
          const rate = new D(a.rate ?? 0).toFixed(2);
          if (!allowed.has(rate)) issues.push({ severity: 'ERROR', code: 'RATE_NOT_IN_PACK', text: `Документ ${d.number ?? d.id}: ставка ${rate}% не предусмотрена пакетом ${pack.def.code} ${pack.def.version}`, docId: d.id });
          const cur = byRate.get(rate) ?? { base: new D(0), vat: new D(0) };
          cur.base = cur.base.plus(new D(a.net).times(sign));
          cur.vat = cur.vat.plus(new D(a.vat).times(sign));
          byRate.set(rate, cur);
          vat = vat.plus(new D(a.vat).times(sign));
        }
        const ledgerVat = ledgerByDoc.get(d.id) ?? new D(0);
        ledgerByDoc.delete(d.id);
        if (!ledgerVat.eq(vat)) issues.push({ severity: 'ERROR', code: 'LEDGER_MISMATCH', text: `Документ ${d.number ?? d.id}: НДС по строкам ${vat.toFixed(2)}, в учёте (3130) ${ledgerVat.toFixed(2)}`, docId: d.id });
        for (const [rate, v] of byRate) {
          const t = totalByRate.get(rate) ?? { base: new D(0), vat: new D(0) };
          totalByRate.set(rate, { base: t.base.plus(v.base), vat: t.vat.plus(v.vat) });
        }
        rows.push({
          docId: d.id, docType: d.docType, number: d.number, date: iso(d.date), counterpartyBin: d.counterparty?.inn ?? null, counterparty: d.counterparty?.name ?? null,
          byRate: [...byRate].sort(([a], [b]) => Number(b) - Number(a)).map(([rate, v]) => ({ rate, base: v.base.toFixed(2), vat: v.vat.toFixed(2) })),
          vat: vat.toFixed(2), ledgerVat: ledgerVat.toFixed(2),
        });
      }
      for (const [docId, v] of ledgerByDoc) if (!v.isZero()) issues.push({ severity: 'WARNING', code: 'LEDGER_OTHER_TRADE', text: `НДС ${v.toFixed(2)} по документу вне регистра (не реализация/возврат) — проверьте`, docId });
      // Прочие движения по 3130 (уплата в бюджет, ручные операции) в регистр не входят — для сведения.
      if (!otherLedger.isZero()) issues.push({ severity: 'WARNING', code: 'LEDGER_OTHER', text: `Прочие обороты по счёту ${settings.accounts.vatOut} (уплата, ручные операции): ${otherLedger.toFixed(2)} — в регистр не входят` });

      // Зачёт — регистр FP-019.
      const alloc = await tx.vatCreditAllocation.findMany({ where: { organizationId: ctx.organizationId, year, quarter: Number(period[1]) }, orderBy: { createdAt: 'asc' } });
      const esf = await tx.esfInvoice.findMany({ where: { id: { in: alloc.map((a) => a.esfInvoiceId) } }, select: { id: true, num: true, registrationNumber: true, date: true, sellerTin: true, sellerName: true, totalWithoutTax: true, totalNds: true } });
      let credit = new D(0), nonCred = new D(0);
      const inRows = alloc.map((a) => {
        const e = esf.find((x) => x.id === a.esfInvoiceId);
        const amt = new D(a.amount);
        if (a.kind === 'NON_CREDITABLE') nonCred = nonCred.plus(amt); else credit = credit.plus(amt); // CREDIT и REVERSAL (со знаком)
        // Оборот без НДС — в той же доле, что и сумма НДС строки зачёта от НДС ЭСФ (300.00.013 А / 015 А).
        const base = e && !new D(e.totalNds).isZero() ? new D(e.totalWithoutTax).times(amt).div(e.totalNds).toDecimalPlaces(2) : new D(0);
        return { esfId: a.esfInvoiceId, num: e?.num ?? '', registrationNumber: e?.registrationNumber ?? null, date: e ? iso(e.date) : '', sellerTin: e?.sellerTin ?? null, seller: e?.sellerName ?? null, kind: a.kind, amount: amt.toFixed(2), base: base.toFixed(2) };
      });

      const outVat = [...totalByRate.values()].reduce((s, v) => s.plus(v.vat), new D(0));
      const data: VatRegisterData = {
        pack: { code: pack.def.code, version: pack.def.version, hash: packHash(pack.def) },
        period: { year, period, from: iso(from), to: iso(to) },
        output: { rows, byRate: [...totalByRate].sort(([a], [b]) => Number(b) - Number(a)).map(([rate, v]) => ({ rate, base: v.base.toFixed(2), vat: v.vat.toFixed(2) })), vat: outVat.toFixed(2) },
        input: { rows: inRows, credit: credit.toFixed(2), nonCreditable: nonCred.toFixed(2) },
        payable: outVat.minus(credit).toFixed(2),
        issues,
      };
      return { packId: pack.id, data, hash: hashOf(coreOf(data)) };
    });
  }

  /** Черновик регистра: пересобрать и сохранить (прежний черновик заменяется). */
  async buildVat(ctx: OrgContext, year: number, period: string) {
    const r = await this.computeVat(ctx, Number(year), String(period));
    return this.prisma.$transaction(async (tx) => {
      await tx.taxRegister.deleteMany({ where: { organizationId: ctx.organizationId, kind: 'VAT', year: Number(year), period, status: 'DRAFT' } });
      return tx.taxRegister.create({ data: { organizationId: ctx.organizationId, kind: 'VAT', year: Number(year), period, packId: r.packId, packVersion: `${r.data.pack.code} ${r.data.pack.version}`, data: r.data as any, contentHash: r.hash, createdBy: ctx.userId } });
    });
  }

  /** Зафиксировать черновик: данные не изменились с момента сборки, ошибок нет; прежний зафиксированный — заменяется с причиной. */
  async fix(ctx: OrgContext, id: string, input: { reason?: string }) {
    const reg = await this.prisma.taxRegister.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!reg) throw new AccError('NOT_FOUND', 'Регистр не найден', { status: 404 });
    if (reg.status !== 'DRAFT') throw new AccError('REGISTER_NOT_DRAFT', 'Фиксируется только черновик', { status: 409 });
    const errors = ((reg.data as any).issues ?? []).filter((i: any) => i.severity === 'ERROR');
    if (errors.length) throw new AccError('REGISTER_HAS_ERRORS', `В регистре ошибки (${errors.length}): ${errors[0].text}`, { fix: 'Исправьте документы, пересоберите регистр.' });
    const now = reg.kind === 'VAT' ? await this.computeVat(ctx, reg.year, reg.period, reg.packId) : await this.computeSimplified(ctx, reg.year, reg.period, reg.packId);
    if (now.hash !== reg.contentHash) throw new AccError('REGISTER_STALE', 'Данные изменились после сборки — пересоберите регистр', { status: 409 });
    return this.prisma.$transaction(async (tx) => {
      const prev = await tx.taxRegister.findFirst({ where: { organizationId: ctx.organizationId, kind: reg.kind, year: reg.year, period: reg.period, status: 'FIXED' } });
      if (prev) {
        const reason = (input.reason ?? '').trim();
        if (reason.length < 5) throw new AccError('REASON_REQUIRED', 'Регистр за период уже зафиксирован — укажите причину замены (не короче 5 символов)');
        await tx.taxRegister.update({ where: { id: prev.id }, data: { status: 'SUPERSEDED', supersededBy: reg.id, supersedeReason: reason } });
      }
      const fixed = await tx.taxRegister.update({ where: { id: reg.id }, data: { status: 'FIXED', fixedBy: ctx.userId, fixedAt: new Date() } });
      await tx.auditLog.create({ data: { userId: ctx.userId, organizationId: ctx.organizationId, action: 'TAX_REGISTER_FIXED', entity: 'tax_register', entityId: reg.id, reason: input.reason ?? null, after: { kind: reg.kind, year: reg.year, period: reg.period, hash: reg.contentHash, pack: reg.packVersion, replaced: prev?.id ?? null } as any } });
      return fixed;
    });
  }

  /** Воспроизводимость любого регистра (по виду). */
  async verifyRegister(ctx: OrgContext, id: string) {
    const reg = await this.prisma.taxRegister.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!reg) throw new AccError('NOT_FOUND', 'Регистр не найден', { status: 404 });
    if (reg.kind === 'VAT') return this.verify(ctx, id);
    const now = await this.computeSimplified(ctx, reg.year, reg.period, reg.packId);
    const was = reg.data as any as SimplifiedRegisterData;
    return { same: now.hash === reg.contentHash, savedHash: reg.contentHash, currentHash: now.hash, was: { income: was.income }, now: { income: now.data.income }, changedDocs: [] as string[] };
  }

  /**
   * Регистр доходов упрощённой декларации (910.00) за полугодие: обороты по счетам раздела 6 (кредит − дебет; возвраты
   * 6020 уменьшают). Какие счета входят в доход — правило SIMPLIFIED_INCOME (черновик для методолога, ст. 724 НК);
   * организация может переопределить в учётной политике: params.simplifiedIncome = { include: [...], exclude: [...] }.
   */
  async computeSimplified(ctx: OrgContext, year: number, period: string, packId?: string): Promise<{ packId: string; data: SimplifiedRegisterData; hash: string }> {
    if (!Number.isInteger(year) || year < 2000 || year > 2100 || !/^H[12]$/.test(period)) throw new AccError('BAD_PERIOD', 'Период — год и полугодие H1/H2');
    const h = Number(period[1]);
    const from = new Date(Date.UTC(year, (h - 1) * 6, 1)), to = new Date(Date.UTC(year, h * 6, 0));
    return this.prisma.$transaction(async (tx) => {
      let pack: { id: string; def: TaxPackDef };
      if (packId) {
        const p = await tx.taxRulePack.findUniqueOrThrow({ where: { id: packId } });
        pack = { id: p.id, def: { code: p.code, version: p.version, validFrom: iso(p.validFrom), validTo: p.validTo ? iso(p.validTo) : null, params: p.params as any, sources: p.sources as any, unverified: p.unverified as any } };
      } else pack = await this.packFor(tx, ctx.organizationId, to);
      const policy = await tx.accPolicy.findFirst({ where: { organizationId: ctx.organizationId, validFrom: { lte: to } }, orderBy: { validFrom: 'desc' } });
      if (policy?.taxRegime !== 'SIMPLIFIED') throw new AccError('NOT_SIMPLIFIED', 'Налоговый режим организации — не упрощённая декларация (учётная политика)', { link: '/accounting/settings' });
      const ov = ((policy?.params as any) ?? {}).simplifiedIncome ?? {};
      const include = (code: string) => (ov.exclude ?? []).includes(code) ? false : (ov.include ?? []).includes(code) ? true : SIMPLIFIED_INCOME_RULE.include(code);
      const accounts = await tx.accAccount.findMany({ where: { code: { startsWith: '6' }, isGroup: false, OR: [{ organizationId: null }, { organizationId: ctx.organizationId }] }, select: { id: true, code: true, name: true } });
      const sums = await tx.accPosting.groupBy({
        by: ['accountId', 'side'], where: { organizationId: ctx.organizationId, isActive: true, ledger: 'BU', accountId: { in: accounts.map((a) => a.id) }, date: { gte: from, lte: to }, entry: { status: 'ACTIVE' } }, _sum: { amount: true },
      });
      const byAcc = new Map<string, Dec>();
      for (const r of sums) byAcc.set(r.accountId, (byAcc.get(r.accountId) ?? new D(0)).plus(r.side === 'C' ? new D(r._sum.amount ?? 0) : new D(r._sum.amount ?? 0).neg()));
      const rows = accounts.filter((a) => byAcc.has(a.id) && !byAcc.get(a.id)!.isZero()).sort((a, b) => a.code.localeCompare(b.code))
        .map((a) => ({ account: a.code, name: a.name, amount: byAcc.get(a.id)!.toFixed(2), included: include(a.code) }));
      const income = rows.filter((r) => r.included).reduce((s, r) => s.plus(r.amount), new D(0));
      const limit = new D(pack.def.params.mrp).times(pack.def.params.simplified.incomeLimitMrp);
      const issues: SimplifiedRegisterData['issues'] = [];
      if (income.gt(limit)) issues.push({ severity: 'WARNING', code: 'LIMIT_EXCEEDED', text: `Доход ${income.toFixed(2)} превышает предел ${limit.toFixed(2)} (${pack.def.params.simplified.incomeLimitMrp} МРП) — режим не применяется` });
      const data: SimplifiedRegisterData = {
        pack: { code: pack.def.code, version: pack.def.version, hash: packHash(pack.def) },
        period: { year, period, from: iso(from), to: iso(to) },
        rule: { code: SIMPLIFIED_INCOME_RULE.code, version: SIMPLIFIED_INCOME_RULE.version, status: SIMPLIFIED_INCOME_RULE.status, overrides: { include: ov.include ?? [], exclude: ov.exclude ?? [] } },
        rows, income: income.toFixed(2), limit: limit.toFixed(2), issues,
      };
      return { packId: pack.id, data, hash: hashOf({ ...data, rows: rows.map(({ name: _n, ...r }) => r) }) };
    });
  }

  async buildSimplified(ctx: OrgContext, year: number, period: string) {
    const r = await this.computeSimplified(ctx, Number(year), String(period));
    return this.prisma.$transaction(async (tx) => {
      await tx.taxRegister.deleteMany({ where: { organizationId: ctx.organizationId, kind: 'SIMPLIFIED', year: Number(year), period, status: 'DRAFT' } });
      return tx.taxRegister.create({ data: { organizationId: ctx.organizationId, kind: 'SIMPLIFIED', year: Number(year), period, packId: r.packId, packVersion: `${r.data.pack.code} ${r.data.pack.version}`, data: r.data as any, contentHash: r.hash, createdBy: ctx.userId } });
    });
  }

  /** Воспроизводимость: собрать заново по тому же пакету и сравнить с сохранённым. */
  async verify(ctx: OrgContext, id: string) {
    const reg = await this.prisma.taxRegister.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!reg) throw new AccError('NOT_FOUND', 'Регистр не найден', { status: 404 });
    const now = await this.computeVat(ctx, reg.year, reg.period, reg.packId);
    const was = reg.data as any as VatRegisterData;
    const docsWas = new Map(was.output.rows.map((r) => [r.docId, r.vat]));
    const docsNow = new Map(now.data.output.rows.map((r) => [r.docId, r.vat]));
    const changedDocs = [...new Set([...docsWas.keys(), ...docsNow.keys()])].filter((k) => docsWas.get(k) !== docsNow.get(k));
    return {
      same: now.hash === reg.contentHash, savedHash: reg.contentHash, currentHash: now.hash,
      was: { outputVat: was.output.vat, credit: was.input.credit, payable: was.payable },
      now: { outputVat: now.data.output.vat, credit: now.data.input.credit, payable: now.data.payable },
      changedDocs,
    };
  }

  list(ctx: OrgContext, q: { year?: string; kind?: string }) {
    return this.prisma.taxRegister.findMany({
      where: { organizationId: ctx.organizationId, kind: q.kind || 'VAT', ...(q.year ? { year: Number(q.year) } : {}) },
      orderBy: [{ year: 'desc' }, { period: 'desc' }, { createdAt: 'desc' }],
      select: { id: true, kind: true, year: true, period: true, packVersion: true, status: true, contentHash: true, createdAt: true, createdBy: true, fixedAt: true, fixedBy: true, supersededBy: true, supersedeReason: true, data: true },
    });
  }
}
