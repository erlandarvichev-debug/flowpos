// FP-024: приём входящего ЭСФ в реестр и карантин с контролируемой повторной обработкой.
// Правила (ТЗ, входящий ЭСФ):
//  • те же байты (тот же esfId и хэш) — повтор без нового эффекта, только обновление статуса ИС ЭСФ;
//  • тот же esfId, другой хэш — конфликт: реестр не перезаписывается, запись в карантин и оповещение;
//    разрешает человек с причиной (принять новую версию / оставить прежнюю);
//  • не прошёл проверку — карантин с исходным телом и причиной по таксономии (esf-inbound.ts); курсор идёт дальше;
//  • временные сбои (сеть, БД) — не карантин: исключение, курсор не сдвигается, следующий проход повторит.
import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { AccError } from '../common/acc-error';
import { D } from '../common/money';
import { OrgContext } from '../access/org-context';
import { redact } from '../../../common/redact';
import { InvoiceInfoRaw } from './esf-soap.client';
import { INBOUND_ERRORS, InboundCheck, InboundErrorCode, checkInbound } from './esf-inbound';
import { parseEsfDate } from './invoice-xml';

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const REASON_MIN = 10;

export type IngestResult =
  | { kind: 'imported'; invoiceId: string; created: boolean; confirm: boolean }
  | { kind: 'quarantined'; quarantineId: string; code: InboundErrorCode; isNew: boolean };

export type QuarantineAction = 'ACCEPT_NEW' | 'KEEP_EXISTING' | 'DISMISS';

export class EsfInboundService {
  constructor(private readonly prisma: PrismaService, private readonly log = new Logger('ESF')) {}

  /**
   * Один входящий ЭСФ → реестр или карантин. `replayOf` — повторная обработка записи карантина: её не дублируем,
   * а обновляем причину и счётчик попыток.
   */
  async ingest(organizationId: string, env: string, info: InvoiceInfoRaw, replayOf?: { id: string }): Promise<IngestResult> {
    const body = String(info.invoiceBody ?? '');
    const hash = sha256(body);
    const esfId = BigInt(info.invoiceId!);
    const key = { organizationId_environment_direction_esfId: { organizationId, environment: env, direction: 'INBOUND', esfId } };

    for (let attempt = 0; attempt < 2; attempt++) {
      const existing = await this.prisma.esfInvoice.findUnique({ where: key });
      if (existing) {
        // Статус ИС ЭСФ из конверта применяется в любом случае: он про документ с этим esfId, а не про тело.
        await this.prisma.esfInvoice.update({ where: { id: existing.id }, data: this.statusFields(info) });
        if (existing.bodyHash === hash) return { kind: 'imported', invoiceId: existing.id, created: false, confirm: info.invoiceStatus === 'CREATED' };
        return this.quarantine(organizationId, env, info, body, hash, { code: 'ESF_IN_HASH_CONFLICT', detail: `в реестре sha256 ${existing.bodyHash.slice(0, 12)}…, получено ${hash.slice(0, 12)}…` }, { invoiceId: existing.id, hash: existing.bodyHash }, replayOf);
      }

      const check = checkInbound(body, info.version);
      if (!check.ok) return this.quarantine(organizationId, env, info, body, hash, check, null, replayOf);

      try {
        const saved = await this.create(organizationId, env, info, body, hash, esfId, check);
        return { kind: 'imported', invoiceId: saved.id, created: true, confirm: saved.esfStatus === 'CREATED' };
      } catch (e) {
        if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== 'P2002') throw e;
        const target = String((e.meta as any)?.target ?? '');
        if (target.includes('esf_id')) continue; // параллельный проход успел записать тот же ЭСФ — сравниваем заново
        const p = check.parsed;
        const twin = await this.prisma.esfInvoice.findFirst({ where: { organizationId, environment: env, direction: 'INBOUND', sellerTin: p.seller.tin, num: p.num, date: check.date } });
        return this.quarantine(organizationId, env, info, body, hash,
          { code: 'ESF_IN_KEY_CONFLICT', detail: `продавец ${p.seller.tin}, № ${p.num} от ${p.date} уже в реестре${twin?.esfId != null ? ` (ЭСФ ${twin.esfId})` : ''}` },
          twin ? { invoiceId: twin.id, hash: twin.bodyHash } : null, replayOf);
      }
    }
    throw new Error(`Входящий ЭСФ ${esfId}: не удалось записать после повторного сравнения`);
  }

  private statusFields(info: InvoiceInfoRaw) {
    return {
      status: info.invoiceStatus ?? 'CREATED', esfStatus: info.invoiceStatus ?? null, registrationNumber: info.registrationNumber ?? null,
      cancelReason: info.cancelReason ?? null, lastUpdateAt: info.lastUpdateDate ? new Date(info.lastUpdateDate) : new Date(),
    };
  }

  /** Поля реестра из проверенного документа (новая запись или принятая новая версия). */
  private async fields(organizationId: string, env: string, info: InvoiceInfoRaw, body: string, hash: string, check: Extract<InboundCheck, { ok: true }>) {
    const p = check.parsed;
    const cp = await this.prisma.counterparty.findFirst({ where: { inn: p.seller.tin, deleted: false, OR: [{ organizationId }, { organizationId: null }] } });
    // Цепочка: исправленный/дополнительный ЭСФ — к исходному входящему того же продавца (FP-018).
    const rel = p.relatedInvoice;
    const related = rel && p.invoiceType !== 'ORDINARY_INVOICE'
      ? await this.prisma.esfInvoice.findFirst({
          where: { organizationId, environment: env, direction: 'INBOUND', sellerTin: p.seller.tin,
            OR: [...(rel.registrationNumber ? [{ registrationNumber: rel.registrationNumber }] : []), { num: rel.num, date: parseEsfDate(rel.date) }] },
        })
      : null;
    return {
      invoiceType: p.invoiceType, num: p.num, date: check.date, turnoverDate: check.turnoverDate,
      sellerTin: p.seller.tin ?? null, sellerName: p.seller.name ?? null, customerTin: p.customer.tin ?? null, customerName: p.customer.name ?? null,
      counterpartyId: cp?.id ?? null, currency: p.currencyCode,
      totalWithoutTax: new D(p.totals.priceWithoutTax), totalNds: new D(p.totals.ndsAmount), totalWithTax: new D(p.totals.priceWithTax),
      body, bodyHash: hash, relatedInvoiceId: related?.id ?? null, ...this.statusFields(info),
    };
  }

  private async create(organizationId: string, env: string, info: InvoiceInfoRaw, body: string, hash: string, esfId: bigint, check: Extract<InboundCheck, { ok: true }>) {
    const data = await this.fields(organizationId, env, info, body, hash, check);
    const saved = await this.prisma.esfInvoice.create({ data: { organizationId, environment: env, direction: 'INBOUND', esfId, ...data } });
    // Автоматика только предлагает поступление-основание; основанием его делает решение человека (FP-018).
    if (saved.counterpartyId) {
      const supply = await this.matchSupply(organizationId, saved.counterpartyId, saved.totalWithTax, saved.turnoverDate);
      if (supply) await this.prisma.esfInvoice.update({ where: { id: saved.id }, data: { suggestedSourceDocId: supply } });
    }
    return saved;
  }

  /** Поступление того же поставщика на ту же сумму (с НДС) в пределах ±10 дней от даты оборота. */
  private async matchSupply(organizationId: string, counterpartyId: string, total: Prisma.Decimal, date: Date) {
    const from = new Date(date.getTime() - 10 * 86400000), to = new Date(date.getTime() + 10 * 86400000);
    const docs = await this.prisma.document.findMany({ where: { organizationId, counterpartyId, docType: 'SUPPLY', status: 'POSTED', deleted: false, date: { gte: from, lte: to }, total: { gte: new D(total).minus('0.01'), lte: new D(total).plus('0.01') } }, select: { id: true } });
    if (docs.length !== 1) return null; // неоднозначно — оставляем на ручную привязку
    const taken = await this.prisma.esfInvoice.findFirst({ where: { organizationId, direction: 'INBOUND', sourceDocId: docs[0].id } });
    return taken ? null : docs[0].id;
  }

  /** Запись в карантин: одна на (ЭСФ, содержимое). Разрешённая запись повторным получением не открывается заново. */
  private async quarantine(organizationId: string, env: string, info: InvoiceInfoRaw, body: string, hash: string,
    err: { code: InboundErrorCode; detail: string }, existing: { invoiceId: string; hash: string } | null, replayOf?: { id: string }): Promise<IngestResult> {
    const detail = redact(err.detail).slice(0, 1000);
    if (replayOf) {
      await this.prisma.esfInboundQuarantine.update({ where: { id: replayOf.id }, data: { errorCode: err.code, errorDetail: detail, existingInvoiceId: existing?.invoiceId ?? null, existingHash: existing?.hash ?? null } });
      return { kind: 'quarantined', quarantineId: replayOf.id, code: err.code, isNew: false };
    }
    const where = { organizationId_environment_esfId_bodyHash: { organizationId, environment: env, esfId: BigInt(info.invoiceId!), bodyHash: hash } };
    const seen = { lastSeenAt: new Date(), seenCount: { increment: 1 }, invoiceStatus: info.invoiceStatus ?? null };
    const prev = await this.prisma.esfInboundQuarantine.findUnique({ where });
    if (prev) {
      await this.prisma.esfInboundQuarantine.update({ where: { id: prev.id }, data: seen });
      return { kind: 'quarantined', quarantineId: prev.id, code: prev.errorCode as InboundErrorCode, isNew: false };
    }
    const { invoiceBody: _b, ...envelope } = info as any;
    try {
      const q = await this.prisma.esfInboundQuarantine.create({
        data: {
          organizationId, environment: env, esfId: BigInt(info.invoiceId!), registrationNumber: info.registrationNumber ?? null, invoiceStatus: info.invoiceStatus ?? null,
          envelope: redactEnvelope(envelope), body, bodyHash: hash, bodyBytes: Buffer.byteLength(body, 'utf8'), errorCode: err.code, errorDetail: detail,
          existingInvoiceId: existing?.invoiceId ?? null, existingHash: existing?.hash ?? null,
        },
      });
      await this.prisma.auditLog.create({ data: { userId: null, organizationId, action: 'ESF_QUARANTINE_ADDED', entity: 'esf_inbound_quarantine', entityId: q.id,
        after: { esfId: String(info.invoiceId), registrationNumber: info.registrationNumber ?? null, code: err.code, detail, bodySha256: hash, existingInvoiceId: existing?.invoiceId ?? null, existingHash: existing?.hash ?? null } as any } });
      this.log.warn(`Входящий ЭСФ ${info.invoiceId} в карантине: ${err.code} — ${detail}`);
      return { kind: 'quarantined', quarantineId: q.id, code: err.code, isNew: true };
    } catch (e) {
      // Параллельный проход записал ту же запись — это одно и то же получение.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const q = await this.prisma.esfInboundQuarantine.update({ where, data: seen });
        return { kind: 'quarantined', quarantineId: q.id, code: q.errorCode as InboundErrorCode, isNew: false };
      }
      throw e;
    }
  }

  // ── Работа с карантином (поддержка и бухгалтер) ──

  private describe<T extends { errorCode: string; esfId: bigint }>(q: T) {
    const t = INBOUND_ERRORS[q.errorCode as InboundErrorCode];
    return { ...q, esfId: q.esfId.toString(), errorTitle: t?.title ?? q.errorCode, errorAction: t?.action ?? null, replayable: !!t?.replayable };
  }

  async list(ctx: OrgContext, q: { status?: string } = {}) {
    const status = q.status === 'RESOLVED' || q.status === 'ALL' ? q.status : 'OPEN';
    const rows = await this.prisma.esfInboundQuarantine.findMany({
      where: { organizationId: ctx.organizationId, ...(status === 'ALL' ? {} : { status }) },
      orderBy: { firstSeenAt: 'desc' }, take: 500,
      select: { id: true, environment: true, esfId: true, registrationNumber: true, invoiceStatus: true, bodyHash: true, bodyBytes: true, errorCode: true, errorDetail: true,
        existingInvoiceId: true, status: true, resolution: true, resolutionReason: true, resolvedBy: true, resolvedAt: true, resultInvoiceId: true,
        replayAttempts: true, lastReplayAt: true, firstSeenAt: true, lastSeenAt: true, seenCount: true, traceId: true },
    });
    const counts = await this.prisma.esfInboundQuarantine.groupBy({ by: ['errorCode'], where: { organizationId: ctx.organizationId, status: 'OPEN' }, _count: true });
    return { items: rows.map((r) => this.describe(r)), open: Object.fromEntries(counts.map((c) => [c.errorCode, c._count])) };
  }

  async get(ctx: OrgContext, id: string) {
    const q = await this.prisma.esfInboundQuarantine.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!q) throw new AccError('NOT_FOUND', 'Запись карантина не найдена', { status: 404 });
    const existing = q.existingInvoiceId
      ? await this.prisma.esfInvoice.findFirst({ where: { id: q.existingInvoiceId, organizationId: ctx.organizationId }, select: { id: true, num: true, date: true, sellerTin: true, sellerName: true, totalWithTax: true, status: true, bodyHash: true, body: true, businessDecision: true } })
      : null;
    const history = await this.prisma.auditLog.findMany({ where: { organizationId: ctx.organizationId, entity: 'esf_inbound_quarantine', entityId: id }, orderBy: { ts: 'asc' }, select: { ts: true, action: true, userId: true, reason: true, after: true, traceId: true } });
    return { ...this.describe(q), bodyIntact: sha256(q.body) === q.bodyHash, existing, history };
  }

  /**
   * Повторная обработка сохранённого тела текущими правилами разбора (после исправления FlowPOS или справочников).
   * Ничего не запрашивает у ИС ЭСФ; результат и причина — в журнале. Успех закрывает запись (REPLAYED).
   */
  async replay(ctx: OrgContext, id: string, reason: string) {
    const why = String(reason ?? '').trim();
    if (why.length < REASON_MIN) throw new AccError('REASON_REQUIRED', `Укажите причину повторной обработки (что исправлено) — не короче ${REASON_MIN} символов`);
    const q = await this.prisma.esfInboundQuarantine.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!q) throw new AccError('NOT_FOUND', 'Запись карантина не найдена', { status: 404 });
    if (q.status !== 'OPEN') throw new AccError('ESF_QUARANTINE_RESOLVED', 'Запись уже разобрана', { status: 409 });
    if (!INBOUND_ERRORS[q.errorCode as InboundErrorCode]?.replayable) {
      throw new AccError('ESF_QUARANTINE_NOT_REPLAYABLE', `Повторная обработка не поможет: ${INBOUND_ERRORS[q.errorCode as InboundErrorCode]?.title ?? q.errorCode}`, { fix: INBOUND_ERRORS[q.errorCode as InboundErrorCode]?.action });
    }
    if (sha256(q.body) !== q.bodyHash) {
      throw new AccError('ESF_QUARANTINE_BODY_INCOMPLETE', 'Сохранённое тело не совпадает с хэшем полученного (обрезано при переносе из журнала) — повторная обработка невозможна', { fix: 'Работайте с документом в портале ИС ЭСФ; закройте запись с причиной.' });
    }
    const env = (q.envelope ?? {}) as Record<string, any>;
    const info: InvoiceInfoRaw = { ...env, invoiceBody: q.body, invoiceId: q.esfId.toString(), registrationNumber: q.registrationNumber ?? undefined, invoiceStatus: q.invoiceStatus ?? undefined };
    await this.prisma.esfInboundQuarantine.update({ where: { id }, data: { replayAttempts: { increment: 1 }, lastReplayAt: new Date() } });
    const before = q.errorCode;
    const res = await this.ingest(ctx.organizationId, q.environment, info, { id });
    if (res.kind === 'imported') {
      const done = await this.prisma.esfInboundQuarantine.updateMany({ where: { id, status: 'OPEN' }, data: { status: 'RESOLVED', resolution: 'REPLAYED', resolutionReason: why, resolvedBy: ctx.userId, resolvedAt: new Date(), resultInvoiceId: res.invoiceId } });
      await this.audit(ctx, id, 'ESF_QUARANTINE_REPLAYED', why, { outcome: res.created ? 'IMPORTED' : 'ALREADY_IN_REGISTRY', invoiceId: res.invoiceId, previousCode: before, resolvedNow: done.count === 1 });
      return { outcome: res.created ? 'IMPORTED' : 'ALREADY_IN_REGISTRY', invoiceId: res.invoiceId };
    }
    await this.audit(ctx, id, 'ESF_QUARANTINE_REPLAY_FAILED', why, { previousCode: before, code: res.code });
    const now = await this.prisma.esfInboundQuarantine.findUniqueOrThrow({ where: { id } });
    return { outcome: 'STILL_QUARANTINED', code: res.code, title: INBOUND_ERRORS[res.code].title, detail: now.errorDetail };
  }

  /** Решение человека по записи: принять новую версию (конфликт хэша), оставить прежнюю, закрыть без импорта. */
  async resolve(ctx: OrgContext, id: string, action: QuarantineAction, reason: string) {
    const why = String(reason ?? '').trim();
    if (why.length < REASON_MIN) throw new AccError('REASON_REQUIRED', `Укажите причину решения — не короче ${REASON_MIN} символов`);
    if (!['ACCEPT_NEW', 'KEEP_EXISTING', 'DISMISS'].includes(action)) throw new AccError('BAD_ACTION', 'Действие: ACCEPT_NEW, KEEP_EXISTING или DISMISS');
    const q = await this.prisma.esfInboundQuarantine.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!q) throw new AccError('NOT_FOUND', 'Запись карантина не найдена', { status: 404 });
    if (q.status !== 'OPEN') throw new AccError('ESF_QUARANTINE_RESOLVED', 'Запись уже разобрана', { status: 409 });
    const conflict = q.errorCode === 'ESF_IN_HASH_CONFLICT' || q.errorCode === 'ESF_IN_KEY_CONFLICT';
    if (action === 'KEEP_EXISTING' && !conflict) throw new AccError('BAD_ACTION', '«Оставить прежнюю» — только для конфликта с документом реестра; иначе «Закрыть без импорта»');
    if (action === 'ACCEPT_NEW' && q.errorCode !== 'ESF_IN_HASH_CONFLICT') throw new AccError('BAD_ACTION', '«Принять новую версию» — только для конфликта содержимого того же ЭСФ');

    if (action !== 'ACCEPT_NEW') {
      const resolution = action === 'KEEP_EXISTING' ? 'KEPT_EXISTING' : 'DISMISSED';
      const done = await this.prisma.esfInboundQuarantine.updateMany({ where: { id, status: 'OPEN' }, data: { status: 'RESOLVED', resolution, resolutionReason: why, resolvedBy: ctx.userId, resolvedAt: new Date() } });
      if (done.count !== 1) throw new AccError('ESF_QUARANTINE_RESOLVED', 'Запись уже разобрана', { status: 409 });
      await this.audit(ctx, id, 'ESF_QUARANTINE_RESOLVED', why, { resolution, code: q.errorCode, bodySha256: q.bodyHash, existingInvoiceId: q.existingInvoiceId });
      return { resolution };
    }

    // Принять новую версию того же ЭСФ: только проверенное тело, только пока по документу нет решений и зачёта НДС,
    // и только если запись реестра не менялась с момента обнаружения конфликта. Прежнее тело сохраняется в карантине.
    if (sha256(q.body) !== q.bodyHash) throw new AccError('ESF_QUARANTINE_BODY_INCOMPLETE', 'Сохранённое тело не совпадает с хэшем — принять нельзя');
    const check = checkInbound(q.body, (q.envelope as any)?.version);
    if (!check.ok) throw new AccError('ESF_QUARANTINE_NEW_INVALID', `Новая версия не проходит проверку: ${INBOUND_ERRORS[check.code].title}`, { details: { code: check.code, detail: check.detail } });
    const inv = await this.prisma.esfInvoice.findFirst({ where: { id: q.existingInvoiceId ?? '', organizationId: ctx.organizationId } });
    if (!inv) throw new AccError('NOT_FOUND', 'Документ реестра для конфликта не найден', { status: 404 });
    if (inv.bodyHash !== q.existingHash) throw new AccError('ESF_QUARANTINE_STALE', 'Документ реестра изменился после обнаружения конфликта — откройте запись заново', { status: 409 });
    const blockers: string[] = [];
    if (inv.businessDecision) blockers.push(`исполнено решение ${inv.businessDecision}`);
    if (inv.sourceDocId) blockers.push('привязано поступление-основание');
    if (await this.prisma.vatCreditAllocation.count({ where: { organizationId: ctx.organizationId, esfInvoiceId: inv.id } })) blockers.push('есть строки регистра НДС к зачёту');
    if (await this.prisma.esfDecision.count({ where: { organizationId: ctx.organizationId, invoiceIds: { has: inv.id }, status: { in: ['PROPOSED', 'APPROVED'] } } })) blockers.push('есть незавершённое решение');
    if (blockers.length) {
      throw new AccError('ESF_QUARANTINE_HAS_EFFECTS', `По документу уже есть учётные действия: ${blockers.join('; ')}. Новую версию нельзя подставить молча`, { fix: 'Сначала отмените решения/зачёт НДС с причиной, затем примите новую версию' });
    }
    const info = { ...((q.envelope ?? {}) as any), invoiceId: q.esfId.toString(), registrationNumber: q.registrationNumber ?? inv.registrationNumber ?? undefined, invoiceStatus: q.invoiceStatus ?? inv.esfStatus ?? undefined };
    const data = await this.fields(ctx.organizationId, q.environment, info, q.body, q.bodyHash, check);
    await this.prisma.$transaction(async (tx) => {
      const upd = await tx.esfInvoice.updateMany({ where: { id: inv.id, bodyHash: q.existingHash! }, data: { ...data, suggestedSourceDocId: null } });
      if (upd.count !== 1) throw new AccError('ESF_QUARANTINE_STALE', 'Документ реестра изменился — откройте запись заново', { status: 409 });
      const done = await tx.esfInboundQuarantine.updateMany({ where: { id, status: 'OPEN' }, data: { status: 'RESOLVED', resolution: 'ACCEPTED_NEW', resolutionReason: why, resolvedBy: ctx.userId, resolvedAt: new Date(), resultInvoiceId: inv.id, replacedBody: inv.body } });
      if (done.count !== 1) throw new AccError('ESF_QUARANTINE_RESOLVED', 'Запись уже разобрана', { status: 409 });
      await tx.auditLog.create({ data: { userId: ctx.userId, organizationId: ctx.organizationId, action: 'ESF_QUARANTINE_ACCEPTED_NEW', entity: 'esf_inbound_quarantine', entityId: id, reason: why,
        before: { invoiceId: inv.id, bodySha256: inv.bodyHash, num: inv.num, totalWithTax: inv.totalWithTax.toFixed(2) } as any,
        after: { invoiceId: inv.id, bodySha256: q.bodyHash, num: data.num, totalWithTax: data.totalWithTax.toFixed(2) } as any } });
    });
    return { resolution: 'ACCEPTED_NEW', invoiceId: inv.id };
  }

  private audit(ctx: OrgContext, id: string, action: string, reason: string, after: Record<string, unknown>) {
    return this.prisma.auditLog.create({ data: { userId: ctx.userId, organizationId: ctx.organizationId, action, entity: 'esf_inbound_quarantine', entityId: id, reason, after: after as any } });
  }
}

/** Конверт invoiceInfo без подписи и сертификата (их место — не карантин; проверка подписи ИС ЭСФ — её флаг). */
function redactEnvelope(e: Record<string, any>) {
  const { signature: _s, certificate: _c, ...rest } = e;
  return rest;
}
