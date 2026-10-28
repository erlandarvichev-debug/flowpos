import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { AccError } from '../common/acc-error';
import { D, money } from '../common/money';
import { OrgContext } from '../access/org-context';
import { DocumentsService } from '../documents/documents.service';

export interface StatementMapping {
  date: string;            // колонка даты (ДД.ММ.ГГГГ или ГГГГ-ММ-ДД)
  amount?: string;         // одна колонка суммы со знаком
  debit?: string;          // списание
  credit?: string;         // поступление
  docNumber?: string;
  counterpartyName?: string;
  counterpartyBin?: string;
  purpose?: string;
  knp?: string;
}

const DEFAULT_MAPPING: StatementMapping = {
  date: 'Дата', debit: 'Дебет', credit: 'Кредит', docNumber: 'Номер документа',
  counterpartyName: 'Контрагент', counterpartyBin: 'БИН/ИИН', purpose: 'Назначение платежа', knp: 'КНП',
};

function parseCsv(text: string): string[][] {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const sep = (firstLine.match(/;/g)?.length ?? 0) >= (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) { row.push(cell.trim()); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell.trim()); cell = '';
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell.trim());
  if (row.some((c) => c !== '')) rows.push(row);
  return rows;
}

function parseDate(v: string): Date | null {
  const m1 = v.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
  if (m1) return new Date(`${m1[3]}-${m1[2]}-${m1[1]}T00:00:00.000Z`);
  const m2 = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m2) return new Date(`${m2[1]}-${m2[2]}-${m2[3]}T00:00:00.000Z`);
  return null;
}

function parseAmount(v: string | undefined): string | null {
  if (!v) return null;
  const s = v.replace(/\s| /g, '').replace(',', '.');
  if (!s || !/^-?\d+(\.\d+)?$/.test(s)) return null;
  return new D(s).toDecimalPlaces(2).toFixed(2);
}

/**
 * Импорт выписки CSV/XLSX-как-CSV: предпросмотр → подтверждение. Повторная загрузка тех же строк
 * не создаёт дублей (уникальный хэш строки на счёт). Прямой обмен с банком — только при наличии
 * подтверждённого API (не реализовано).
 */
@Injectable()
export class BankImportService {
  constructor(private prisma: PrismaService, private docs: DocumentsService) {}

  async preview(ctx: OrgContext, input: { bankAccountId: string; csv: string; mapping?: Partial<StatementMapping> }) {
    const bank = await this.prisma.orgBankAccount.findFirst({ where: { id: input.bankAccountId, organizationId: ctx.organizationId } });
    if (!bank) throw new AccError('REF_FOREIGN', 'Банковский счёт не найден в этой организации');
    const map = { ...DEFAULT_MAPPING, ...(input.mapping || {}) };
    const rows = parseCsv(input.csv || '');
    if (rows.length < 2) throw new AccError('EMPTY_STATEMENT', 'В файле нет строк выписки', { fix: 'Первая строка — заголовки колонок, далее операции.' });
    const header = rows[0].map((h) => h.toLowerCase());
    const col = (name?: string) => (name ? header.indexOf(name.toLowerCase()) : -1);
    const ci = { date: col(map.date), amount: col(map.amount), debit: col(map.debit), credit: col(map.credit), num: col(map.docNumber), name: col(map.counterpartyName), bin: col(map.counterpartyBin), purpose: col(map.purpose), knp: col(map.knp) };
    if (ci.date < 0 || (ci.amount < 0 && ci.debit < 0 && ci.credit < 0)) {
      throw new AccError('MAPPING_REQUIRED', `Не найдены колонки даты и суммы. В файле: ${rows[0].join(' | ')}`, { fix: 'Укажите соответствие колонок (mapping).' });
    }
    const counterparties = await this.prisma.counterparty.findMany({ where: { inn: { not: null }, OR: [{ organizationId: null }, { organizationId: ctx.organizationId }] }, select: { id: true, name: true, inn: true } });
    const out: any[] = [];
    rows.slice(1).forEach((r, i) => {
      const get = (k: number) => (k >= 0 ? r[k] ?? '' : '');
      const date = parseDate(get(ci.date));
      let direction: 'IN' | 'OUT' | null = null;
      let amount: string | null = null;
      if (ci.amount >= 0) {
        amount = parseAmount(get(ci.amount));
        if (amount) { direction = amount.startsWith('-') ? 'OUT' : 'IN'; amount = amount.replace('-', ''); }
      } else {
        const cr = parseAmount(get(ci.credit)), db = parseAmount(get(ci.debit));
        if (cr && Number(cr) !== 0) { direction = 'IN'; amount = cr; } else if (db && Number(db) !== 0) { direction = 'OUT'; amount = db; }
      }
      const errors: string[] = [];
      if (!date) errors.push('дата не распознана');
      if (!amount || !direction) errors.push('сумма не распознана');
      const bin = get(ci.bin).replace(/\D/g, '') || null;
      const cp = bin ? counterparties.find((c) => c.inn === bin) : undefined;
      const fields = { date: date?.toISOString().slice(0, 10), direction, amount, docNumber: get(ci.num) || null, counterpartyName: get(ci.name) || null, counterpartyBin: bin, purpose: get(ci.purpose) || null, knp: get(ci.knp) || null };
      const hash = createHash('sha256').update(JSON.stringify([fields.date, fields.direction, fields.amount, fields.docNumber, fields.counterpartyBin, fields.purpose])).digest('hex');
      out.push({ row: i + 2, ...fields, hash, counterpartyId: cp?.id ?? null, counterpartyMatched: cp?.name ?? null, errors });
    });
    const existing = await this.prisma.accBankStatementLine.findMany({ where: { organizationId: ctx.organizationId, bankAccountId: bank.id, hash: { in: out.map((o) => o.hash) } }, select: { hash: true } });
    const dup = new Set(existing.map((e) => e.hash));
    const seen = new Set<string>();
    for (const o of out) {
      o.duplicate = dup.has(o.hash) || seen.has(o.hash);
      seen.add(o.hash);
      o.action = o.errors.length ? 'ERROR' : o.duplicate ? 'SKIP_DUPLICATE' : o.counterpartyId ? (o.direction === 'IN' ? 'CUSTOMER_PAYMENT' : 'SUPPLIER_PAYMENT') : 'DRAFT_OTHER';
    }
    return {
      bankAccount: { id: bank.id, name: bank.name, iban: bank.iban },
      rows: out,
      summary: {
        total: out.length, new: out.filter((o) => o.action !== 'SKIP_DUPLICATE' && o.action !== 'ERROR').length,
        duplicates: out.filter((o) => o.duplicate).length, errors: out.filter((o) => o.errors.length).length,
        in: out.filter((o) => o.direction === 'IN' && !o.duplicate && !o.errors.length).reduce((a, o) => a.plus(o.amount), new D(0)).toFixed(2),
        out: out.filter((o) => o.direction === 'OUT' && !o.duplicate && !o.errors.length).reduce((a, o) => a.plus(o.amount), new D(0)).toFixed(2),
      },
    };
  }

  /** Подтверждение: создаёт документы банка; с найденным контрагентом — сразу проводит (разнесение долг/аванс). */
  async commit(ctx: OrgContext, input: { bankAccountId: string; csv: string; mapping?: Partial<StatementMapping>; autoPost?: boolean }) {
    const pv = await this.preview(ctx, input);
    const batchId = randomUUID();
    const result = { batchId, created: 0, posted: 0, drafts: 0, skipped: 0, errors: [] as { row: number; message: string }[] };
    for (const r of pv.rows) {
      if (r.action === 'ERROR' || r.action === 'SKIP_DUPLICATE') { result.skipped++; continue; }
      // Защита от дублей на уровне БД: уникальный хэш; гонка двух загрузок — вторая пропустит строку
      const line = await this.prisma.accBankStatementLine.create({
        data: {
          organizationId: ctx.organizationId, bankAccountId: input.bankAccountId, batchId, hash: r.hash, date: new Date(r.date), direction: r.direction,
          amount: money(r.amount), docNumber: r.docNumber, counterpartyName: r.counterpartyName, counterpartyBin: r.counterpartyBin,
          counterpartyId: r.counterpartyId, purpose: r.purpose, knp: r.knp, raw: r,
        },
      }).catch((e: any) => (e?.code === 'P2002' ? null : Promise.reject(e)));
      if (!line) { result.skipped++; continue; }
      const docType = r.direction === 'IN' ? 'BANK_IN' : 'BANK_OUT';
      const operation = r.counterpartyId ? (r.direction === 'IN' ? 'CUSTOMER' : 'SUPPLIER') : 'OTHER';
      const doc = await this.docs.create(ctx, {
        docType, date: r.date, comment: `Выписка: ${r.counterpartyName ?? ''} ${r.purpose ?? ''}`.trim(),
        body: { bankAccountId: input.bankAccountId, operation, counterpartyId: r.counterpartyId ?? undefined, amount: r.amount, purpose: r.purpose, knp: r.knp, statementLineId: line.id },
        externalSource: 'BANK_STATEMENT', externalId: `${input.bankAccountId}:${r.hash}`,
      });
      result.created++;
      await this.prisma.accBankStatementLine.update({ where: { id: line.id }, data: { status: 'DOCUMENT_CREATED', documentId: doc.id } });
      if (operation !== 'OTHER' && input.autoPost !== false) {
        try { await this.docs.post(ctx, doc.id); result.posted++; } catch (e: any) { result.drafts++; result.errors.push({ row: r.row, message: e?.getResponse?.()?.message ?? e.message }); }
      } else result.drafts++;
    }
    await this.prisma.auditLog.create({ data: { userId: ctx.userId, organizationId: ctx.organizationId, action: 'BANK_STATEMENT_IMPORT', entity: 'AccBankStatementLine', entityId: batchId, after: result as any } });
    return result;
  }
}
