import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ApiError, FlowPosApi } from './api.js';
import { UNTRUSTED_NOTE, bal, explainPostings, money } from './format.js';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t.trim() || '(пусто)' }] });
const fail = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true });

function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    const b = e.body || {};
    return [`Ошибка ${e.status}${b.code ? ` (${b.code})` : ''}: ${b.message ?? e.message}`, b.fix && `Что сделать: ${b.fix}`, b.link && `Раздел: ${b.link}`]
      .filter(Boolean)
      .join('\n');
  }
  return String((e as any)?.message ?? e);
}

const wrap = <A>(fn: (a: A) => Promise<string>) => async (a: A) => {
  try {
    return text(await fn(a));
  } catch (e) {
    return fail(errorText(e));
  }
};

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата ГГГГ-ММ-ДД');
const AMOUNT = z.string().regex(/^-?\d+(\.\d{1,2})?$/, 'Сумма строкой, до 2 знаков: "1500.00"');
const DIMS = z.record(z.string(), z.string()).optional().describe('Аналитики: {"COUNTERPARTY":"<id>","BANK_ACCOUNT":"<id>",...}');

const READ = { readOnlyHint: true, openWorldHint: false } as const;

/**
 * Инструменты бухгалтерии. По умолчанию — только чтение и создание ЧЕРНОВИКОВ.
 * Проведение, отмена проведения, изменение реквизитов оплаты, подписание и отправка отчётности
 * через MCP недоступны: их выполняет уполномоченный пользователь в интерфейсе после предпросмотра.
 */
export function registerTools(server: McpServer, api: FlowPosApi, webUrl: string) {
  const link = (path: string) => `${webUrl}${path}`;

  server.registerTool(
    'flowpos_context',
    { title: 'Контекст пользователя', description: 'Текущая организация, роль, права и список доступных организаций.', inputSchema: {}, annotations: READ },
    wrap(async () => {
      const [ctx, orgs] = await Promise.all([api.request('GET', '/accounting/context'), api.request<any[]>('GET', '/accounting/organizations/mine')]);
      return [
        `Организация: ${ctx.organizationId}, роль: ${ctx.role}`,
        `Права: ${ctx.permissions.join(', ')}`,
        'Доступные организации:',
        ...orgs.map((o) => `- ${o.name} (БИН/ИИН ${o.inn ?? '—'}) id=${o.id} роль=${o.role}${o.id === ctx.organizationId ? ' ← текущая' : ''}`),
      ].join('\n');
    }),
  );

  server.registerTool(
    'flowpos_switch_organization',
    { title: 'Сменить организацию', description: 'Переключить организацию для следующих запросов (только из доступных пользователю).', inputSchema: { organizationId: z.string() }, annotations: { readOnlyHint: true } },
    wrap(async ({ organizationId }) => {
      const orgs = await api.request<any[]>('GET', '/accounting/organizations/mine');
      const org = orgs.find((o) => o.id === organizationId);
      if (!org) throw new Error('Нет доступа к этой организации');
      api.setOrganization(organizationId);
      return `Текущая организация: ${org.name} (роль ${org.role})`;
    }),
  );

  server.registerTool(
    'accounting_chart_search',
    {
      title: 'Поиск по плану счетов',
      description: 'Найти счета по коду или названию. Возвращает признаки (групповой, количественный, валютный) и аналитики.',
      inputSchema: { query: z.string().min(1).describe('Код или часть названия, например "1330" или "товары"') },
      annotations: READ,
    },
    wrap(async ({ query }) => {
      const all = await api.request<any[]>('GET', '/accounting/chart');
      const q = query.toLowerCase();
      const found = all.filter((a) => a.code.startsWith(query) || a.name.toLowerCase().includes(q) || (a.nameKk || '').toLowerCase().includes(q)).slice(0, 40);
      if (!found.length) return 'Счета не найдены';
      return found
        .map((a) => `${a.code} ${a.name}${a.isGroup ? ' [групповой — проводки запрещены]' : ''}${a.isQuantitative ? ' [кол-во]' : ''}${a.isCurrency ? ' [валюта]' : ''}${a.dims?.length ? ` аналитики: ${a.dims.join(', ')}` : ''}${a.requiredDims?.length ? ` (обязательны: ${a.requiredDims.join(', ')})` : ''}`)
        .join('\n');
    }),
  );

  server.registerTool(
    'accounting_search_documents',
    {
      title: 'Поиск документов',
      description: 'Поиск бухгалтерских документов по номеру/комментарию, типу, статусу и периоду.',
      inputSchema: {
        search: z.string().optional(),
        docType: z.enum(['MANUAL_OPERATION', 'OPENING_BALANCE', 'STORNO']).optional(),
        status: z.enum(['DRAFT', 'POSTED', 'CANCELLED']).optional(),
        from: DATE.optional(),
        to: DATE.optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: READ,
    },
    wrap(async (q) => {
      const r = await api.request('GET', '/accounting/documents', { query: { ...q, limit: q.limit ?? 30 } });
      if (!r.items.length) return 'Документы не найдены';
      return [
        `Найдено: ${r.total} (показано ${r.items.length})`,
        UNTRUSTED_NOTE,
        ...r.items.map((d: any) => `- ${d.number} от ${d.date.slice(0, 10)} ${d.docType} ${d.status} ${money(d.amount)} ₸ — ${d.comment ?? ''} | id=${d.id} | ${link(`/accounting/documents/${d.id}`)}`),
      ].join('\n');
    }),
  );

  server.registerTool(
    'accounting_get_document',
    {
      title: 'Документ с проводками и историей',
      description: 'Документ: реквизиты, проводки с объяснением, связанные документы, история версий.',
      inputSchema: { id: z.string() },
      annotations: READ,
    },
    wrap(async ({ id }) => {
      const d = await api.request('GET', `/accounting/documents/${id}`);
      return [
        `${d.number} от ${d.date.slice(0, 10)} — ${d.docType}, статус ${d.status}, версия ${d.version}, сумма ${money(d.amount)} ₸`,
        `Ссылка: ${link(`/accounting/documents/${d.id}`)}`,
        UNTRUSTED_NOTE,
        `Комментарий: ${d.comment ?? '—'}`,
        d.entry ? `Проводки (правило ${d.entry.ruleCode} v${d.entry.ruleVersion}, версия документа ${d.entry.sourceVersion}):\n${explainPostings(d.entry.postings)}` : 'Проводок нет (документ не проведён).',
        d.related?.length ? `Связанные: ${d.related.map((r: any) => `${r.number} (${r.docType}, ${r.status})`).join('; ')}` : '',
        `История: ${d.versions.map((v: any) => `v${v.version} ${v.action}${v.reason ? ` «${v.reason}»` : ''} ${v.createdAt.slice(0, 16)}`).join('; ')}`,
      ].filter(Boolean).join('\n');
    }),
  );

  server.registerTool(
    'accounting_trial_balance',
    {
      title: 'Оборотно-сальдовая ведомость',
      description: 'ОСВ за период. Для каждого счёта — сальдо и обороты; используйте accounting_account_card для расшифровки.',
      inputSchema: { from: DATE, to: DATE, ledger: z.enum(['BU', 'NU']).optional(), onlyAccounts: z.boolean().optional().describe('true — без строк разделов') },
      annotations: READ,
    },
    wrap(async ({ from, to, ledger, onlyAccounts }) => {
      const r = await api.request('GET', '/accounting/reports/trial-balance', { query: { from, to, ledger } });
      const rows = r.lines.filter((l: any) => !onlyAccounts || !l.isGroup);
      return [
        `ОСВ ${from} — ${to} (${r.ledger === 'NU' ? 'налоговый' : 'бухгалтерский'} учёт). Отчёт: ${link(`/accounting/reports/trial-balance?from=${from}&to=${to}`)}`,
        'Счёт | Сальдо нач. | Оборот Дт | Оборот Кт | Сальдо кон.',
        ...rows.map((l: any) => `${l.isGroup ? '' : '  '}${l.code} ${l.name} | ${bal(l.opening)} | ${money(l.turnover.debit)} | ${money(l.turnover.credit)} | ${bal(l.closing)}`),
        `Итого обороты: Дт ${money(r.totals.turnover.debit)} / Кт ${money(r.totals.turnover.credit)}; баланс ${r.balanced ? 'сходится' : 'НЕ сходится'}`,
        ...r.warnings.map((w: string) => `⚠ ${w}`),
      ].join('\n');
    }),
  );

  server.registerTool(
    'accounting_account_card',
    {
      title: 'Карточка счёта',
      description: 'Все проводки по счёту (и его субсчетам) за период с кор. счетами, сальдо нарастающим итогом и ссылками на документы.',
      inputSchema: { account: z.string(), from: DATE, to: DATE, ledger: z.enum(['BU', 'NU']).optional(), dims: DIMS },
      annotations: READ,
    },
    wrap(async ({ account, from, to, ledger, dims }) => {
      const r = await api.request('GET', '/accounting/reports/account-card', { query: { account, from, to, ledger, ...(dims || {}) } });
      return [
        `Карточка счёта ${r.account.code} ${r.account.name}, ${from} — ${to}. Сальдо на начало: ${bal(r.opening)}`,
        UNTRUSTED_NOTE,
        ...r.lines.map((l: any) => `${l.date.slice(0, 10)} ${l.source.number ?? l.source.type} | ${l.debit ? `Дт ${money(l.debit)}` : `Кт ${money(l.credit)}`} | кор. ${l.corrAccounts ?? '—'} | сальдо ${bal(l.balance)}${l.memo ? ` | ${l.memo}` : ''}${l.source.link ? ` | ${link(l.source.link)}` : ''}`),
        `Обороты: Дт ${money(r.turnover.debit)} / Кт ${money(r.turnover.credit)}. Сальдо на конец: ${bal(r.closing)}`,
      ].join('\n');
    }),
  );

  server.registerTool(
    'accounting_create_draft',
    {
      title: 'Создать черновик операции',
      description:
        'Создаёт ЧЕРНОВИК ручной операции (не проводит). Строки: Дт счёт / Кт счёт / сумма с аналитиками. Перед созданием найдите счета через accounting_chart_search. Проводит документ только человек в интерфейсе после проверки.',
      inputSchema: {
        date: DATE,
        comment: z.string().max(500),
        lines: z
          .array(
            z.object({
              debit: z.string().describe('Код счёта дебета'),
              credit: z.string().describe('Код счёта кредита'),
              amount: AMOUNT,
              debitDims: DIMS,
              creditDims: DIMS,
              memo: z.string().max(200).optional(),
            }),
          )
          .min(1)
          .max(100),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    wrap(async ({ date, comment, lines }) => {
      const body = {
        docType: 'MANUAL_OPERATION',
        date,
        comment: `[Черновик ИИ] ${comment}`,
        body: { lines: lines.map((l) => ({ amount: l.amount, memo: l.memo, debit: { account: l.debit, dims: l.debitDims }, credit: { account: l.credit, dims: l.creditDims } })) },
      };
      const d = await api.request('POST', '/accounting/documents', { body, idempotencyKey: randomUUID() });
      return [
        `Создан черновик ${d.number} на сумму ${money(d.amount)} ₸ (не проведён).`,
        `Проверьте и проведите вручную: ${link(`/accounting/documents/${d.id}`)}`,
        'Проверки счетов и аналитик выполняются при проведении — если будут ошибки, интерфейс покажет, что исправить.',
      ].join('\n');
    }),
  );

  server.registerTool(
    'accounting_journal',
    {
      title: 'Журнал проводок',
      description: 'Записи движений за период: документ, правило формирования и версия, проводки.',
      inputSchema: { from: DATE, to: DATE, ledger: z.enum(['BU', 'NU']).optional(), limit: z.number().int().min(1).max(200).optional() },
      annotations: READ,
    },
    wrap(async ({ from, to, ledger, limit }) => {
      const r = await api.request('GET', '/accounting/reports/journal', { query: { from, to, ledger, limit: limit ?? 50 } });
      if (!r.entries.length) return 'Проводок за период нет';
      return [
        UNTRUSTED_NOTE,
        ...r.entries.map((e: any) => `${e.date.slice(0, 10)} ${e.source.number ?? e.source.type} (${e.rule}): ${e.postings.map((p: any) => `${p.side === 'D' ? 'Дт' : 'Кт'} ${p.account} ${money(p.amount)}`).join(', ')}`),
      ].join('\n');
    }),
  );

  server.registerTool(
    'trade_search_documents',
    {
      title: 'Торговые документы',
      description: 'Поступления, реализации, возвраты, перемещения, списания, чеки, платежи FlowPOS и их статус отражения в учёте (REFLECTED / ISSUE / NONE).',
      inputSchema: {
        search: z.string().optional(),
        docType: z.enum(['PURCHASE_ORDER', 'SUPPLY', 'PURCHASE_RETURN', 'CUSTOMER_ORDER', 'DEMAND', 'SALES_RETURN', 'ENTER', 'LOSS', 'MOVE', 'RETAIL_DEMAND', 'RETAIL_RETURN', 'PAYMENT_IN', 'PAYMENT_OUT']).optional(),
        status: z.enum(['DRAFT', 'POSTED', 'CANCELLED']).optional(),
        from: DATE.optional(),
        to: DATE.optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: READ,
    },
    wrap(async (q) => {
      const r = await api.request('GET', '/accounting/trade-documents', { query: { ...q, limit: q.limit ?? 30 } });
      if (!r.items.length) return 'Документы не найдены';
      return [
        `Найдено: ${r.total} (показано ${r.items.length})`,
        UNTRUSTED_NOTE,
        ...r.items.map((d: any) => `- ${d.number ?? '—'} от ${d.date.slice(0, 10)} ${d.docType} ${d.status} ${money(d.total)} ₸ ${d.counterparty?.name ?? ''} | учёт: ${d.accounting}${d.issue ? ` (${d.issue.message})` : ''} | id=${d.id} | ${link(`/accounting/trade/${d.id}`)}`),
      ].join('\n');
    }),
  );

  server.registerTool(
    'trade_get_document',
    {
      title: 'Торговый документ с проводками и себестоимостью',
      description: 'Строки документа, проводки автопилота (выручка, НДС, расчёты) и проводки себестоимости.',
      inputSchema: { id: z.string() },
      annotations: READ,
    },
    wrap(async ({ id }) => {
      const d = await api.request('GET', `/accounting/trade-documents/${id}`);
      return [
        `${d.number ?? '—'} от ${d.date.slice(0, 10)} — ${d.docType}, ${d.status}, сумма ${money(d.total)} ₸, контрагент: ${d.counterparty?.name ?? '—'}`,
        `Ссылка: ${link(`/accounting/trade/${d.id}`)}`,
        UNTRUSTED_NOTE,
        'Строки:',
        ...d.lines.map((l: any) => `  ${l.lineNo}. ${l.product?.name} × ${l.qty} по ${money(l.price)} = ${money(l.amount)}${l.vatRate !== null ? ` (НДС ${l.vatRate}%)` : ''}`),
        d.entry ? `Проводки:\n${explainPostings(d.entry.postings)}` : 'Проводок нет.',
        d.costEntries?.length ? `Себестоимость:\n${explainPostings(d.costEntries.flatMap((e: any) => e.postings))}` : '',
        d.issue ? `⚠ Проблема автопилота: ${d.issue.message}${d.issue.fix ? ` Что сделать: ${d.issue.fix}` : ''}` : '',
      ].filter(Boolean).join('\n');
    }),
  );

  server.registerTool(
    'accounting_stock',
    {
      title: 'Остатки и себестоимость по складам',
      description: 'Количество и стоимость запасов по данным бухгалтерского учёта на дату.',
      inputSchema: { date: DATE.optional(), storeId: z.string().optional() },
      annotations: READ,
    },
    wrap(async (q) => {
      const r = await api.request('GET', '/accounting/reports/stock', { query: q });
      if (!r.lines.length) return `На ${r.date} запасов нет`;
      return [
        `Остатки на ${r.date}, всего ${money(r.total)} ₸`,
        ...r.lines.map((l: any) => `${l.product} | ${l.store} | ${l.quantity} шт | ${money(l.amount)} ₸ | цена ${money(l.unitCost)}`),
      ].join('\n');
    }),
  );

  server.registerTool(
    'accounting_settlements',
    {
      title: 'Расчёты с контрагентами',
      description: 'Долги покупателей, долги поставщикам и авансы по контрагентам на дату.',
      inputSchema: { date: DATE.optional() },
      annotations: READ,
    },
    wrap(async (q) => {
      const r = await api.request('GET', '/accounting/reports/settlements', { query: q });
      if (!r.lines.length) return `На ${r.date} задолженностей нет`;
      return [
        `Расчёты на ${r.date}`,
        UNTRUSTED_NOTE,
        'Контрагент | Долг покупателя | Аванс получен | Долг поставщику | Аванс выдан',
        ...r.lines.map((l: any) => `${l.name} (${l.bin ?? '—'}) | ${money(l.receivable)} | ${money(l.advanceReceived)} | ${money(l.payable)} | ${money(l.advancePaid)}`),
      ].join('\n');
    }),
  );

  server.registerTool(
    'autopilot_issues',
    {
      title: 'Проблемы автопилота',
      description: 'Документы, которые автопилот не смог отразить в учёте, с причиной и подсказкой, что исправить.',
      inputSchema: {},
      annotations: READ,
    },
    wrap(async () => {
      const [st, issues] = await Promise.all([api.request('GET', '/accounting/autopilot/status'), api.request<any[]>('GET', '/accounting/autopilot/issues')]);
      return [
        `Автопилот ${st.enabled ? 'включён' : 'выключен'}: проведено торговых документов ${st.postedTradeDocuments}, отражено ${st.reflected}, открытых проблем ${st.openIssues}.`,
        ...issues.map((i: any) => `- ${i.document?.number ?? i.sourceId} (${i.document?.docType ?? ''}): ${i.message}${i.fix ? ` → ${i.fix}` : ''} | ${link(`/accounting/trade/${i.sourceId}`)}`),
      ].join('\n');
    }),
  );
  server.registerTool(
    'esf_invoices',
    {
      title: 'ЭСФ: исходящие и входящие',
      description: 'Реестр электронных счетов-фактур организации (ИС ЭСФ КГД): статусы, суммы, рег. номера, отказы ФЛК и реализации без ЭСФ. Только просмотр — подписывать и отправлять ЭСФ может только человек своей ЭЦП.',
      inputSchema: { direction: z.enum(['OUTBOUND', 'INBOUND']).optional().describe('OUTBOUND — исходящие, INBOUND — входящие'), status: z.string().optional().describe('Фильтр статусов через запятую, напр. READY,REJECTED') },
      annotations: READ,
    },
    wrap(async ({ direction, status }: { direction?: string; status?: string }) => {
      const dir = direction ?? 'OUTBOUND';
      const [sum, list] = await Promise.all([
        api.request('GET', '/accounting/esf/summary'),
        api.request('GET', '/accounting/esf/invoices', { query: { direction: dir, status, limit: '100' } }),
      ]);
      const counts = (sum.counts ?? []).map((c: any) => `${c.direction === 'OUTBOUND' ? 'исх.' : 'вх.'} ${c.status}: ${c.count}`).join(', ') || 'нет';
      return [
        `ИС ЭСФ (${sum.environment === 'PROD' ? 'боевая' : 'тестовый стенд'}): ${counts}. Реализаций без ЭСФ: ${sum.pendingDocs}. Требуют исправления: ${sum.outdated}.`,
        ...list.items.map((i: any) => `- № ${i.num} от ${String(i.date).slice(0, 10)} | ${dir === 'OUTBOUND' ? i.customerName + ' ' + (i.customerTin ?? '') : i.sellerName + ' ' + (i.sellerTin ?? '')} | всего ${i.totalWithTax}, НДС ${i.totalNds} | ${i.status}${i.esfStatus && i.esfStatus !== i.status ? '/' + i.esfStatus : ''}${i.registrationNumber ? ' | ' + i.registrationNumber : ''}${i.errors?.length ? ' | ошибки: ' + i.errors.map((e: any) => e.text || e.errorCode).join('; ') : ''}`),
        ...(dir === 'OUTBOUND' && list.pending?.length ? ['Без ЭСФ:', ...list.pending.map((d: any) => `- Реализация ${d.number} от ${String(d.date).slice(0, 10)}, ${d.counterparty} | ${link(`/accounting/trade/${d.id}`)}`)] : []),
        link('/accounting/esf'),
      ].join('\n');
    }),
  );
  server.registerTool(
    'accounting_statement',
    {
      title: 'Финансовая отчётность (Баланс, ОПиУ, ДДС)',
      description: 'Формы по приказу МФ РК № 404: balance — Бухгалтерский баланс на дату, profit-loss — Отчёт о прибылях и убытках за период, cash-flow — ДДС прямым методом. С проверками сходимости. Только чтение.',
      inputSchema: {
        form: z.enum(['balance', 'profit-loss', 'cash-flow']),
        date: DATE.optional().describe('Для баланса: на дату (по умолчанию сегодня)'),
        from: DATE.optional().describe('Для ОПиУ и ДДС: начало периода (по умолчанию 1 января)'),
        to: DATE.optional().describe('Для ОПиУ и ДДС: конец периода'),
      },
      annotations: READ,
    },
    wrap(async ({ form, date, from, to }: { form: string; date?: string; from?: string; to?: string }) => {
      const st = await api.request('GET', `/accounting/statements/${form}`, { query: form === 'balance' ? { date } : { from, to } });
      const lines = st.lines.filter((l: any) => !l.header && (Number(l.current) !== 0 || Number(l.previous) !== 0 || l.bold));
      return [
        `${st.title} — ${st.organization.name}${st.organization.bin ? `, БИН ${st.organization.bin}` : ''}`,
        form === 'balance' ? `на ${st.period.to} (сравнение: ${st.period.previousTo}), в тенге` : `за ${st.period.from}–${st.period.to} (сравнение: ${st.period.previousFrom}–${st.period.previousTo}), в тенге`,
        ...lines.map((l: any) => `${/^[0-9]/.test(l.code) ? l.code : '   '} ${l.name}: ${l.current} | ${l.previous}`),
        'Проверки: ' + st.checks.map((c: any) => `${c.ok ? 'OK' : 'ОШИБКА'} — ${c.message}`).join('; '),
        `Примечание: ${st.note}`,
        link(`/accounting/statements?form=${form}`),
      ].join('\n');
    }),
  );

  server.registerTool(
    'closing_status',
    {
      title: 'Закрытие месяца: проверки и итоги',
      description: 'Готов ли месяц к закрытию (черновики, неотражённые документы, отрицательные остатки, курсы, деньги в пути, ЭСФ) и итоги закрытия. Закрывает месяц только человек.',
      inputSchema: { period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'ГГГГ-ММ') },
      annotations: READ,
    },
    wrap(async ({ period }: { period: string }) => {
      const st = await api.request('GET', `/accounting/closing/${period}`);
      const icon: Record<string, string> = { ok: 'OK', warn: 'ВНИМАНИЕ', error: 'БЛОКИРУЕТ', todo: '—' };
      return [
        `Месяц ${period}: ${st.closed ? `закрыт (по ${st.lockedUntil})` : st.canClose ? 'можно закрывать' : 'закрыть нельзя — есть блокирующие проблемы'}`,
        ...st.steps.map((x: any) => `- [${icon[x.status]}] ${x.title}: ${x.message}${x.fix && x.status !== 'ok' ? ` → ${x.fix}` : ''}`),
        st.closed && st.last?.summary ? `Итоги: деньги ${st.last.summary.cash}, запасы ${st.last.summary.stock}, прибыль с начала года ${st.last.summary.profitYtd}` : `При закрытии: ${st.actions.join('; ')}`,
        link('/accounting/closing'),
      ].join('\n');
    }),
  );
}
