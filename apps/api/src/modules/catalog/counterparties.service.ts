import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { Scope, scopeError, tenantCatalog, writable } from '../../common/scope';
import { RequisiteError, day, effectiveOn, validateBik, validateBin, validateIban, validateKbe } from './requisites';

/** Поля контрагента, которые задаёт пользователь (FP-026). Идентификаторы обмена, статус обмена, архив — нет. */
const EDITABLE = ['type', 'kind', 'name', 'fullName', 'inn', 'kpp', 'phone', 'email', 'groupId', 'countryCode', 'kbe', 'attributes'] as const;
const KINDS = ['LEGAL', 'ENTREPRENEUR', 'INDIVIDUAL', 'NONRESIDENT'];
const TYPES = ['CUSTOMER', 'SUPPLIER', 'BOTH'];
const ADDRESS_KINDS = ['LEGAL', 'ACTUAL', 'DELIVERY'];
const CONTRACT_TYPES = ['SALE', 'PURCHASE', 'COMMISSION', 'OTHER'];

const bad = (code: string, message: string, extra: Record<string, unknown> = {}) => new BadRequestException({ code, message, ...extra });
function req<T>(fn: () => T): T {
  try { return fn(); } catch (e) {
    if (e instanceof RequisiteError) throw bad(e.code, e.message);
    throw e;
  }
}
const dayBefore = (d: Date) => new Date(d.getTime() - 86400000);
const ru = (d: Date) => d.toISOString().slice(0, 10).split('-').reverse().join('.');

/** Контрагенты: справочник клиента — общий для его организаций или личный для одной (FP-007); реквизиты и договоры — FP-026. */
@Injectable()
export class CounterpartiesService {
  constructor(private prisma: PrismaService) {}

  async findAll(s: Scope, query: { search?: string; type?: string; page?: number; limit?: number }) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 50;
    const skip = (page - 1) * limit;

    const where: any = { ...tenantCatalog(s), deleted: false };
    if (query.search) {
      where.AND = [{ OR: [
        { name: { contains: query.search, mode: 'insensitive' } },
        { fullName: { contains: query.search, mode: 'insensitive' } },
        { inn: { contains: query.search.replace(/[\s-]/g, '') } },
        { phone: { contains: query.search } },
      ] }];
    }
    if (query.type) where.type = query.type;

    const [counterparties, total] = await Promise.all([
      this.prisma.counterparty.findMany({
        where,
        skip,
        take: limit,
        include: { group: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.counterparty.count({ where }),
    ]);

    return { counterparties, total, page, limit, pages: Math.ceil(total / limit) };
  }

  /** Карточка: реквизиты с историей и договоры только своей организации (договоры других организаций клиента не видны). */
  async findOne(s: Scope, id: string) {
    const cp = await this.prisma.counterparty.findFirst({
      where: { id, ...tenantCatalog(s) },
      include: {
        group: true,
        contracts: { where: { organizationId: s.organizationId }, orderBy: [{ isActive: 'desc' }, { date: 'desc' }, { number: 'asc' }] },
        addresses: { orderBy: [{ kind: 'asc' }, { validFrom: 'desc' }] },
        bankAccounts: { orderBy: [{ isDefault: 'desc' }, { validFrom: 'desc' }] },
      },
    });
    if (!cp) throw new NotFoundException('Контрагент не найден');
    return cp;
  }

  private async visible(s: Scope, id: string) {
    const cp = await this.prisma.counterparty.findFirst({ where: { id, ...tenantCatalog(s) }, select: { id: true, name: true, deleted: true, organizationId: true } });
    if (!cp) throw new NotFoundException('Контрагент не найден');
    return cp;
  }

  /** Только разрешённые поля; ИИН/БИН резидента — с контрольным разрядом; вид, тип, страна, КБе — из справочников. */
  private clean(s: Scope, body: any, current?: { kind: string; countryCode: string }) {
    const { data } = writable(body, s);
    const out: Record<string, any> = {};
    for (const k of EDITABLE) if (k in (data as any)) out[k] = (data as any)[k];
    for (const k of ['fullName', 'inn', 'kpp', 'phone', 'email', 'groupId', 'kbe'] as const) if (k in out && (out[k] === '' || out[k] === undefined)) out[k] = null;
    if ('name' in out && !String(out.name ?? '').trim()) throw bad('NAME_REQUIRED', 'Укажите наименование');
    if ('kind' in out && !KINDS.includes(out.kind)) throw bad('KIND', `Вид: ${KINDS.join(', ')}`);
    if ('type' in out && !TYPES.includes(out.type)) throw bad('TYPE', `Роль: ${TYPES.join(', ')}`);
    if ('countryCode' in out) {
      out.countryCode = String(out.countryCode ?? '').trim().toUpperCase();
      if (!/^[A-Z]{2}$/.test(out.countryCode)) throw bad('COUNTRY', 'Страна — двухбуквенный код (KZ, RU, CN…)');
    }
    const kind = out.kind ?? current?.kind ?? 'LEGAL';
    const country = out.countryCode ?? current?.countryCode ?? 'KZ';
    if (kind === 'NONRESIDENT' && country === 'KZ') throw bad('COUNTRY', 'Нерезидент — укажите страну регистрации (не KZ)');
    if (kind !== 'NONRESIDENT' && 'countryCode' in out && country !== 'KZ') throw bad('COUNTRY', 'Для иностранного контрагента выберите вид «Нерезидент»');
    // Резидент РК: ИИН/БИН проверяется по контрольному разряду; у нерезидента — свой налоговый номер, формат не проверяем.
    if (out.inn && kind !== 'NONRESIDENT') out.inn = req(() => validateBin(out.inn));
    else if (out.inn) out.inn = String(out.inn).trim();
    if (out.kbe) out.kbe = req(() => validateKbe(out.kbe));
    out.updatedBy = s.userId;
    return out;
  }

  /** Тот же ИИН/БИН у другого видимого контрагента — дубль; у личного контрагента другой организации — без имени. */
  private async assertNoDuplicateBin(s: Scope, inn: string | null | undefined, exceptId?: string) {
    if (!inn) return;
    const other = await this.prisma.counterparty.findFirst({ where: { tenantId: s.tenantId, inn, deleted: false, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { id: true, name: true, organizationId: true } });
    if (!other) return;
    const mine = other.organizationId === null || other.organizationId === s.organizationId;
    throw new ConflictException({
      code: 'COUNTERPARTY_DUPLICATE_BIN',
      message: mine ? `Контрагент с ИИН/БИН ${inn} уже есть: «${other.name}»` : `Контрагент с ИИН/БИН ${inn} уже заведён другой организацией клиента — попросите перенести его в общий справочник`,
      details: mine ? { counterpartyId: other.id } : undefined,
    });
  }

  async create(s: Scope, body: any) {
    const { private: own } = writable(body, s, { privateAllowed: true });
    const data = this.clean(s, body);
    if (!data.name) throw bad('NAME_REQUIRED', 'Укажите наименование');
    await this.assertNoDuplicateBin(s, data.inn);
    return this.prisma.counterparty.create({
      data: { ...(data as any), tenantId: s.tenantId, organizationId: own ? s.organizationId : null },
    }).catch(scopeError);
  }

  async update(s: Scope, id: string, body: any) {
    const cur = await this.findOne(s, id);
    const data = this.clean(s, body, { kind: cur.kind, countryCode: cur.countryCode });
    if ('inn' in data && data.inn !== cur.inn) await this.assertNoDuplicateBin(s, data.inn, id);
    const updated = await this.prisma.counterparty.update({ where: { id }, data: data as any }).catch(scopeError);
    if ('inn' in data && data.inn !== cur.inn) await this.audit(s, id, 'COUNTERPARTY_BIN_CHANGED', { before: cur.inn, after: data.inn });
    return updated;
  }

  async archive(s: Scope, id: string) {
    await this.visible(s, id);
    return this.prisma.counterparty.update({ where: { id }, data: { deleted: true, updatedBy: s.userId } });
  }

  async findGroups(s: Scope) {
    return this.prisma.counterpartyGroup.findMany({ where: { tenantId: s.tenantId }, orderBy: { name: 'asc' } });
  }

  // ── Реквизиты с датами действия ──

  /**
   * Новый адрес. Адрес того же вида, действующий на дату начала, закрывается днём раньше — история остаётся
   * (документы прошлых дат видят прежний адрес). Начать раньше уже действующего адреса нельзя: прошлое не переписывается.
   */
  async addAddress(s: Scope, id: string, b: { kind?: string; line?: string; countryCode?: string; postalCode?: string; validFrom?: string }) {
    await this.visible(s, id);
    const kind = b.kind ?? 'LEGAL';
    if (!ADDRESS_KINDS.includes(kind)) throw bad('ADDRESS_KIND', `Вид адреса: ${ADDRESS_KINDS.join(', ')}`);
    const line = String(b.line ?? '').trim().replace(/\s+/g, ' ');
    if (line.length < 5) throw bad('ADDRESS_LINE', 'Укажите адрес (населённый пункт, улица, дом)');
    const countryCode = String(b.countryCode ?? 'KZ').trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(countryCode)) throw bad('COUNTRY', 'Страна — двухбуквенный код');
    const validFrom = req(() => day(b.validFrom ?? new Date()));
    const postalCode = b.postalCode ? String(b.postalCode).trim() : null;
    if (postalCode && !/^[A-Z0-9 -]{3,10}$/i.test(postalCode)) throw bad('POSTAL_CODE', 'Индекс — до 10 символов');
    return this.prisma.$transaction(async (tx) => {
      const later = await tx.counterpartyAddress.findFirst({ where: { counterpartyId: id, kind, validFrom: { gte: validFrom } } });
      if (later) throw bad('ADDRESS_BACKDATED', `Уже есть адрес этого вида с ${ru(later.validFrom)} — новый адрес должен начинаться позже`);
      await tx.counterpartyAddress.updateMany({ where: { counterpartyId: id, kind, validTo: null }, data: { validTo: dayBefore(validFrom) } });
      const a = await tx.counterpartyAddress.create({ data: { tenantId: s.tenantId, counterpartyId: id, kind, line, countryCode, postalCode, validFrom, createdBy: s.userId } });
      await this.audit(s, id, 'COUNTERPARTY_ADDRESS_ADDED', { kind, line, validFrom: b.validFrom ?? validFrom.toISOString().slice(0, 10) }, tx);
      return a;
    });
  }

  /** Новый банковский счёт (IBAN по модулю 97, БИК). Основной — один на валюту. */
  async addBankAccount(s: Scope, id: string, b: { iban?: string; bik?: string; bankName?: string; currency?: string; isDefault?: boolean; validFrom?: string }) {
    await this.visible(s, id);
    const iban = req(() => validateIban(b.iban));
    const bik = req(() => validateBik(b.bik));
    const bankName = String(b.bankName ?? '').trim();
    if (!bankName) throw bad('BANK_NAME', 'Укажите банк');
    const currency = String(b.currency ?? 'KZT').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw bad('CURRENCY', 'Валюта — трёхбуквенный код (KZT, USD…)');
    const validFrom = req(() => day(b.validFrom ?? new Date()));
    try {
      return await this.prisma.$transaction(async (tx) => {
        const hasDefault = await tx.counterpartyBankAccount.count({ where: { counterpartyId: id, currency, isDefault: true, validTo: null } });
        const isDefault = b.isDefault === true || !hasDefault;
        if (isDefault) await tx.counterpartyBankAccount.updateMany({ where: { counterpartyId: id, currency, isDefault: true }, data: { isDefault: false } });
        const a = await tx.counterpartyBankAccount.create({ data: { tenantId: s.tenantId, counterpartyId: id, iban, bik, bankName, currency, isDefault, validFrom, createdBy: s.userId } });
        await this.audit(s, id, 'COUNTERPARTY_BANK_ADDED', { iban, bik, currency, isDefault }, tx);
        return a;
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException({ code: 'IBAN_DUPLICATE', message: `Счёт ${iban} у контрагента уже есть` });
      throw e;
    }
  }

  /** Закрыть счёт (с даты) — история и документы прошлых дат сохраняются. */
  async closeBankAccount(s: Scope, id: string, accountId: string, b: { validTo?: string }) {
    await this.visible(s, id);
    const a = await this.prisma.counterpartyBankAccount.findFirst({ where: { id: accountId, counterpartyId: id } });
    if (!a) throw new NotFoundException('Счёт не найден');
    const validTo = req(() => day(b.validTo ?? new Date()));
    if (validTo < a.validFrom) throw bad('BANK_CLOSE_DATE', 'Дата закрытия раньше даты открытия');
    const r = await this.prisma.counterpartyBankAccount.update({ where: { id: accountId }, data: { validTo, isDefault: false } });
    await this.audit(s, id, 'COUNTERPARTY_BANK_CLOSED', { iban: a.iban, validTo: b.validTo });
    return r;
  }

  /** Реквизиты на дату: юридический адрес и основной счёт, действовавшие в этот день (для документов и ЭСФ). */
  async requisitesOn(s: Scope, id: string, on?: string) {
    const cp = await this.findOne(s, id);
    const at = req(() => day(on ?? new Date()));
    return {
      id: cp.id, name: cp.name, fullName: cp.fullName, inn: cp.inn, kind: cp.kind, countryCode: cp.countryCode, kbe: cp.kbe, on: at.toISOString().slice(0, 10),
      legalAddress: effectiveOn(cp.addresses.filter((a) => a.kind === 'LEGAL'), at)[0] ?? null,
      bankAccount: effectiveOn(cp.bankAccounts, at).sort((x, y) => Number(y.isDefault) - Number(x.isDefault))[0] ?? null,
    };
  }

  // ── Договоры своей организации ──

  private async contractOwn(s: Scope, id: string, contractId: string) {
    const c = await this.prisma.contract.findFirst({ where: { id: contractId, counterpartyId: id, organizationId: s.organizationId } });
    if (!c) throw new NotFoundException('Договор не найден');
    return c;
  }

  private contractData(b: any) {
    const out: Record<string, any> = {};
    if ('number' in b) {
      out.number = String(b.number ?? '').trim();
      if (!out.number) throw bad('CONTRACT_NUMBER', 'Укажите номер договора');
    }
    if ('date' in b) out.date = b.date ? req(() => day(b.date)) : null;
    if ('name' in b) out.name = b.name ? String(b.name).trim() : null;
    if ('type' in b) {
      if (b.type && !CONTRACT_TYPES.includes(b.type)) throw bad('CONTRACT_TYPE', `Вид договора: ${CONTRACT_TYPES.join(', ')}`);
      out.type = b.type || null;
    }
    if ('startDate' in b) out.startDate = b.startDate ? req(() => day(b.startDate)) : null;
    if ('endDate' in b) out.endDate = b.endDate ? req(() => day(b.endDate)) : null;
    if ('currency' in b) {
      out.currency = String(b.currency ?? 'KZT').trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(out.currency)) throw bad('CURRENCY', 'Валюта — трёхбуквенный код');
    }
    if ('isActive' in b) out.isActive = !!b.isActive;
    return out;
  }

  private checkPeriod(c: { date?: Date | null; startDate?: Date | null; endDate?: Date | null }) {
    if (c.startDate && c.endDate && c.endDate < c.startDate) throw bad('CONTRACT_PERIOD', 'Окончание действия договора раньше начала');
  }

  async contracts(s: Scope, id: string) {
    await this.visible(s, id);
    return this.prisma.contract.findMany({ where: { counterpartyId: id, organizationId: s.organizationId }, orderBy: [{ isActive: 'desc' }, { date: 'desc' }, { number: 'asc' }] });
  }

  /** Договор заключает текущая организация с видимым ей контрагентом. Номер и дата обязательны. */
  async createContract(s: Scope, id: string, b: any) {
    const cp = await this.visible(s, id);
    if (cp.deleted) throw bad('COUNTERPARTY_ARCHIVED', 'Контрагент в архиве');
    const data = this.contractData({ currency: 'KZT', ...b, number: b?.number ?? '' });
    if (!data.date) throw bad('CONTRACT_DATE', 'Укажите дату договора');
    if (!data.startDate) data.startDate = data.date;
    this.checkPeriod(data);
    try {
      const c = await this.prisma.contract.create({ data: { ...(data as any), tenantId: s.tenantId, organizationId: s.organizationId, counterpartyId: id, createdBy: s.userId } });
      await this.audit(s, id, 'CONTRACT_CREATED', { contractId: c.id, number: c.number, date: b.date });
      return c;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException({ code: 'CONTRACT_DUPLICATE', message: `Договор № ${data.number} с этим контрагентом уже есть` });
      throw e;
    }
  }

  /**
   * Изменение договора своей организации. Если по договору уже есть документы, нельзя сдвинуть его период так, чтобы
   * документы оказались вне срока действия, и сменить валюту — иначе документы молча станут «чужими» договору.
   */
  async updateContract(s: Scope, id: string, contractId: string, b: any) {
    const cur = await this.contractOwn(s, id, contractId);
    const data = this.contractData(b ?? {});
    const next = { ...cur, ...data };
    this.checkPeriod(next);
    const docs = await this.prisma.document.aggregate({ where: { contractId, deleted: false }, _min: { date: true }, _max: { date: true }, _count: true });
    if (docs._count) {
      if ('currency' in data && data.currency !== cur.currency) throw bad('CONTRACT_IN_USE', `По договору ${docs._count} документ(ов) — валюту менять нельзя`);
      const from = next.startDate ?? next.date;
      if ((from && docs._min.date! < from) || (next.endDate && docs._max.date! > new Date(next.endDate.getTime() + 86400000 - 1))) {
        throw bad('CONTRACT_IN_USE', `По договору есть документы с ${ru(docs._min.date!)} по ${ru(docs._max.date!)} — срок действия должен их покрывать`);
      }
    }
    try {
      const c = await this.prisma.contract.update({ where: { id: contractId }, data });
      await this.audit(s, id, 'CONTRACT_UPDATED', { contractId, changes: Object.keys(data) });
      return c;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException({ code: 'CONTRACT_DUPLICATE', message: `Договор № ${data.number} с этим контрагентом уже есть` });
      throw e;
    }
  }

  private audit(s: Scope, counterpartyId: string, action: string, after: Record<string, unknown>, db: Prisma.TransactionClient | PrismaService = this.prisma) {
    return db.auditLog.create({ data: { userId: s.userId, organizationId: s.organizationId, action, entity: 'counterparty', entityId: counterpartyId, after: after as any } });
  }
}

