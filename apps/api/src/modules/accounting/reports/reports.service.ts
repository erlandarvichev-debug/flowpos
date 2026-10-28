import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AccError } from '../common/acc-error';
import { D } from '../common/money';
import { OrgContext } from '../access/org-context';
import { PostingService } from '../core/posting.service';
import { DIM_COLUMNS, Dim } from '../chart/kz-chart.data';

interface Period { from: string; toNext: string; fromStr: string; toStr: string }

// Колонки — timestamp without time zone (UTC). Параметры передаём строкой и явно ::timestamp,
// иначе Date уходит как timestamptz и сдвигается на часовой пояс сессии БД.
const ts = (d: Date) => d.toISOString().slice(0, 23).replace('T', ' ');

function period(from?: string, to?: string): Period {
  if (!from || !to) throw new AccError('PERIOD_REQUIRED', 'Укажите период: from и to (ГГГГ-ММ-ДД)');
  const f = new Date(from + 'T00:00:00.000Z');
  const t = new Date(to + 'T00:00:00.000Z');
  if (isNaN(f.getTime()) || isNaN(t.getTime()) || f > t) throw new AccError('BAD_PERIOD', 'Некорректный период');
  return { from: ts(f), toNext: ts(new Date(t.getTime() + 86400000)), fromStr: from, toStr: to };
}

const dimSql: Record<Dim, string> = Object.fromEntries(
  Object.entries(DIM_COLUMNS).map(([k, v]) => [k, v.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase())]),
) as any;

function splitBalance(v: Prisma.Decimal) {
  return v.isNegative() ? { debit: '0.00', credit: v.neg().toFixed(2) } : { debit: v.toFixed(2), credit: '0.00' };
}

/**
 * Отчёты строятся только из активных проводок. Каждый показатель расшифровывается:
 * ОСВ → карточка счёта → проводка → документ (sourceType/sourceId + номер).
 */
@Injectable()
export class ReportsService {
  constructor(private prisma: PrismaService, private posting: PostingService) {}

  async trialBalance(ctx: OrgContext, q: { from?: string; to?: string; ledger?: string; withSections?: string }) {
    const p = period(q.from, q.to);
    const ledger = q.ledger === 'NU' ? 'NU' : 'BU';
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT a.id, a.code, a.name, a.name_kk, a.parent_id, a.kind,
        COALESCE(SUM(CASE WHEN p.date < ${p.from}::timestamp THEN CASE WHEN p.side='D' THEN p.amount ELSE -p.amount END END),0) AS opening,
        COALESCE(SUM(CASE WHEN p.date >= ${p.from}::timestamp AND p.side='D' THEN p.amount END),0) AS turn_d,
        COALESCE(SUM(CASE WHEN p.date >= ${p.from}::timestamp AND p.side='C' THEN p.amount END),0) AS turn_c
      FROM acc_postings p JOIN acc_accounts a ON a.id = p.account_id
      WHERE p.organization_id = ${ctx.organizationId} AND p.is_active AND p.ledger = ${ledger} AND p.date < ${p.toNext}::timestamp
      GROUP BY a.id ORDER BY a.code`;
    const accounts = await this.prisma.accAccount.findMany({ where: { id: { in: rows.map((r) => r.parent_id).filter(Boolean) } } });
    const parents = new Map(accounts.map((a) => [a.id, a]));
    // Подтягиваем всю цепочку родителей
    let pending = accounts.filter((a) => a.parentId && !parents.has(a.parentId)).map((a) => a.parentId!);
    while (pending.length) {
      const more = await this.prisma.accAccount.findMany({ where: { id: { in: pending } } });
      more.forEach((a) => parents.set(a.id, a));
      pending = more.filter((a) => a.parentId && !parents.has(a.parentId)).map((a) => a.parentId!);
    }
    type Row = { id: string; code: string; name: string; nameKk: string | null; parentId: string | null; isGroup: boolean; opening: Prisma.Decimal; turnD: Prisma.Decimal; turnC: Prisma.Decimal };
    const out = new Map<string, Row>();
    const add = (id: string, base: Omit<Row, 'opening' | 'turnD' | 'turnC'>, o: Prisma.Decimal, d: Prisma.Decimal, c: Prisma.Decimal) => {
      const r = out.get(id) || { ...base, opening: new D(0), turnD: new D(0), turnC: new D(0) };
      r.opening = r.opening.plus(o); r.turnD = r.turnD.plus(d); r.turnC = r.turnC.plus(c);
      out.set(id, r);
    };
    const totals = { opening: new D(0), turnD: new D(0), turnC: new D(0), openD: new D(0), openC: new D(0), closeD: new D(0), closeC: new D(0) };
    for (const r of rows) {
      const o = new D(r.opening), d = new D(r.turn_d), c = new D(r.turn_c);
      add(r.id, { id: r.id, code: r.code, name: r.name, nameKk: r.name_kk, parentId: r.parent_id, isGroup: false }, o, d, c);
      totals.turnD = totals.turnD.plus(d); totals.turnC = totals.turnC.plus(c);
      const ob = splitBalance(o), cb = splitBalance(o.plus(d).minus(c));
      totals.openD = totals.openD.plus(ob.debit); totals.openC = totals.openC.plus(ob.credit);
      totals.closeD = totals.closeD.plus(cb.debit); totals.closeC = totals.closeC.plus(cb.credit);
      if (q.withSections !== 'false') {
        let pid = r.parent_id;
        while (pid) {
          const pa = parents.get(pid);
          if (!pa) break;
          add(pa.id, { id: pa.id, code: pa.code, name: pa.name, nameKk: pa.nameKk, parentId: pa.parentId, isGroup: true }, o, d, c);
          pid = pa.parentId;
        }
      }
    }
    const lines = [...out.values()].sort((a, b) => a.code.localeCompare(b.code)).map((r) => {
      const closing = r.opening.plus(r.turnD).minus(r.turnC);
      return {
        accountId: r.id, code: r.code, name: r.name, nameKk: r.nameKk, isGroup: r.isGroup, parentId: r.parentId,
        opening: splitBalance(r.opening), turnover: { debit: r.turnD.toFixed(2), credit: r.turnC.toFixed(2) }, closing: splitBalance(closing),
        drill: r.isGroup ? null : `/accounting/reports/account-card?account=${r.code}&from=${p.fromStr}&to=${p.toStr}&ledger=${ledger}`,
      };
    });
    const warnings: string[] = [];
    if (!totals.turnD.equals(totals.turnC)) warnings.push(`Обороты Дт (${totals.turnD.toFixed(2)}) ≠ Кт (${totals.turnC.toFixed(2)}) — нарушен баланс!`);
    const aux = rows.find((r) => r.code === '0000');
    if (aux) {
      const bal = new D(aux.opening).plus(aux.turn_d).minus(aux.turn_c);
      if (!bal.isZero()) warnings.push(`Вспомогательный счёт 0000 имеет сальдо ${bal.toFixed(2)} ₸ — ввод остатков не сбалансирован`);
    }
    return {
      from: p.fromStr, to: p.toStr, ledger, lines,
      totals: {
        opening: { debit: totals.openD.toFixed(2), credit: totals.openC.toFixed(2) },
        turnover: { debit: totals.turnD.toFixed(2), credit: totals.turnC.toFixed(2) },
        closing: { debit: totals.closeD.toFixed(2), credit: totals.closeC.toFixed(2) },
      },
      balanced: totals.turnD.equals(totals.turnC) && totals.openD.equals(totals.openC) && totals.closeD.equals(totals.closeC),
      warnings,
    };
  }

  private dimFilter(q: Record<string, any>) {
    const parts: Prisma.Sql[] = [];
    for (const dim of Object.keys(DIM_COLUMNS) as Dim[]) {
      const v = q[dim] || q[dim.toLowerCase()];
      if (v) parts.push(Prisma.sql`AND p.${Prisma.raw(dimSql[dim])} = ${String(v)}`);
    }
    return parts.length ? Prisma.join(parts, ' ') : Prisma.empty;
  }

  async accountCard(ctx: OrgContext, q: Record<string, any>) {
    const p = period(q.from, q.to);
    const ledger = q.ledger === 'NU' ? 'NU' : 'BU';
    if (!q.account) throw new AccError('ACCOUNT_REQUIRED', 'Укажите счёт');
    const chartId = await this.posting.chartIdFor(this.prisma, ctx.organizationId, new Date(p.fromStr));
    const acc = await this.prisma.accAccount.findFirst({ where: { chartId, code: String(q.account), OR: [{ organizationId: null }, { organizationId: ctx.organizationId }] } });
    if (!acc) throw new AccError('ACCOUNT_NOT_FOUND', `Счёт ${q.account} не найден`, { status: 404 });
    // Счёт + все его субсчета
    const ids = [acc.id];
    let frontier = [acc.id];
    while (frontier.length) {
      const kids = await this.prisma.accAccount.findMany({ where: { parentId: { in: frontier } }, select: { id: true } });
      frontier = kids.map((k) => k.id);
      ids.push(...frontier);
    }
    const df = this.dimFilter(q);
    const [open] = await this.prisma.$queryRaw<any[]>`
      SELECT COALESCE(SUM(CASE WHEN p.side='D' THEN p.amount ELSE -p.amount END),0) AS bal,
             COALESCE(SUM(CASE WHEN p.side='D' THEN COALESCE(p.quantity,0) ELSE -COALESCE(p.quantity,0) END),0) AS qty
      FROM acc_postings p WHERE p.organization_id=${ctx.organizationId} AND p.is_active AND p.ledger=${ledger}
        AND p.account_id IN (${Prisma.join(ids)}) AND p.date < ${p.from}::timestamp ${df}`;
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT p.id, p.date, p.side, p.amount, p.quantity, p.currency, p.currency_amount, p.memo, p.entry_id,
             a.code AS account_code, e.source_type, e.source_id, COALESCE(d.number, td.number) AS doc_number,
             COALESCE(d.doc_type, td.doc_type::text) AS doc_type, td.id AS trade_id,
             p.counterparty_id, p.contract_id, p.product_id, p.store_id, p.employee_id, p.department_id,
             p.bank_account_id, p.cashbox_id, p.project_id, p.item_id,
             (SELECT string_agg(DISTINCT a2.code, ', ') FROM acc_postings p2 JOIN acc_accounts a2 ON a2.id=p2.account_id
               WHERE p2.entry_id=p.entry_id AND p2.ledger=p.ledger AND p2.side<>p.side) AS corr
      FROM acc_postings p
      JOIN acc_accounts a ON a.id=p.account_id
      JOIN acc_entries e ON e.id=p.entry_id
      LEFT JOIN acc_documents d ON e.source_type='ACC_DOCUMENT' AND d.id=e.source_id
      LEFT JOIN documents td ON td.id = CASE WHEN e.source_type='TRADE_DOCUMENT' THEN e.source_id
                                            WHEN e.source_type='COST' THEN split_part(e.source_id, ':', 2) END
      WHERE p.organization_id=${ctx.organizationId} AND p.is_active AND p.ledger=${ledger}
        AND p.account_id IN (${Prisma.join(ids)}) AND p.date >= ${p.from}::timestamp AND p.date < ${p.toNext}::timestamp ${df}
      ORDER BY p.date, d.number, p.line_no`;
    let bal = new D(open.bal);
    let qty = new D(open.qty);
    let td = new D(0), tc = new D(0);
    const lines = rows.map((r) => {
      const amt = new D(r.amount);
      if (r.side === 'D') { bal = bal.plus(amt); td = td.plus(amt); if (r.quantity) qty = qty.plus(r.quantity); }
      else { bal = bal.minus(amt); tc = tc.plus(amt); if (r.quantity) qty = qty.minus(r.quantity); }
      return {
        postingId: r.id, date: r.date, account: r.account_code, corrAccounts: r.corr, side: r.side,
        debit: r.side === 'D' ? amt.toFixed(2) : null, credit: r.side === 'C' ? amt.toFixed(2) : null,
        quantity: r.quantity, currency: r.currency, currencyAmount: r.currency_amount, memo: r.memo,
        balance: splitBalance(bal), quantityBalance: acc.isQuantitative ? qty.toFixed(3) : null,
        source: { type: r.source_type, id: r.source_id, docType: r.doc_type, number: r.doc_number,
          link: r.source_type === 'ACC_DOCUMENT' ? `/accounting/documents/${r.source_id}` : r.trade_id ? `/accounting/trade/${r.trade_id}` : null },
        dims: {
          COUNTERPARTY: r.counterparty_id, CONTRACT: r.contract_id, PRODUCT: r.product_id, STORE: r.store_id,
          EMPLOYEE: r.employee_id, DEPARTMENT: r.department_id, BANK_ACCOUNT: r.bank_account_id, CASHBOX: r.cashbox_id,
          PROJECT: r.project_id, ITEM: r.item_id,
        },
      };
    });
    const names = await this.dimNames(ctx, lines.map((l) => l.dims));
    for (const l of lines) (l as any).dimNames = Object.fromEntries(Object.entries(l.dims).filter(([, v]) => v).map(([k, v]) => [k, names[k]?.[v as string] ?? v]));
    return {
      account: { id: acc.id, code: acc.code, name: acc.name, nameKk: acc.nameKk, isQuantitative: acc.isQuantitative },
      from: p.fromStr, to: p.toStr, ledger,
      opening: splitBalance(new D(open.bal)), turnover: { debit: td.toFixed(2), credit: tc.toFixed(2) }, closing: splitBalance(bal),
      lines,
    };
  }

  async journal(ctx: OrgContext, q: { from?: string; to?: string; ledger?: string; page?: number; limit?: number }) {
    const p = period(q.from, q.to);
    const ledger = q.ledger === 'NU' ? 'NU' : 'BU';
    const limit = Math.min(500, Number(q.limit) || 100);
    const offset = (Math.max(1, Number(q.page) || 1) - 1) * limit;
    const entries = await this.prisma.$queryRaw<any[]>`
      SELECT e.id, e.date, e.source_type, e.source_id, e.rule_code, e.rule_version, e.source_version,
             COALESCE(d.number, td.number) AS number, COALESCE(d.doc_type, td.doc_type::text) AS doc_type, td.id AS trade_id
      FROM acc_entries e LEFT JOIN acc_documents d ON e.source_type='ACC_DOCUMENT' AND d.id=e.source_id
      LEFT JOIN documents td ON td.id = CASE WHEN e.source_type='TRADE_DOCUMENT' THEN e.source_id
                                            WHEN e.source_type='COST' THEN split_part(e.source_id, ':', 2) END
      WHERE e.organization_id=${ctx.organizationId} AND e.status='ACTIVE' AND e.date >= ${p.from}::timestamp AND e.date < ${p.toNext}::timestamp
      ORDER BY e.date, number LIMIT ${limit} OFFSET ${offset}`;
    const postings = entries.length
      ? await this.prisma.accPosting.findMany({
          where: { entryId: { in: entries.map((e) => e.id) }, ledger },
          include: { account: { select: { code: true, name: true } } },
          orderBy: [{ lineNo: 'asc' }],
        })
      : [];
    return {
      from: p.fromStr, to: p.toStr, ledger,
      entries: entries.map((e) => ({
        entryId: e.id, date: e.date, rule: `${e.rule_code} v${e.rule_version}`, sourceVersion: e.source_version,
        source: { type: e.source_type, id: e.source_id, number: e.number, docType: e.doc_type,
          link: e.source_type === 'ACC_DOCUMENT' ? `/accounting/documents/${e.source_id}` : e.trade_id ? `/accounting/trade/${e.trade_id}` : null },
        postings: postings.filter((x) => x.entryId === e.id).map((x) => ({
          lineNo: x.lineNo, side: x.side, account: x.account.code, accountName: x.account.name, amount: x.amount.toFixed(2),
          quantity: x.quantity, currency: x.currency, currencyAmount: x.currencyAmount, memo: x.memo,
        })),
      })),
    };
  }

  /** Остатки запасов по данным учёта: количество и стоимость по товарам и складам на дату. */
  async stock(ctx: OrgContext, q: { date?: string; storeId?: string; account?: string }) {
    const date = q.date ?? new Date().toISOString().slice(0, 10);
    const toNext = ts(new Date(new Date(date + 'T00:00:00.000Z').getTime() + 86400000));
    const accounts = q.account ? [String(q.account)] : ['1310', '1320', '1330', '1350'];
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT p.product_id, p.store_id, a.code,
        SUM(CASE WHEN p.side='D' THEN COALESCE(p.quantity,0) ELSE -COALESCE(p.quantity,0) END) AS qty,
        SUM(CASE WHEN p.side='D' THEN p.amount ELSE -p.amount END) AS amount
      FROM acc_postings p JOIN acc_accounts a ON a.id = p.account_id
      WHERE p.organization_id=${ctx.organizationId} AND p.is_active AND p.ledger='BU' AND a.code IN (${Prisma.join(accounts)})
        AND p.date < ${toNext}::timestamp ${q.storeId ? Prisma.sql`AND p.store_id = ${q.storeId}` : Prisma.empty}
      GROUP BY p.product_id, p.store_id, a.code
      HAVING SUM(CASE WHEN p.side='D' THEN COALESCE(p.quantity,0) ELSE -COALESCE(p.quantity,0) END) <> 0
          OR SUM(CASE WHEN p.side='D' THEN p.amount ELSE -p.amount END) <> 0`;
    const products = await this.prisma.product.findMany({ where: { id: { in: rows.map((r) => r.product_id).filter(Boolean) } }, select: { id: true, name: true } });
    const stores = await this.prisma.store.findMany({ where: { id: { in: rows.map((r) => r.store_id).filter(Boolean) } }, select: { id: true, name: true } });
    let total = new D(0);
    const lines = rows.map((r) => {
      total = total.plus(r.amount);
      const qty = new D(r.qty);
      return {
        account: r.code, productId: r.product_id, product: products.find((x) => x.id === r.product_id)?.name ?? null,
        storeId: r.store_id, store: stores.find((x) => x.id === r.store_id)?.name ?? null,
        quantity: qty.toFixed(3), amount: new D(r.amount).toFixed(2), unitCost: qty.isZero() ? null : new D(r.amount).div(qty).toFixed(2),
        drill: `/accounting/reports/account-card?account=${r.code}&from=2000-01-01&to=${date}&PRODUCT=${r.product_id}&STORE=${r.store_id}`,
      };
    }).sort((a, b) => (a.product ?? '').localeCompare(b.product ?? ''));
    return { date, lines, total: total.toFixed(2) };
  }

  /** Взаиморасчёты: долги покупателей/поставщикам и авансы по контрагентам на дату. */
  async settlements(ctx: OrgContext, q: { date?: string }) {
    const date = q.date ?? new Date().toISOString().slice(0, 10);
    const toNext = ts(new Date(new Date(date + 'T00:00:00.000Z').getTime() + 86400000));
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT p.counterparty_id, a.code, SUM(CASE WHEN p.side='D' THEN p.amount ELSE -p.amount END) AS bal
      FROM acc_postings p JOIN acc_accounts a ON a.id = p.account_id
      WHERE p.organization_id=${ctx.organizationId} AND p.is_active AND p.ledger='BU' AND p.counterparty_id IS NOT NULL
        AND a.code IN ('1210','1710','3310','3510') AND p.date < ${toNext}::timestamp
      GROUP BY p.counterparty_id, a.code HAVING SUM(CASE WHEN p.side='D' THEN p.amount ELSE -p.amount END) <> 0`;
    const cps = await this.prisma.counterparty.findMany({ where: { id: { in: rows.map((r) => r.counterparty_id) } }, select: { id: true, name: true, inn: true } });
    const by = new Map<string, any>();
    for (const r of rows) {
      const o = by.get(r.counterparty_id) ?? { counterpartyId: r.counterparty_id, name: cps.find((c) => c.id === r.counterparty_id)?.name ?? null, bin: cps.find((c) => c.id === r.counterparty_id)?.inn ?? null, receivable: '0.00', advanceReceived: '0.00', payable: '0.00', advancePaid: '0.00' };
      const v = new D(r.bal);
      if (r.code === '1210') o.receivable = v.toFixed(2);
      if (r.code === '3510') o.advanceReceived = v.neg().toFixed(2);
      if (r.code === '3310') o.payable = v.neg().toFixed(2);
      if (r.code === '1710') o.advancePaid = v.toFixed(2);
      by.set(r.counterparty_id, o);
    }
    return { date, lines: [...by.values()].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '')) };
  }

  /** Названия аналитик по id (для показа вместо идентификаторов). Только справочники организации и общие. */
  async dimNames(ctx: OrgContext, dimsList: Record<string, string | null>[]) {
    const ids: Record<string, Set<string>> = {};
    for (const d of dimsList) for (const [k, v] of Object.entries(d)) if (v) (ids[k] ||= new Set()).add(v);
    const list = (k: string) => [...(ids[k] ?? [])];
    const org = ctx.organizationId;
    const [cps, contracts, products, stores, emps, depts, banks, boxes, projects, items, docs] = await Promise.all([
      list('COUNTERPARTY').length ? this.prisma.counterparty.findMany({ where: { id: { in: list('COUNTERPARTY') }, OR: [{ organizationId: null }, { organizationId: org }] }, select: { id: true, name: true } }) : [],
      list('CONTRACT').length ? this.prisma.contract.findMany({ where: { id: { in: list('CONTRACT') } }, select: { id: true, number: true } }) : [],
      list('PRODUCT').length ? this.prisma.product.findMany({ where: { id: { in: list('PRODUCT') }, OR: [{ organizationId: null }, { organizationId: org }] }, select: { id: true, name: true } }) : [],
      list('STORE').length ? this.prisma.store.findMany({ where: { id: { in: list('STORE') }, organizationId: org }, select: { id: true, name: true } }) : [],
      list('EMPLOYEE').length ? this.prisma.employee.findMany({ where: { id: { in: list('EMPLOYEE') } }, select: { id: true, lastName: true, firstName: true } }) : [],
      list('DEPARTMENT').length ? this.prisma.department.findMany({ where: { id: { in: list('DEPARTMENT') } }, select: { id: true, name: true } }) : [],
      list('BANK_ACCOUNT').length ? this.prisma.orgBankAccount.findMany({ where: { id: { in: list('BANK_ACCOUNT') }, organizationId: org }, select: { id: true, name: true, iban: true } }) : [],
      list('CASHBOX').length ? this.prisma.cashbox.findMany({ where: { id: { in: list('CASHBOX') }, organizationId: org }, select: { id: true, name: true } }) : [],
      list('PROJECT').length ? this.prisma.project.findMany({ where: { id: { in: list('PROJECT') }, organizationId: org }, select: { id: true, name: true } }) : [],
      list('ITEM').length ? this.prisma.accItem.findMany({ where: { id: { in: list('ITEM') }, organizationId: org }, select: { id: true, name: true } }) : [],
      list('SETTLEMENT_DOC').length ? this.prisma.document.findMany({ where: { id: { in: list('SETTLEMENT_DOC') } }, select: { id: true, number: true } }) : [],
    ]);
    const m = (rows: any[], f: (r: any) => string) => Object.fromEntries(rows.map((r) => [r.id, f(r)]));
    return {
      COUNTERPARTY: m(cps, (r) => r.name), CONTRACT: m(contracts, (r) => `Договор ${r.number}`), PRODUCT: m(products, (r) => r.name),
      STORE: m(stores, (r) => r.name), EMPLOYEE: m(emps, (r) => `${r.lastName} ${r.firstName}`), DEPARTMENT: m(depts, (r) => r.name),
      BANK_ACCOUNT: m(banks, (r) => `${r.name} (${r.iban})`), CASHBOX: m(boxes, (r) => r.name), PROJECT: m(projects, (r) => r.name),
      ITEM: m(items, (r) => r.name), SETTLEMENT_DOC: m(docs, (r) => r.number ?? r.id),
    } as Record<string, Record<string, string>>;
  }
}
