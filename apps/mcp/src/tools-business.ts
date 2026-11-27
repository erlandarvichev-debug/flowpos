import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ApiError, FlowPosApi } from './api.js';
import { UNTRUSTED_NOTE, money } from './format.js';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t.trim() || '(пусто)' }] });
const fail = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true });
const errorText = (e: unknown) => {
  if (e instanceof ApiError) {
    const b = e.body || {};
    return [`Ошибка ${e.status}${b.code ? ` (${b.code})` : ''}: ${b.message ?? e.message}`, b.fix && `Что сделать: ${b.fix}`].filter(Boolean).join('\n');
  }
  return String((e as any)?.message ?? e);
};
const wrap = <A>(fn: (a: A) => Promise<string>) => async (a: A) => { try { return text(await fn(a)); } catch (e) { return fail(errorText(e)); } };
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата ГГГГ-ММ-ДД');
const READ = { readOnlyHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${v}%`);
const TYPES: Record<string, string> = {
  CUSTOMER_ORDER: 'Заказ покупателя', INVOICE_OUT: 'Счёт покупателю', DEMAND: 'Реализация', SALES_RETURN: 'Возврат покупателя',
  PURCHASE_ORDER: 'Заказ поставщику', INVOICE_IN: 'Счёт поставщика', SUPPLY: 'Поступление', PURCHASE_RETURN: 'Возврат поставщику',
  MOVE: 'Перемещение', INTERNAL_ORDER: 'Внутренний заказ', ENTER: 'Оприходование', LOSS: 'Списание', INVENTORY: 'Инвентаризация',
};

/**
 * Инструменты управления торговлей (пакет 8): пульс бизнеса, долги по срокам, прибыльность, движение денег,
 * задачи, справочники, черновики торговых документов и производство. Как и остальные — от имени пользователя,
 * с его правами; торговые документы создаются только ЧЕРНОВИКАМИ, проводит их человек.
 */
export function registerBusinessTools(server: McpServer, api: FlowPosApi, link: (p: string) => string) {
  server.registerTool(
    'business_pulse',
    {
      title: 'Пульс бизнеса',
      description: 'Главные показатели фирмы за период со сравнением с прошлым: деньги (остаток, приход, расход), выручка, валовая и чистая прибыль, расходы, запасы, долги покупателей и поставщикам. По умолчанию — текущий месяц.',
      inputSchema: { from: DATE.optional(), to: DATE.optional() },
      annotations: READ,
    },
    wrap(async (q) => {
      const r = await api.request('GET', '/accounting/reports/pulse', { query: q });
      return [
        `Пульс бизнеса ${r.period.from} — ${r.period.to} (сравнение с ${r.period.prevFrom} — ${r.period.prevTo})`,
        `Деньги: остаток ${money(r.money.end)} ₸ (на начало ${money(r.money.start)}), пришло ${money(r.money.inflow)}, ушло ${money(r.money.outflow)}`,
        `Выручка без НДС: ${money(r.revenue.value)} ₸ (было ${money(r.revenue.prev)}, ${pct(r.revenue.delta)})`,
        `Валовая прибыль: ${money(r.grossProfit.value)} ₸, маржа ${r.grossProfit.margin ?? '—'}% (было ${money(r.grossProfit.prev)}, ${pct(r.grossProfit.delta)})`,
        `Расходы: ${money(r.expenses.value)} ₸ (${pct(r.expenses.delta)})${r.expenses.top.length ? ` — главные: ${r.expenses.top.map((e: any) => `${e.name} ${money(e.amount)}`).join('; ')}` : ''}`,
        `Чистая прибыль (оценка: валовая минус расходы в учёте): ${money(r.netProfit.value)} ₸ (было ${money(r.netProfit.prev)})`,
        `Запасы: ${money(r.stock.value)} ₸ (на начало ${money(r.stock.start)})`,
        `Нам должны покупатели: ${money(r.receivable.total)} ₸, просрочено ${money(r.receivable.overdue)} (${r.receivable.count} клиентов)`,
        `Мы должны поставщикам: ${money(r.payable.total)} ₸, просрочено ${money(r.payable.overdue)}`,
        `Открыть: ${link('/dashboard')}`,
      ].join('\n');
    }),
  );

  server.registerTool(
    'debt_aging',
    {
      title: 'Долги по срокам',
      description: 'Кто сколько должен (покупатели — side=customers) или кому должны мы (side=suppliers): срок оплаты, дни просрочки, корзины 1–30/31–60/61–90/>90, документы с долгом.',
      inputSchema: { side: z.enum(['customers', 'suppliers']).default('customers'), date: DATE.optional(), onlyOverdue: z.boolean().optional(), limit: z.number().int().min(1).max(100).default(30) },
      annotations: READ,
    },
    wrap(async ({ side, date, onlyOverdue, limit }) => {
      const r = await api.request('GET', '/accounting/reports/debt-aging', { query: { side, date } });
      const lines = r.lines.filter((l: any) => !onlyOverdue || Number(l.overdue) > 0).slice(0, limit);
      if (!lines.length) return `На ${r.date} ${onlyOverdue ? 'просроченных ' : ''}долгов нет`;
      return [
        `${side === 'customers' ? 'Долги покупателей' : 'Наши долги поставщикам'} на ${r.date}: всего ${money(r.totals.total)} ₸, просрочено ${money(r.totals.overdue)} ₸`,
        UNTRUSTED_NOTE,
        'Контрагент | Всего | Просрочено | Макс. просрочка, дн. | Телефон',
        ...lines.map((l: any) => `${l.name} (${l.bin ?? '—'}) | ${money(l.total)} | ${money(l.overdue)} | ${l.maxOverdueDays} | ${l.phone ?? '—'}`),
        ...lines.slice(0, 5).map((l: any) => `  ${l.name}: ${l.docs.slice(0, 5).map((d: any) => `${d.number ?? 'остаток'} от ${d.date}, срок ${d.dueDate}, ${money(d.amount)}${d.overdueDays ? `, просрочено ${d.overdueDays} дн.` : ''}`).join('; ')}`),
        `Открыть: ${link(`/reports/debt-aging${side === 'suppliers' ? '?side=suppliers' : ''}`)}`,
      ].join('\n');
    }),
  );

  server.registerTool(
    'sales_profitability',
    {
      title: 'Прибыльность продаж',
      description: 'Выручка без НДС, себестоимость, прибыль, маржа и наценка за период — по товарам, группам, покупателям, сотрудникам, складам или документам; ABC по прибыли и убыточные позиции.',
      inputSchema: { from: DATE.optional(), to: DATE.optional(), groupBy: z.enum(['product', 'group', 'counterparty', 'employee', 'store', 'document']).default('product'), limit: z.number().int().min(1).max(100).default(20), onlyLossMaking: z.boolean().optional() },
      annotations: READ,
    },
    wrap(async ({ from, to, groupBy, limit, onlyLossMaking }) => {
      const r = await api.request('GET', '/accounting/reports/profitability', { query: { from, to, groupBy, compare: '1' } });
      const lines = r.lines.filter((l: any) => !onlyLossMaking || l.lossMaking).slice(0, limit);
      return [
        `Прибыльность ${r.from} — ${r.to}: выручка ${money(r.totals.netRevenue)} ₸, себестоимость ${money(r.totals.cost)}, прибыль ${money(r.totals.profit)}, маржа ${r.totals.margin ?? '—'}%${r.previous ? ` (прошлый период: прибыль ${money(r.previous.profit)})` : ''}`,
        'Позиция | Выручка | Себестоимость | Прибыль | Маржа | ABC',
        ...lines.map((l: any) => `${l.name}${l.code ? ` (${l.code})` : ''} | ${money(l.netRevenue)} | ${money(l.cost)} | ${money(l.profit)} | ${l.margin ?? '—'}% | ${l.abc}`),
        `Открыть: ${link('/reports/profitability')}`,
      ].join('\n');
    }),
  );

  server.registerTool(
    'money_flow',
    {
      title: 'Движение денег',
      description: 'Поступления и выплаты по банку и кассам за период по статьям или видам операций (без переводов между своими счетами), остатки на начало и конец.',
      inputSchema: { from: DATE.optional(), to: DATE.optional(), by: z.enum(['item', 'operation']).default('operation') },
      annotations: READ,
    },
    wrap(async (q) => {
      const r = await api.request('GET', '/accounting/reports/money-flow', { query: q });
      return [
        `Движение денег ${r.from} — ${r.to}: на начало ${money(r.opening)}, пришло ${money(r.inflow)}, ушло ${money(r.outflow)}, на конец ${money(r.closing)} ₸`,
        'Статья | Поступления | Выплаты | Итог',
        ...r.lines.map((l: any) => `${l.name} | ${money(l.inflow)} | ${money(l.outflow)} | ${money(l.net)}`),
      ].join('\n');
    }),
  );

  server.registerTool(
    'catalog_search',
    {
      title: 'Поиск товаров и контрагентов',
      description: 'Найти товар (kind=product) или покупателя/поставщика (kind=counterparty) по названию, артикулу, БИН — чтобы получить id для черновика документа или задачи.',
      inputSchema: { kind: z.enum(['product', 'counterparty']), search: z.string().min(1).max(100), limit: z.number().int().min(1).max(30).default(10) },
      annotations: READ,
    },
    wrap(async ({ kind, search, limit }) => {
      const r = await api.request('GET', kind === 'product' ? '/catalog/items' : '/catalog/counterparties', { query: { search, limit } });
      const items = r.items ?? r;
      if (!items.length) return 'Ничего не найдено';
      return [UNTRUSTED_NOTE, ...items.map((x: any) => (kind === 'product'
        ? `${x.name} | id ${x.id}${x.article ? ` | арт. ${x.article}` : ''}${x.barcode ? ` | шк ${x.barcode}` : ''}`
        : `${x.name} | id ${x.id}${x.inn ? ` | БИН ${x.inn}` : ''}${x.phone ? ` | тел. ${x.phone}` : ''}${x.paymentDays != null ? ` | отсрочка ${x.paymentDays} дн.` : ''}`))].join('\n');
    }),
  );

  server.registerTool(
    'trade_create_draft',
    {
      title: 'Создать черновик торгового документа',
      description: 'Создаёт ЧЕРНОВИК (не проводит) заказа покупателя, счёта покупателю, заказа поставщику или внутреннего заказа. Цена в строке необязательна для заказа и счёта покупателю — возьмётся из прайс-листа. id товаров, контрагента и склада — через catalog_search и warehouses. Проводит документ человек в FlowPOS.',
      inputSchema: {
        docType: z.enum(['CUSTOMER_ORDER', 'INVOICE_OUT', 'PURCHASE_ORDER', 'INTERNAL_ORDER']),
        date: DATE,
        counterpartyId: z.string().optional().describe('Обязателен, кроме внутреннего заказа'),
        storeId: z.string().describe('Склад (для внутреннего заказа — откуда)'),
        storeToId: z.string().optional().describe('Только внутренний заказ: куда'),
        comment: z.string().max(500).optional(),
        lines: z.array(z.object({ productId: z.string(), qty: z.string().regex(/^\d+(\.\d{1,3})?$/), price: z.string().regex(/^\d+(\.\d{1,2})?$/).optional() })).min(1).max(200),
      },
      annotations: WRITE,
    },
    wrap(async (b) => {
      const d = await api.request('POST', '/accounting/trade-documents', {
        body: { ...b, comment: `[Черновик ИИ] ${b.comment ?? ''}`.trim(), status: 'DRAFT' }, idempotencyKey: randomUUID(),
      });
      return [`Создан черновик: ${TYPES[d.docType] ?? d.docType} ${d.number} на ${money(d.total)} ₸ (не проведён).`, `Проверьте и проведите: ${link(`/accounting/trade/${d.id}`)}`].join('\n');
    }),
  );

  server.registerTool(
    'warehouses',
    {
      title: 'Склады',
      description: 'Склады организации и их id (для черновиков документов и отчётов).',
      inputSchema: {},
      annotations: READ,
    },
    wrap(async () => {
      const r: any[] = await api.request('GET', '/catalog/warehouses');
      return r.filter((s) => !s.isTransit).map((s) => `${s.name} | id ${s.id}${s.consigneeId ? ' | склад комиссионера' : ''}`).join('\n') || 'Складов нет';
    }),
  );

  server.registerTool(
    'tasks_list',
    {
      title: 'Задачи',
      description: 'Задачи сотрудников: мои (scope=mine), поставленные мной (created) или все (all); по умолчанию невыполненные; можно только просроченные.',
      inputSchema: { scope: z.enum(['mine', 'created', 'all']).default('mine'), done: z.boolean().optional(), overdue: z.boolean().optional() },
      annotations: READ,
    },
    wrap(async ({ scope, done, overdue }) => {
      const r: any[] = await api.request('GET', '/accounting/tasks', { query: { scope, done: done ? '1' : '0', overdue: overdue ? '1' : undefined } });
      if (!r.length) return 'Задач нет';
      return [UNTRUSTED_NOTE, ...r.slice(0, 50).map((t) => `${t.done ? '✓' : t.overdue ? '!' : '•'} ${t.title} | срок ${t.dueAt ? new Date(new Date(t.dueAt).getTime() + 5 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') : '—'} | ${t.assignee?.name ?? '—'}${t.counterparty ? ` | ${t.counterparty.name}` : ''}${t.document ? ` | № ${t.document.number}` : ''}`), `Открыть: ${link('/tasks')}`].join('\n');
    }),
  );

  server.registerTool(
    'task_create',
    {
      title: 'Поставить задачу',
      description: 'Создаёт задачу сотруднику (по умолчанию — себе): текст, срок, связь с контрагентом или документом. Например: «позвонить клиенту по просроченному долгу».',
      inputSchema: {
        title: z.string().min(2).max(300), description: z.string().max(2000).optional(),
        dueAt: z.string().regex(/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2})?$/).optional().describe('ГГГГ-ММ-ДД или ГГГГ-ММ-ДДTЧЧ:ММ (время Казахстана)'),
        assigneeId: z.string().optional(), counterpartyId: z.string().optional(), documentId: z.string().optional(),
      },
      annotations: WRITE,
    },
    wrap(async (b) => {
      const t = await api.request('POST', '/accounting/tasks', { body: b, idempotencyKey: randomUUID() });
      return `Задача поставлена: «${t.title}», исполнитель ${t.assignee?.name ?? '—'}${t.dueAt ? `, срок ${new Date(new Date(t.dueAt).getTime() + 5 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')}` : ''}. ${link('/tasks')}`;
    }),
  );

  server.registerTool(
    'production_overview',
    {
      title: 'Производство',
      description: 'Техкарты (из чего делается продукция) и выпуски продукции: план, выпущено, себестоимость.',
      inputSchema: { status: z.enum(['PLANNED', 'DONE', 'CANCELLED']).optional() },
      annotations: READ,
    },
    wrap(async ({ status }) => {
      const [recipes, orders]: any[] = await Promise.all([api.request('GET', '/accounting/production/recipes'), api.request('GET', '/accounting/production/orders', { query: { status } })]);
      return [
        `Техкарт: ${recipes.length}`,
        ...recipes.slice(0, 20).map((r: any) => `- ${r.name}: ${r.product.name} × ${Number(r.outputQty)} ← ${r.materials.map((m: any) => `${m.name} ${Number(m.qty)}`).join(', ')}`),
        `Выпусков: ${orders.length}`,
        ...orders.slice(0, 30).map((o: any) => `- ${o.number} ${o.date.slice(0, 10)} | ${o.product.name} × ${Number(o.qty)} | ${o.status}${o.cost ? ` | себестоимость ${money(o.cost)}` : ''}`),
        `Открыть: ${link('/production')}`,
      ].join('\n');
    }),
  );
}
