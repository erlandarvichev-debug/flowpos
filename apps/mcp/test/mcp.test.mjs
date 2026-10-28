// Сквозной тест MCP: реальный клиент ↔ сервер (stdio) ↔ API FlowPOS на :3000.
// Пропускается, если API недоступен.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const API = process.env.FLOWPOS_API_URL || 'http://localhost:3000';
const up = await fetch(`${API}/api/docs`).then((r) => r.ok).catch(() => false);

test('MCP: инструменты, чтение, черновик, запрет проведения', { skip: !up && 'API FlowPOS не запущен' }, async () => {
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['dist/index.js'],
    env: { ...process.env, FLOWPOS_API_URL: API, FLOWPOS_EMAIL: process.env.FLOWPOS_EMAIL || 'admin@flowpos.kz', FLOWPOS_PASSWORD: process.env.FLOWPOS_PASSWORD || 'admin123' },
  });
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    assert.ok(names.includes('accounting_trial_balance'));
    assert.ok(names.includes('accounting_create_draft'));
    assert.ok(!names.some((n) => /post|storno|delete|sign|send/i.test(n)), 'нет инструментов проведения/подписания');

    assert.ok(names.includes('esf_invoices'));
    const bal = await client.callTool({ name: 'accounting_statement', arguments: { form: 'balance' } });
    assert.ok(!bal.isError, bal.content[0].text);
    assert.match(bal.content[0].text, /Бухгалтерский баланс[\s\S]*Проверки: OK — Актив = Пассив/);
    const cl = await client.callTool({ name: 'closing_status', arguments: { period: '2026-09' } });
    assert.ok(!cl.isError, cl.content[0].text);
    assert.match(cl.content[0].text, /Месяц 2026-09/);
    const esf = await client.callTool({ name: 'esf_invoices', arguments: {} });
    assert.ok(!esf.isError, esf.content[0].text);
    assert.match(esf.content[0].text, /ИС ЭСФ \(тестовый стенд|ИС ЭСФ \(боевая/);

    const ctx = await client.callTool({ name: 'flowpos_context', arguments: {} });
    assert.match(ctx.content[0].text, /роль/);

    const chart = await client.callTool({ name: 'accounting_chart_search', arguments: { query: '7170' } });
    assert.match(chart.content[0].text, /7170 Прочие расходы/);

    const draft = await client.callTool({
      name: 'accounting_create_draft',
      arguments: { date: '2026-10-10', comment: 'тест MCP', lines: [{ debit: '7170', credit: '5030', amount: '12.34' }] },
    });
    assert.ok(!draft.isError, draft.content[0].text);
    assert.match(draft.content[0].text, /черновик ОП-2026-\d+ на сумму 12\.34/);

    const docs = await client.callTool({ name: 'accounting_search_documents', arguments: { search: 'тест MCP', status: 'DRAFT' } });
    assert.match(docs.content[0].text, /DRAFT/);
    const id = docs.content[0].text.match(/id=([0-9a-f-]{36})/)[1];
    const doc = await client.callTool({ name: 'accounting_get_document', arguments: { id } });
    assert.match(doc.content[0].text, /Проводок нет/);

    const tb = await client.callTool({ name: 'accounting_trial_balance', arguments: { from: '2026-10-01', to: '2026-10-31' } });
    assert.match(tb.content[0].text, /баланс сходится/);

    const bad = await client.callTool({ name: 'accounting_get_document', arguments: { id: '00000000-0000-0000-0000-000000000000' } });
    assert.ok(bad.isError);
    assert.match(bad.content[0].text, /DOC_NOT_FOUND/);

    const stock = await client.callTool({ name: 'accounting_stock', arguments: {} });
    assert.ok(!stock.isError, stock.content[0].text);
    const ap = await client.callTool({ name: 'autopilot_issues', arguments: {} });
    assert.match(ap.content[0].text, /Автопилот (включён|выключен)/);
    const trade = await client.callTool({ name: 'trade_search_documents', arguments: { docType: 'SUPPLY' } });
    assert.ok(!trade.isError, trade.content[0].text);

    const foreign = await client.callTool({ name: 'flowpos_switch_organization', arguments: { organizationId: 'чужая-организация' } });
    assert.ok(foreign.isError);
  } finally {
    await client.close();
  }
});
