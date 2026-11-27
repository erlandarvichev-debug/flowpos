// Новые инструменты (пульс, долги, прибыльность, деньги, справочники, черновик торгового документа, задачи,
// производство): реальный клиент ↔ сервер (stdio) ↔ API на :3000. Пропускается, если API недоступен.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const API = process.env.FLOWPOS_API_URL || 'http://localhost:3000';
const up = await fetch(`${API}/api/docs`).then((r) => r.ok).catch(() => false);

test('MCP: инструменты управления торговлей', { skip: !up && 'API FlowPOS не запущен' }, async () => {
  const transport = new StdioClientTransport({
    command: 'node', args: ['dist/index.js'],
    env: { ...process.env, FLOWPOS_API_URL: API, FLOWPOS_EMAIL: process.env.FLOWPOS_EMAIL || 'admin@flowpos.kz', FLOWPOS_PASSWORD: process.env.FLOWPOS_PASSWORD || 'admin123' },
  });
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(transport);
  const call = async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }); assert.ok(!r.isError, `${name}: ${r.content[0].text}`); return r.content[0].text; };
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of ['business_pulse', 'debt_aging', 'sales_profitability', 'money_flow', 'catalog_search', 'trade_create_draft', 'warehouses', 'tasks_list', 'task_create', 'production_overview']) assert.ok(names.includes(n), n);
    assert.ok(!names.some((n) => /post|storno|delete|sign|send/i.test(n)), 'нет инструментов проведения/подписания');

    assert.match(await call('business_pulse'), /Пульс бизнеса[\s\S]*Деньги: остаток[\s\S]*Выручка/);
    assert.match(await call('debt_aging', { side: 'customers' }), /Долги покупателей|долгов нет/);
    assert.match(await call('sales_profitability', { groupBy: 'counterparty', limit: 5 }), /Прибыльность/);
    assert.match(await call('money_flow'), /Движение денег/);
    assert.match(await call('production_overview'), /Техкарт:/);

    const wh = await call('warehouses');
    const storeId = /id ([0-9a-f-]{36})/.exec(wh)?.[1];
    const prod = await call('catalog_search', { kind: 'product', search: 'а', limit: 1 });
    const productId = /id ([0-9a-f-]{36})/.exec(prod)?.[1];
    const cp = await call('catalog_search', { kind: 'counterparty', search: 'а', limit: 1 });
    const counterpartyId = /id ([0-9a-f-]{36})/.exec(cp)?.[1];
    assert.ok(storeId && productId && counterpartyId, 'нашлись склад, товар, контрагент');
    const today = new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10);
    const draft = await call('trade_create_draft', { docType: 'CUSTOMER_ORDER', date: today, counterpartyId, storeId, comment: 'тест MCP', lines: [{ productId, qty: '1', price: '100' }] });
    assert.match(draft, /Создан черновик: Заказ покупателя ЗК-\d{4}-\d+ на 100/);

    const t = await call('task_create', { title: 'Тест MCP: позвонить клиенту', counterpartyId });
    assert.match(t, /Задача поставлена/);
    assert.match(await call('tasks_list', { scope: 'mine' }), /Тест MCP: позвонить клиенту/);
  } finally {
    await client.close();
  }
});
